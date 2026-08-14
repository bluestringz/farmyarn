const express = require('express');
const { grantRewards, addInventory } = require('../lib/gameLogic');

module.exports = function adminRoutes(db, onlineUsers) {
  const router = express.Router();

  router.get('/players', (req, res) => {
    const q = (req.query.q || '').toString().trim();
    const cols = 'id, username, level, xp, coins, premium_currency, is_admin, is_banned, suspended_until, created_at, last_login';
    const rows = q
      ? db.prepare(`SELECT ${cols} FROM users WHERE username LIKE ? ORDER BY id DESC LIMIT 100`).all(`%${q}%`)
      : db.prepare(`SELECT ${cols} FROM users ORDER BY id DESC LIMIT 100`).all();
    // onlineUsers is a live userId -> Set(socketId) map kept by the
    // Socket.IO connection handling in index.js — a user is "online" here
    // exactly when they have at least one open connection.
    rows.forEach((r) => { r.online = onlineUsers.has(r.id); });
    res.json(rows);
  });

  router.get('/players/:id/farm', (req, res) => {
    const farm = db.prepare('SELECT * FROM farms WHERE owner_id = ?').get(req.params.id);
    if (!farm) return res.status(404).json({ error: 'Farm not found' });
    const crops = db.prepare('SELECT * FROM crops WHERE farm_id = ?').all(farm.id);
    const objects = db.prepare('SELECT * FROM farm_objects WHERE farm_id = ?').all(farm.id);
    res.json({ farm, crops, objects });
  });

  router.post('/players/:id/adjust', (req, res) => {
    const { coins = 0, xp = 0 } = req.body || {};
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const result = grantRewards(db, user.id, { coins, xp });
    res.json({ ok: true, result });
  });

  // POST /api/admin/players/:id/set-coins { coins } — sets the EXACT coin
  // balance (unlike /adjust, which only adds/subtracts a delta).
  router.post('/players/:id/set-coins', (req, res) => {
    const coins = parseInt(req.body && req.body.coins, 10);
    if (!Number.isFinite(coins) || coins < 0) return res.status(400).json({ error: 'coins must be a non-negative number' });
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    db.prepare('UPDATE users SET coins = ? WHERE id = ?').run(coins, user.id);
    res.json({ ok: true, coins });
  });

  // POST /api/admin/players/:id/give-premium { amount } — top up a
  // player's Premium Points, the currency costumes are bought with.
  router.post('/players/:id/give-premium', (req, res) => {
    const amount = parseInt(req.body && req.body.amount, 10);
    if (!Number.isFinite(amount) || amount === 0) return res.status(400).json({ error: 'amount must be a non-zero number' });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const newBalance = Math.max(0, (user.premium_currency || 0) + amount);
    db.prepare('UPDATE users SET premium_currency = ? WHERE id = ?').run(newBalance, user.id);
    res.json({ ok: true, premiumCurrency: newBalance });
  });

  router.post('/players/:id/give-item', (req, res) => {
    const { itemId, quantity } = req.body || {};
    if (!itemId || !quantity) return res.status(400).json({ error: 'itemId and quantity required' });
    addInventory(db, req.params.id, itemId, quantity);
    res.json({ ok: true });
  });

  router.post('/players/:id/ban', (req, res) => {
    const { banned } = req.body || {};
    db.prepare('UPDATE users SET is_banned = ? WHERE id = ?').run(banned ? 1 : 0, req.params.id);
    res.json({ ok: true });
  });

  // POST /api/admin/players/:id/suspend { days } — temporary block, unlike
  // ban which is permanent. days=0 (or omitted) lifts an existing suspension.
  router.post('/players/:id/suspend', (req, res) => {
    const days = parseFloat(req.body && req.body.days);
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!days || days <= 0) {
      db.prepare('UPDATE users SET suspended_until = NULL WHERE id = ?').run(user.id);
      return res.json({ ok: true, suspendedUntil: null });
    }
    const until = Math.floor(Date.now() / 1000) + Math.round(days * 86400);
    db.prepare('UPDATE users SET suspended_until = ? WHERE id = ?').run(until, user.id);
    res.json({ ok: true, suspendedUntil: until });
  });

  // DELETE /api/admin/players/:id — permanently removes the account.
  // Foreign keys are declared ON DELETE CASCADE (and PRAGMA foreign_keys
  // is ON — see db/migrate.js), so this alone cleans up the farm, crops,
  // farm_objects, inventory, owned_outfits, friends, notifications, and
  // chat messages tied to this account. A rented marketplace stall just
  // goes vacant again (ON DELETE SET NULL) instead of being deleted.
  router.delete('/players/:id', (req, res) => {
    const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (req.userId === user.id) return res.status(400).json({ error: "You can't delete your own account from here" });
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    res.json({ ok: true, deleted: user.username });
  });

  router.get('/stats', (req, res) => {
    const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    const totalFarms = db.prepare('SELECT COUNT(*) as c FROM farms').get().c;
    const totalCrops = db.prepare('SELECT COUNT(*) as c FROM crops').get().c;
    const activeToday = db.prepare(`SELECT COUNT(*) as c FROM users WHERE last_login > strftime('%s','now') - 86400`).get().c;
    const onlineNow = onlineUsers.size;
    res.json({ totalUsers, totalFarms, totalCrops, activeToday, onlineNow });
  });

  return router;
};
