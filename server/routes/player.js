const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { grantRewards, resolveEnergy, nowSec, xpProgress } = require('../lib/gameLogic');
const { publicUser } = require('./auth');

const DAILY_REWARDS = [
  { day: 1, coins: 100 },
  { day: 2, coins: 150 },
  { day: 3, coins: 200 },
  { day: 4, coins: 0, item: 'seed_pack' },
  { day: 5, coins: 0, item: 'decoration_pack' },
  { day: 6, coins: 0, xp: 20 },
  { day: 7, coins: 500, special: true },
];

module.exports = function playerRoutes(db) {
  const router = express.Router();

  // ---- PROFILE PICTURE UPLOAD ----
  // Configurable so a deployment can point this at a persistent volume
  // (e.g. Fly.io) instead of the app's own folder, which gets wiped on
  // every redeploy on most free hosts. Falls back to the local public/
  // folder for plain `npm start` development.
  const AVATAR_DIR = process.env.UPLOADS_DIR
    ? path.join(process.env.UPLOADS_DIR, 'avatars')
    : path.join(__dirname, '..', '..', 'public', 'uploads', 'avatars');
  fs.mkdirSync(AVATAR_DIR, { recursive: true });
  const avatarUpload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, AVATAR_DIR),
      filename: (req, file, cb) => {
        const ext = (path.extname(file.originalname) || '.jpg').toLowerCase();
        cb(null, `${req.userId}_${Date.now()}${ext}`);
      },
    }),
    limits: { fileSize: 3 * 1024 * 1024 }, // 3MB
    fileFilter: (req, file, cb) => {
      const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype);
      cb(ok ? null : new Error('Only JPG, PNG, WEBP, or GIF images are allowed'), ok);
    },
  });

  router.post('/avatar', (req, res) => {
    avatarUpload.single('avatar')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      // Clean up the previous uploaded avatar file (if any) so these don't
      // pile up forever — only touches files under our own uploads dir.
      const old = db.prepare('SELECT avatar FROM users WHERE id = ?').get(req.userId);
      if (old && old.avatar && old.avatar.startsWith('/uploads/avatars/')) {
        const oldPath = path.join(__dirname, '..', '..', 'public', old.avatar);
        fs.unlink(oldPath, () => {}); // best-effort, ignore errors
      }

      const avatarUrl = `/uploads/avatars/${req.file.filename}`;
      db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatarUrl, req.userId);
      res.json({ ok: true, avatar: avatarUrl });
    });
  });

  router.get('/me', (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    resolveEnergy(db, req.userId);
    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
    res.json({ ...publicUser(fresh), xpProgress: xpProgress(fresh.xp) });
  });

  // GET /api/player/outfits - every outfit, flagged with whether this player owns it
  router.get('/outfits', (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
    const all = db.prepare('SELECT * FROM outfit_types ORDER BY required_level, cost').all();
    const owned = new Set(
      db.prepare('SELECT outfit_id FROM owned_outfits WHERE user_id = ?').all(req.userId).map((r) => r.outfit_id)
    );
    res.json(all.map((o) => ({ ...o, owned: owned.has(o.id), equipped: o.id === user.equipped_outfit })));
  });

  // POST /api/player/equip-outfit  { outfitId } - switch to an already-owned outfit, free
  router.post('/equip-outfit', (req, res) => {
    const { outfitId } = req.body || {};
    const owned = db.prepare('SELECT 1 FROM owned_outfits WHERE user_id = ? AND outfit_id = ?').get(req.userId, outfitId);
    if (!owned) return res.status(400).json({ error: "You don't own that outfit yet" });
    db.prepare('UPDATE users SET equipped_outfit = ? WHERE id = ?').run(outfitId, req.userId);
    res.json({ ok: true, outfitId });
  });

  router.get('/inventory', (req, res) => {
    const rows = db.prepare('SELECT item_id, quantity FROM inventory WHERE user_id = ? AND quantity > 0').all(req.userId);
    res.json(rows);
  });

  router.get('/notifications', (req, res) => {
    const rows = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(req.userId);
    res.json(rows);
  });

  router.post('/notifications/read', (req, res) => {
    const { notificationId } = req.body || {};
    if (notificationId) {
      db.prepare('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?').run(notificationId, req.userId);
    } else {
      db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(req.userId);
    }
    res.json({ ok: true });
  });

  // GET /api/player/daily-reward/status
  router.get('/daily-reward/status', (req, res) => {
    const today = todayStr();
    const claimedToday = db.prepare('SELECT * FROM daily_rewards_claimed WHERE user_id = ? AND claimed_date = ?')
      .get(req.userId, today);
    const lastClaim = db.prepare('SELECT * FROM daily_rewards_claimed WHERE user_id = ? ORDER BY claimed_date DESC LIMIT 1')
      .get(req.userId);
    const nextStreakDay = computeNextStreakDay(lastClaim, today);
    res.json({
      claimedToday: !!claimedToday,
      nextStreakDay,
      reward: DAILY_REWARDS[(nextStreakDay - 1) % DAILY_REWARDS.length],
    });
  });

  // POST /api/player/daily-reward/claim
  router.post('/daily-reward/claim', (req, res) => {
    const today = todayStr();
    const already = db.prepare('SELECT * FROM daily_rewards_claimed WHERE user_id = ? AND claimed_date = ?')
      .get(req.userId, today);
    if (already) return res.status(400).json({ error: 'Already claimed today' });

    const lastClaim = db.prepare('SELECT * FROM daily_rewards_claimed WHERE user_id = ? ORDER BY claimed_date DESC LIMIT 1')
      .get(req.userId);
    const streakDay = computeNextStreakDay(lastClaim, today);
    const reward = DAILY_REWARDS[(streakDay - 1) % DAILY_REWARDS.length];

    db.prepare('INSERT INTO daily_rewards_claimed (user_id, streak_day, claimed_date) VALUES (?, ?, ?)')
      .run(req.userId, streakDay, today);

    const granted = grantRewards(db, req.userId, { coins: reward.coins || 0, xp: reward.xp || 0 });
    if (reward.item) {
      const { addInventory } = require('../lib/gameLogic');
      addInventory(db, req.userId, reward.item, 1);
    }

    res.json({ ok: true, streakDay, reward, balances: granted });
  });

  return router;
};

function todayStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD, server clock (UTC-based)
}

function computeNextStreakDay(lastClaim, todayString) {
  if (!lastClaim) return 1;
  const last = new Date(lastClaim.claimed_date + 'T00:00:00Z');
  const today = new Date(todayString + 'T00:00:00Z');
  const diffDays = Math.round((today - last) / 86400000);
  if (diffDays === 1) return lastClaim.streak_day + 1; // consecutive day -> streak continues
  if (diffDays === 0) return lastClaim.streak_day; // shouldn't happen (already claimed check above)
  return 1; // streak broken -> restart
}
