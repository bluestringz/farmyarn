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
const { isMaintenanceMode } = require('./lib/maintenance');
const { ensureAllAdminsFriendedWithEveryone, friendAdminWithAllUsers } = require('./lib/adminFriends');

const db = getDb();

// Safety net (see server/lib/adminFriends.js) — covers any admin promoted
// directly in the database, or pre-existing data from before this feature
// existed. New registrations and admin promotions THROUGH the app (below)
// stay in sync on their own; this just catches everything else at boot.
ensureAllAdminsFriendedWithEveryone(db);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: process.env.CORS_ORIGIN || '*' } });
// userId -> Set of socket ids. Declared up here (not down by the rest of
// the Socket.IO wiring) so it exists in time to hand to the admin routes
// below, which need it for the online-status column/count.
const onlineUsers = new Map();

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '256kb' }));

// General API rate limit (auth routes have their own stricter limiter).
// Bumped up from 240/min — a player harvesting a big field rapidly can
// easily fire off several requests per action (harvest + refresh player +
// refresh farm), and the old ceiling was tight enough to trip during a
// normal fast-clicking session, not just abuse/bots.
app.use('/api/', rateLimit({ windowMs: 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false }));

// ---- Site-wide maintenance mode ----
// Toggled from the admin panel (see /api/admin/maintenance in
// routes/admin.js). While it's on, regular players are blocked at the API
// level (503) — but an ADMIN ACCOUNT is never blocked, whether they're
// hitting the admin panel's own routes or just logging into and playing
// the normal game client, so staff can keep checking the actual game
// while everyone else sees the maintenance notice. The static page itself
// (index.html) is never blocked — it always loads normally so the login
// form is reachable — the maintenance notice for regular players is shown
// client-side (see public/js/main.js) once their own API calls start
// coming back 503.
function requesterIsAdmin(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return false;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(payload.sub);
    return !!(user && user.is_admin);
  } catch (err) {
    return false;
  }
}

function isMaintenanceExempt(req) {
  if (req.path.startsWith('/api/admin')) return true; // admin panel's own API calls
  if (req.path === '/api/health') return true;
  if (req.path === '/api/bootstrap-admin') return true;
  if (req.path === '/api/maintenance-status') return true; // public, so the client can show a notice even when logged out
  if (req.path === '/admin.html') return true; // the admin panel page itself
  // Shared static assets, and the app shell itself — always reachable so
  // an admin (or anyone) can always get to the login screen; regular play
  // is actually gated by the API responses below, not by this page load.
  if (req.path.startsWith('/css/') || req.path.startsWith('/js/') || req.path.startsWith('/assets/')) return true;
  if (req.method === 'GET' && !req.path.startsWith('/api/')) return true;
  if (req.path === '/api/auth/login') {
    // /api/auth/login is shared by both the game client and the admin
    // panel (see routes/auth.js, which reads body.context) — the
    // admin-panel-flavored login is always exempt, and so is a GAME login
    // for an account that's actually an admin (looked up by username,
    // since there's no token yet to check at this point). A regular
    // player's login still 503s.
    if (req.body && req.body.context === 'admin') return true;
    const username = req.body && req.body.username;
    if (typeof username === 'string') {
      const row = db.prepare('SELECT is_admin FROM users WHERE username = ?').get(username);
      if (row && row.is_admin) return true;
    }
    return false;
  }
  // Any other request carrying a valid admin's auth token bypasses the
  // block entirely — this is what lets an admin keep playing/checking the
  // game like normal while regular players get 503s on the same routes.
  if (requesterIsAdmin(req)) return true;
  return false;
}

app.get('/api/maintenance-status', (req, res) => {
  res.json({ enabled: isMaintenanceMode(db) });
});

app.use((req, res, next) => {
  if (!isMaintenanceMode(db) || isMaintenanceExempt(req)) return next();
  return res.status(503).json({ error: 'FarmYARN is under maintenance right now. Please try again in a bit.', maintenance: true });
});

// ---- Routes ----
app.use('/api/auth', require('./routes/auth')(db, io, onlineUsers));

const auth = requireAuth(db);
app.use('/api/farm', auth, require('./routes/farm')(db, io));
app.use('/api/shop', auth, require('./routes/shop')(db));
app.use('/api/marketplace', auth, require('./routes/marketplace')(db));
app.use('/api/friends', auth, require('./routes/friends')(db, io));
app.use('/api/player', auth, require('./routes/player')(db));
app.use('/api/chat', auth, require('./routes/chat')(db, io));
app.use('/api/admin', auth, requireAdmin, require('./routes/admin')(db, onlineUsers, io));
app.use('/api/casino', auth, require('./routes/casino')(db));

