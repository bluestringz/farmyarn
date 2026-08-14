require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

const { getDb } = require('./db/migrate');
const { requireAuth, requireAdmin, JWT_SECRET } = require('./middleware/auth');

const db = getDb();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: process.env.CORS_ORIGIN || '*' } });

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '256kb' }));

// General API rate limit (auth routes have their own stricter limiter).
// Bumped up from 240/min — a player harvesting a big field rapidly can
// easily fire off several requests per action (harvest + refresh player +
// refresh farm), and the old ceiling was tight enough to trip during a
// normal fast-clicking session, not just abuse/bots.
app.use('/api/', rateLimit({ windowMs: 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false }));

// ---- Routes ----
app.use('/api/auth', require('./routes/auth')(db));

app.use('/api/farm', requireAuth, require('./routes/farm')(db, io));
app.use('/api/shop', requireAuth, require('./routes/shop')(db));
app.use('/api/marketplace', requireAuth, require('./routes/marketplace')(db));
app.use('/api/friends', requireAuth, require('./routes/friends')(db, io));
app.use('/api/player', requireAuth, require('./routes/player')(db));
app.use('/api/chat', requireAuth, require('./routes/chat')(db, io));
app.use('/api/admin', requireAuth, requireAdmin, require('./routes/admin')(db));

app.get('/api/health', (req, res) => res.json({ ok: true, time: Date.now() }));

// ---- Static frontend ----
// Serving /uploads separately (before the general public/ static mount)
// means avatar files can live on a persistent volume outside the app's own
// folder (see UPLOADS_DIR / player.js) without breaking the /uploads/...
// URLs the client already uses — falls back to public/uploads for plain
// local development where UPLOADS_DIR isn't set.
const uploadsDir = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'public', 'uploads');
app.use('/uploads', express.static(uploadsDir));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ---- Error handler ----
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// ---- Socket.IO: online presence + real-time notifications ----
// Clients connect with { auth: { token } }; we join a per-user room so we can push
// targeted events (help notifications, friend requests) without polling.
const onlineUsers = new Map(); // userId -> Set of socket ids

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('unauthorized'));
    const payload = jwt.verify(token, JWT_SECRET);
    socket.userId = payload.sub;
    socket.username = payload.username;
    next();
  } catch (err) {
    next(new Error('unauthorized'));
  }
});

// ---- Shared "spaces" (farm visits + the Marketplace plaza): lets players who
// are looking at the same place see each other's avatar move around live,
// instead of everyone only ever seeing their own character. A space id is
// either `farm:<ownerId>` (the owner is always considered "present" on their
// own farm; visitors join the same space id) or `market` (the shared plaza).
const spaceOccupants = new Map(); // spaceId -> Map<userId, occupantInfo>

function occupantList(spaceId) {
  const map = spaceOccupants.get(spaceId);
  return map ? Array.from(map.values()) : [];
}

function leaveSpace(socket, spaceId) {
  if (!spaceId) return;
  const map = spaceOccupants.get(spaceId);
  if (map && map.has(socket.userId)) {
    map.delete(socket.userId);
    if (map.size === 0) spaceOccupants.delete(spaceId);
    socket.leave(spaceId);
    socket.to(spaceId).emit('presence:left', { userId: socket.userId });
  }
}

io.on('connection', (socket) => {
  const uid = socket.userId;
  socket.join(`user:${uid}`);
  if (!onlineUsers.has(uid)) onlineUsers.set(uid, new Set());
  onlineUsers.get(uid).add(socket.id);
  io.emit('presence', { userId: uid, online: true });

  socket.on('space:join', ({ space, x, y, appearance }) => {
    if (!space || typeof space !== 'string') return;
    if (socket.currentSpace && socket.currentSpace !== space) leaveSpace(socket, socket.currentSpace);

    socket.join(space);
    socket.currentSpace = space;
    if (!spaceOccupants.has(space)) spaceOccupants.set(space, new Map());
    const info = { userId: uid, username: socket.username, x: x || 0, y: y || 0, appearance: appearance || null };
    spaceOccupants.get(space).set(uid, info);

    // tell the newly-joined player who's already here, and tell everyone else about them
    socket.emit('presence:roster', { space, occupants: occupantList(space).filter((o) => o.userId !== uid) });
    socket.to(space).emit('presence:joined', info);
  });

  socket.on('space:move', ({ space, x, y }) => {
    if (!space || space !== socket.currentSpace) return;
    const map = spaceOccupants.get(space);
    if (!map || !map.has(uid)) return;
    const info = map.get(uid);
    info.x = x; info.y = y;
    socket.to(space).emit('presence:move', { userId: uid, x, y });
  });

  socket.on('space:leave', ({ space }) => {
    leaveSpace(socket, space);
    socket.currentSpace = null;
  });

  socket.on('disconnect', () => {
    if (socket.currentSpace) leaveSpace(socket, socket.currentSpace);

    const set = onlineUsers.get(uid);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) {
        onlineUsers.delete(uid);
        io.emit('presence', { userId: uid, online: false });
      }
    }
  });
});

app.get('/api/presence/:userId', requireAuth, (req, res) => {
  res.json({ online: onlineUsers.has(parseInt(req.params.userId, 10)) });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Farm co-op server listening on port ${PORT}`);
});

module.exports = { app, server, io };
