const express = require('express');
const { notify } = require('../lib/gameLogic');

module.exports = function friendsRoutes(db, io) {
  const router = express.Router();

  // GET /api/friends/search?q=username
  router.get('/search', (req, res) => {
    const q = (req.query.q || '').toString().trim();
    if (q.length < 2) return res.json([]);
    const rows = db.prepare(`
      SELECT id, username, level, avatar FROM users
      WHERE username LIKE ? AND id != ? AND is_banned = 0
      LIMIT 20
    `).all(`%${q}%`, req.userId);
    res.json(rows);
  });

  // GET /api/friends - list accepted friends + pending requests
  router.get('/', (req, res) => {
    const accepted = db.prepare(`
      SELECT u.id, u.username, u.level, u.avatar, f.created_at
      FROM friends f
      JOIN users u ON u.id = (CASE WHEN f.requester_id = ? THEN f.receiver_id ELSE f.requester_id END)
      WHERE f.status = 'accepted' AND (f.requester_id = ? OR f.receiver_id = ?)
    `).all(req.userId, req.userId, req.userId);

    const incoming = db.prepare(`
      SELECT f.id as request_id, u.id, u.username, u.level, u.avatar
      FROM friends f JOIN users u ON u.id = f.requester_id
      WHERE f.receiver_id = ? AND f.status = 'pending'
    `).all(req.userId);

    const outgoing = db.prepare(`
      SELECT f.id as request_id, u.id, u.username, u.level, u.avatar
      FROM friends f JOIN users u ON u.id = f.receiver_id
      WHERE f.requester_id = ? AND f.status = 'pending'
    `).all(req.userId);

    res.json({ friends: accepted, incomingRequests: incoming, outgoingRequests: outgoing });
  });

  // POST /api/friends/request { userId }
  router.post('/request', (req, res) => {
    const targetId = parseInt(req.body?.userId, 10);
    if (!targetId || targetId === req.userId) return res.status(400).json({ error: 'Invalid target user' });
    const target = db.prepare('SELECT id, username FROM users WHERE id = ?').get(targetId);
    if (!target) return res.status(404).json({ error: 'User not found' });

    const existing = db.prepare(`
      SELECT * FROM friends WHERE (requester_id = ? AND receiver_id = ?) OR (requester_id = ? AND receiver_id = ?)
    `).get(req.userId, targetId, targetId, req.userId);
    if (existing) return res.status(400).json({ error: 'A friend request already exists between you' });

    db.prepare(`INSERT INTO friends (requester_id, receiver_id, status) VALUES (?, ?, 'pending')`)
      .run(req.userId, targetId);

    const me = db.prepare('SELECT username FROM users WHERE id = ?').get(req.userId);
    notify(db, targetId, 'friend_request', `${me.username} sent you a friend request.`);
    if (io) io.to(`user:${targetId}`).emit('notification', { message: `${me.username} sent you a friend request.` });

    res.json({ ok: true });
  });

  // POST /api/friends/respond { requestId, accept: true|false }
  router.post('/respond', (req, res) => {
    const { requestId, accept } = req.body || {};
    const request = db.prepare('SELECT * FROM friends WHERE id = ? AND receiver_id = ? AND status = ?')
      .get(requestId, req.userId, 'pending');
    if (!request) return res.status(404).json({ error: 'Request not found' });

    if (accept) {
      db.prepare(`UPDATE friends SET status = 'accepted' WHERE id = ?`).run(requestId);
      const me = db.prepare('SELECT username FROM users WHERE id = ?').get(req.userId);
      notify(db, request.requester_id, 'friend_accept', `${me.username} accepted your friend request.`);
    } else {
      db.prepare('DELETE FROM friends WHERE id = ?').run(requestId);
    }
    res.json({ ok: true });
  });

  // DELETE /api/friends/:friendUserId
  router.delete('/:friendUserId', (req, res) => {
    const otherId = parseInt(req.params.friendUserId, 10);
    db.prepare(`
      DELETE FROM friends WHERE
      (requester_id = ? AND receiver_id = ?) OR (requester_id = ? AND receiver_id = ?)
    `).run(req.userId, otherId, otherId, req.userId);
    res.json({ ok: true });
  });

  return router;
};
