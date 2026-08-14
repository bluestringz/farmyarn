const express = require('express');
const rateLimit = require('express-rate-limit');

const GLOBAL_CHAT_COST = 1; // coins per global message
const MAX_MESSAGE_LENGTH = 200;

const chatLimiter = rateLimit({
  windowMs: 10 * 1000,
  max: 8, // at most 8 messages per 10 seconds — cheap spam guard beyond the coin cost
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "You're sending messages too fast — slow down a bit." },
});

module.exports = function chatRoutes(db, io) {
  const router = express.Router();
  router.use(chatLimiter);

  function getFriendship(userA, userB) {
    return db.prepare(`
      SELECT 1 FROM friends
      WHERE status = 'accepted' AND (
        (requester_id = ? AND receiver_id = ?) OR (requester_id = ? AND receiver_id = ?)
      )
    `).get(userA, userB, userB, userA);
  }

  // GET /api/chat/global?limit=50 — recent global chat history (for page load / late joiners)
  router.get('/global', (req, res) => {
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 50);
    const rows = db.prepare(`
      SELECT cm.id, cm.message, cm.created_at, cm.is_announcement, u.id as fromUserId,
             COALESCE(u.display_name, u.username) as fromUsername
      FROM chat_messages cm JOIN users u ON u.id = cm.from_user_id
      WHERE cm.to_user_id IS NULL
      ORDER BY cm.created_at DESC, cm.id DESC
      LIMIT ?
    `).all(limit);
    // Announcements always display as "Announcement", not whichever admin
    // account happened to send them — matches the live socket payload's
    // fromUsername in server/routes/admin.js's /announce endpoint.
    res.json(rows.reverse().map((r) => ({
      ...r,
      fromUsername: r.is_announcement ? 'Announcement' : r.fromUsername,
      isAnnouncement: !!r.is_announcement,
    })));
  });

  // POST /api/chat/global { message } — costs 1 coin, broadcast to everyone connected
  router.post('/global', (req, res) => {
    const { message } = req.body || {};
    if (typeof message !== 'string' || !message.trim()) return res.status(400).json({ error: 'Message required' });
    const trimmed = message.trim().slice(0, MAX_MESSAGE_LENGTH);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
    if (user.coins < GLOBAL_CHAT_COST) return res.status(400).json({ error: `Global chat costs ${GLOBAL_CHAT_COST} coin` });

    db.prepare('UPDATE users SET coins = coins - ? WHERE id = ?').run(GLOBAL_CHAT_COST, req.userId);
    const info = db.prepare('INSERT INTO chat_messages (from_user_id, to_user_id, message) VALUES (?, NULL, ?)')
      .run(req.userId, trimmed);

    const payload = {
      id: info.lastInsertRowid,
      fromUserId: req.userId,
      fromUsername: user.display_name || user.username,
      message: trimmed,
      created_at: Math.floor(Date.now() / 1000),
    };
    if (io) io.emit('chat:global', payload);

    const updated = db.prepare('SELECT coins FROM users WHERE id = ?').get(req.userId);
    res.json({ ok: true, message: payload, coins: updated.coins });
  });

  // POST /api/chat/whisper { toUserId, message } — free, but only between friends
  router.post('/whisper', (req, res) => {
    const { toUserId, message } = req.body || {};
    const targetId = parseInt(toUserId, 10);
    if (typeof message !== 'string' || !message.trim()) return res.status(400).json({ error: 'Message required' });
    if (!targetId || targetId === req.userId) return res.status(400).json({ error: 'Invalid recipient' });

    if (!getFriendship(req.userId, targetId)) {
      return res.status(403).json({ error: 'You can only whisper to friends' });
    }
    const target = db.prepare('SELECT id, username, display_name FROM users WHERE id = ?').get(targetId);
    if (!target) return res.status(404).json({ error: 'Player not found' });

    const trimmed = message.trim().slice(0, MAX_MESSAGE_LENGTH);
    const me = db.prepare('SELECT username, display_name FROM users WHERE id = ?').get(req.userId);

    const info = db.prepare('INSERT INTO chat_messages (from_user_id, to_user_id, message) VALUES (?, ?, ?)')
      .run(req.userId, targetId, trimmed);

    const payload = {
      id: info.lastInsertRowid,
      fromUserId: req.userId,
      fromUsername: me.display_name || me.username,
      toUserId: targetId,
      toUsername: target.display_name || target.username,
      message: trimmed,
      created_at: Math.floor(Date.now() / 1000),
    };
    if (io) {
      io.to(`user:${targetId}`).emit('chat:whisper', payload);
      io.to(`user:${req.userId}`).emit('chat:whisper', payload); // echo to sender's other tabs
    }

    res.json({ ok: true, message: payload });
  });

  return router;
};