app.get('/api/health', (req, res) => res.json({ ok: true, time: Date.now() }));

// One-time admin bootstrap, reachable from a plain browser URL — for
// deployments (like Railway) where there's no easy terminal access to run
// `npm run make-admin` locally. Does nothing unless ADMIN_BOOTSTRAP_KEY is
// set in the environment, and only promotes the exact username given when
// the key in the URL matches it, so it's safe to leave in place even after
// you're done using it (an attacker without the key can't do anything here).
app.get('/api/bootstrap-admin', (req, res) => {
  const configuredKey = process.env.ADMIN_BOOTSTRAP_KEY;
  if (!configuredKey) return res.status(404).json({ error: 'Not enabled' });
  if (req.query.key !== configuredKey) return res.status(403).json({ error: 'Wrong key' });
  const username = (req.query.username || '').toString().trim();
  if (!username) return res.status(400).json({ error: 'Add ?username=yourname to the URL' });
  const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!user) return res.status(404).json({ error: `No account found with username "${username}"` });
  db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(user.id);
  friendAdminWithAllUsers(db, user.id);
  res.send(`✅ "${username}" is now an admin. Log out and back in, then visit /admin.html`);
});

// ---- Static frontend ----
// Serving /uploads separately (before the general public/ static mount)
// means avatar files can live on a persistent volume outside the app's own
// folder (see UPLOADS_DIR / player.js) without breaking the /uploads/...
// URLs the client already uses — falls back to public/uploads for plain
// local development where UPLOADS_DIR isn't set.
const uploadsDir = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'public', 'uploads');
app.use('/uploads', express.static(uploadsDir));
// No-cache on the app's own HTML/CSS/JS — express.static's defaults leave
// enough caching wiggle room that some browsers (especially on mobile)
// kept serving an old cached copy of index.html/main.js after a fresh
// deploy, which looked exactly like "the new feature isn't there" even
// though the server had the updated file the whole time. Uploaded avatars
// (above) don't need this — those are genuinely fine to cache long-term.
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'),
}));
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
// (onlineUsers itself is declared up near the top of the file — see there.)

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('unauthorized'));
    const payload = jwt.verify(token, JWT_SECRET);
    // Same reasoning as requireAuth in middleware/auth.js — a banned,
    // suspended, or deleted account shouldn't keep a live socket
    // connection open just because their token hasn't expired yet.
    const user = db.prepare('SELECT is_banned, suspended_until FROM users WHERE id = ?').get(payload.sub);
    if (!user) return next(new Error('unauthorized'));
    if (user.is_banned) return next(new Error('unauthorized'));
    if (user.suspended_until && user.suspended_until > Math.floor(Date.now() / 1000)) return next(new Error('unauthorized'));
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

// ---- Casino machine locks: "1 player at a time per machine" ----
// Purely in-memory/ephemeral (resets on server restart, same as
// spaceOccupants above) — there's nothing here worth persisting to the
// database, it's just "is anyone standing at this specific machine right
// now". machineId -> { userId, username, socketId, space }. `space` is
// whichever casino floor room the lock was taken in (e.g. 'casino:2'),
// so a release only needs to broadcast to players who could actually see
// that machine.
const casinoMachineLocks = new Map();

