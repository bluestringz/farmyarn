const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { grantRewards, addInventory, nowSec, xpForLevel, MAX_ENERGY } = require('../lib/gameLogic');
const { DB_PATH } = require('../db/migrate');

module.exports = function adminRoutes(db, onlineUsers) {
  const router = express.Router();

  // GET /api/admin/backup — downloads a full, consistent snapshot of the
  // live database as a .db file. Uses better-sqlite3's built-in backup()
  // (not just copying the raw file), which is safe to run while the
  // server keeps reading/writing — it won't hand back a half-written or
  // corrupted copy the way a naive file copy could.
  router.get('/backup', async (req, res) => {
    const tmpPath = path.join(os.tmpdir(), `farmyarn-backup-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    try {
      await db.backup(tmpPath);
      const dateStamp = new Date().toISOString().slice(0, 10);
      res.download(tmpPath, `farmyarn-backup-${dateStamp}.db`, (err) => {
        fs.unlink(tmpPath, () => {}); // clean up the temp copy either way
      });
    } catch (err) {
      fs.unlink(tmpPath, () => {});
      res.status(500).json({ error: 'Backup failed: ' + err.message });
    }
  });

  const restoreUpload = multer({ dest: os.tmpdir(), limits: { fileSize: 200 * 1024 * 1024 } });

  // POST /api/admin/restore — upload a .db backup file to restore from.
  // Doesn't touch the live database immediately (a connection is open on
  // it right now, and swapping the file out from under that is how you
  // get corruption) — instead it's staged as a "pending restore" that
  // getDb() picks up and swaps in the next time the server starts, which
  // is the only moment it's fully safe to do. You still need to restart
  // the service (e.g. via Railway's dashboard) afterward for it to apply.
  router.post('/restore', (req, res) => {
    restoreUpload.single('backup')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      // Quick sanity check: every real SQLite file starts with this exact
      // 16-byte header — catches "wrong file" mistakes before they ever
      // reach the pending-restore slot.
      const header = Buffer.alloc(16);
      const fd = fs.openSync(req.file.path, 'r');
      fs.readSync(fd, header, 0, 16, 0);
      fs.closeSync(fd);
      if (header.toString('utf8', 0, 15) !== 'SQLite format 3') {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: "That doesn't look like a valid SQLite backup file." });
      }

      const pendingPath = DB_PATH + '.restore-pending';
      fs.copyFileSync(req.file.path, pendingPath);
      fs.unlink(req.file.path, () => {});
      res.json({ ok: true, message: 'Backup staged — restart the server for it to take effect.' });
    });
  });

  router.get('/players', (req, res) => {
    const q = (req.query.q || '').toString().trim();
    const cols = 'id, username, level, xp, energy, coins, premium_currency, is_admin, is_banned, suspended_until, created_at, last_login';
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

  // POST /api/admin/players/:id/set-energy { energy } — sets the EXACT
  // energy value, capped at MAX_ENERGY.
  router.post('/players/:id/set-energy', (req, res) => {
    const energy = parseInt(req.body && req.body.energy, 10);
    if (!Number.isFinite(energy) || energy < 0) return res.status(400).json({ error: 'energy must be a non-negative number' });
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const capped = Math.min(MAX_ENERGY, energy);
    db.prepare('UPDATE users SET energy = ?, energy_updated_at = ? WHERE id = ?').run(capped, nowSec(), user.id);
    res.json({ ok: true, energy: capped });
  });

  // POST /api/admin/players/:id/set-level { level } — level IS also a
  // stored column (kept in sync with xp by grantRewards() during normal
  // play — see gameLogic.js), so setting it here has to update both: XP to
  // that level's floor, and the level column itself, or the two would
  // disagree until the player's next XP-earning action re-synced it.
  router.post('/players/:id/set-level', (req, res) => {
    const level = parseInt(req.body && req.body.level, 10);
    if (!Number.isFinite(level) || level < 1) return res.status(400).json({ error: 'level must be 1 or higher' });
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const xp = xpForLevel(level);
    db.prepare('UPDATE users SET xp = ?, level = ? WHERE id = ?').run(xp, level, user.id);
    res.json({ ok: true, level, xp });
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
    const pendingPasswordRequests = db.prepare(`SELECT COUNT(*) as c FROM password_reset_requests WHERE status = 'pending'`).get().c;
    res.json({ totalUsers, totalFarms, totalCrops, activeToday, onlineNow, pendingPasswordRequests });
  });

  // GET /api/admin/password-requests — the "mailbox": pending (and a few
  // recent resolved) password-reset requests, newest first.
  router.get('/password-requests', (req, res) => {
    const rows = db.prepare(`
      SELECT prr.id, prr.message, prr.status, prr.created_at, prr.resolved_at,
             u.id AS userId, u.username
      FROM password_reset_requests prr
      JOIN users u ON u.id = prr.user_id
      ORDER BY (prr.status = 'pending') DESC, prr.created_at DESC
      LIMIT 100
    `).all();
    res.json(rows);
  });

  // POST /api/admin/password-requests/:id/resolve { newPassword } — sets
  // the requesting player's password and marks the request handled.
  router.post('/password-requests/:id/resolve', async (req, res) => {
    const request = db.prepare('SELECT * FROM password_reset_requests WHERE id = ?').get(req.params.id);
    if (!request) return res.status(404).json({ error: 'Request not found' });
    const newPassword = (req.body && req.body.newPassword || '').toString();
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

    const newHash = await bcrypt.hash(newPassword, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, request.user_id);
    db.prepare(`UPDATE password_reset_requests SET status = 'resolved', resolved_at = ? WHERE id = ?`)
      .run(nowSec(), request.id);
    res.json({ ok: true });
  });

  // POST /api/admin/password-requests/:id/dismiss — mark handled without
  // changing the password (e.g. it was spam, or handled another way).
  router.post('/password-requests/:id/dismiss', (req, res) => {
    const info = db.prepare(`UPDATE password_reset_requests SET status = 'resolved', resolved_at = ? WHERE id = ?`)
      .run(nowSec(), req.params.id);
    if (info.changes === 0) return res.status(404).json({ error: 'Request not found' });
    res.json({ ok: true });
  });

  return router;
};
