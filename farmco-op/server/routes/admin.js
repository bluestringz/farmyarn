const express = require('express');
const { grantRewards, addInventory } = require('../lib/gameLogic');

module.exports = function adminRoutes(db) {
  const router = express.Router();

  router.get('/players', (req, res) => {
    const q = (req.query.q || '').toString().trim();
    const rows = q
      ? db.prepare('SELECT id, username, level, xp, coins, premium_currency, is_admin, is_banned, created_at, last_login FROM users WHERE username LIKE ? ORDER BY id DESC LIMIT 100').all(`%${q}%`)
      : db.prepare('SELECT id, username, level, xp, coins, premium_currency, is_admin, is_banned, created_at, last_login FROM users ORDER BY id DESC LIMIT 100').all();
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

  router.get('/stats', (req, res) => {
    const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    const totalFarms = db.prepare('SELECT COUNT(*) as c FROM farms').get().c;
    const totalCrops = db.prepare('SELECT COUNT(*) as c FROM crops').get().c;
    const activeToday = db.prepare(`SELECT COUNT(*) as c FROM users WHERE last_login > strftime('%s','now') - 86400`).get().c;
    res.json({ totalUsers, totalFarms, totalCrops, activeToday });
  });

  return router;
};