// Releases every lock this socket currently holds (called on disconnect
// and on leaving any space — a player walking off a machine's floor, or
// changing floors, shouldn't leave it stuck "in use" forever for everyone
// else).
function releaseCasinoLocksFor(socket) {
  for (const [machineId, lock] of casinoMachineLocks.entries()) {
    if (lock.socketId === socket.id) {
      casinoMachineLocks.delete(machineId);
      io.to(lock.space).emit('casino:machine-unlocked', { machineId });
    }
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
    // Freshly fetched from the DB (not the JWT, which only has the raw
    // username baked in at login and can go stale if the player changes
    // their display name mid-session) — this is what actually gets
    // shown above another player's head in-game (see the username tag
    // in game.js), so it should reflect whatever they've currently set
    // it to, not their account username.
    const userRow = db.prepare('SELECT display_name FROM users WHERE id = ?').get(uid);
    const displayName = (userRow && userRow.display_name) || socket.username;
    const info = { userId: uid, username: socket.username, displayName, x: x || 0, y: y || 0, appearance: appearance || null };
    spaceOccupants.get(space).set(uid, info);

    // tell the newly-joined player who's already here, and tell everyone else about them
    socket.emit('presence:roster', { space, occupants: occupantList(space).filter((o) => o.userId !== uid) });
    socket.to(space).emit('presence:joined', info);

    // If this is a Casino floor, also hand the newly-joined player a
    // snapshot of whichever machines on THIS floor are already locked by
    // someone else — same "catch the new arrival up on current state"
    // idea as presence:roster above, just for machine occupancy instead
    // of player positions.
    if (space.startsWith('casino:')) {
      const locks = [];
      for (const [machineId, lock] of casinoMachineLocks.entries()) {
        if (lock.space === space) locks.push({ machineId, username: lock.username });
      }
      socket.emit('casino:locks-snapshot', { locks });
    }
  });

  socket.on('space:move', ({ space, x, y }) => {
    if (!space || space !== socket.currentSpace) return;
    const map = spaceOccupants.get(space);
    if (!map || !map.has(uid)) return;
    const info = map.get(uid);
    info.x = x; info.y = y;
    socket.to(space).emit('presence:move', { userId: uid, x, y });
  });

  // Broadcasts sitting/lying so anyone else sharing the same space (a
  // visitor in the same house, or someone else in the Park) actually sees
  // it happen instead of just seeing the player standing still — restPose
  // is null when getting up.
  socket.on('space:rest', ({ space, restPose, x, y, facingDir }) => {
    if (!space || space !== socket.currentSpace) return;
    const map = spaceOccupants.get(space);
    if (!map || !map.has(uid)) return;
    const info = map.get(uid);
    info.restPose = restPose || null;
    if (x !== undefined) info.x = x;
    if (y !== undefined) info.y = y;
    if (facingDir !== undefined) info.facingDir = facingDir;
    socket.to(space).emit('presence:rest', { userId: uid, restPose, x, y, facingDir });
  });

  // Broadcasts a live appearance change (new costume equipped, new dye)
  // to anyone else already sharing this space — previously appearance was
  // only ever sent once, at space:join time, so changing costume while
  // already standing in a shared space never reached anyone already
  // there. Also updates the stored occupant record so anyone who joins
  // AFTER this point (a fresh space:join) still gets the current look,
  // not the stale one from whenever this player first walked in.
  socket.on('space:appearance', ({ space, appearance }) => {
    if (!space || space !== socket.currentSpace || !appearance) return;
    const map = spaceOccupants.get(space);
    if (!map || !map.has(uid)) return;
    map.get(uid).appearance = appearance;
    socket.to(space).emit('presence:appearance', { userId: uid, appearance });
  });

  socket.on('space:leave', ({ space }) => {
    leaveSpace(socket, space);
    socket.currentSpace = null;
    releaseCasinoLocksFor(socket);
  });

  // "Claim" a specific casino machine before opening its bet panel, so
  // only one player can be actively betting on any one physical machine
  // at a time — everyone else sees it as occupied and picks a different
  // one of the 15 copies instead of queueing behind a single machine.
  // ack({ok:true}) to claim successfully; ack({ok:false, username}) if
  // someone else already has it (or it's already this same player's own
  // lock, which also counts as success — reopening the same machine's
  // panel shouldn't fail).
  socket.on('casino:lock', ({ machineId }, ack) => {
    if (typeof ack !== 'function') return;
    if (!machineId || !socket.currentSpace || !socket.currentSpace.startsWith('casino:')) {
      return ack({ ok: false });
    }
    const existing = casinoMachineLocks.get(machineId);
    if (existing && existing.userId !== uid) {
      return ack({ ok: false, username: existing.username });
    }
    casinoMachineLocks.set(machineId, { userId: uid, username: socket.username, socketId: socket.id, space: socket.currentSpace });
    socket.to(socket.currentSpace).emit('casino:machine-locked', { machineId, username: socket.username });
    ack({ ok: true });
  });

  // Releases a machine this player currently holds — called when they
  // close the bet panel, change floors, or leave the Casino. A no-op if
  // they don't actually hold it (already released, or never had it).
  socket.on('casino:unlock', ({ machineId }) => {
    const existing = casinoMachineLocks.get(machineId);
    if (existing && existing.socketId === socket.id) {
      casinoMachineLocks.delete(machineId);
      socket.to(existing.space).emit('casino:machine-unlocked', { machineId });
    }
  });

  socket.on('disconnect', () => {
    if (socket.currentSpace) leaveSpace(socket, socket.currentSpace);
    releaseCasinoLocksFor(socket);

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

app.get('/api/presence/:userId', auth, (req, res) => {
  res.json({ online: onlineUsers.has(parseInt(req.params.userId, 10)) });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Farm co-op server listening on port ${PORT}`);
});

module.exports = { app, server, io };
