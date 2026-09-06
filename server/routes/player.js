const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const { grantRewards, resolveEnergy, addEnergy, nowSec, xpProgress, isReservedName, startResting, stopResting, resolveEquippedOutfit, resolveSeasonalExpiry } = require('../lib/gameLogic');
const { publicUser } = require('./auth');

// Alternates coins/energy day to day — nothing else (no items, no xp,
// no bonus days). Only 2 entries needed: the `% DAILY_REWARDS.length`
// lookup below naturally keeps alternating coins/energy/coins/energy...
// forever as the streak grows, without needing a padded 7-day list.
const DAILY_REWARDS = [
  { day: 1, coins: 100 },
  { day: 2, energy: 100 },
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

  const DISPLAY_NAME_CHANGE_COST = 200; // Premium Points, after the first free set

  // POST /api/player/display-name { name } — the public-facing name shown
  // in the game, separate from the login username. Setting it for the
  // very first time (display_name is still NULL, e.g. right after signup)
  // is free; every change after that costs Premium Points.
  // POST /api/player/change-password { currentPassword, newPassword }
  // Works for both regular players and admins (an admin is just a user
  // with is_admin=1) — same endpoint, no separate "admin password" concept.
  // POST /api/player/rest — sit on a chair or lie on a bed to regenerate
  // energy faster (see startResting/stopResting in gameLogic.js).
  router.post('/rest', (req, res) => {
    startResting(db, req.userId);
    res.json({ ok: true, resting: true, energy: resolveEnergy(db, req.userId) });
  });

  // POST /api/player/stop-rest — get up; energy regen returns to normal.
  router.post('/stop-rest', (req, res) => {
    stopResting(db, req.userId);
    res.json({ ok: true, resting: false, energy: resolveEnergy(db, req.userId) });
  });

  router.post('/change-password', async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (typeof newPassword !== 'string' || newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const ok = await bcrypt.compare(currentPassword || '', user.password_hash);
    if (!ok) return res.status(400).json({ error: 'Current password is incorrect' });

    const newHash = await bcrypt.hash(newPassword, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, req.userId);
    res.json({ ok: true });
  });

  router.post('/display-name', (req, res) => {
    const name = (req.body && req.body.name || '').toString().trim();
    if (!name) return res.status(400).json({ error: 'Enter a name' });
    if (name.length > 20) return res.status(400).json({ error: 'Keep it under 20 characters' });
    if (isReservedName(name)) return res.status(400).json({ error: 'That name is reserved and cannot be used.' });

    const user = db.prepare('SELECT id, display_name, premium_currency FROM users WHERE id = ?').get(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const isFirstTime = !user.display_name;
    if (!isFirstTime) {
      if ((user.premium_currency || 0) < DISPLAY_NAME_CHANGE_COST) {
        return res.status(400).json({ error: `Changing your name costs 💎 ${DISPLAY_NAME_CHANGE_COST} — you have ${user.premium_currency || 0}` });
      }
      db.prepare('UPDATE users SET premium_currency = premium_currency - ? WHERE id = ?').run(DISPLAY_NAME_CHANGE_COST, req.userId);
    }
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name, req.userId);
    const updated = db.prepare('SELECT premium_currency FROM users WHERE id = ?').get(req.userId);
    res.json({ ok: true, displayName: name, wasFree: isFirstTime, premiumCurrency: updated.premium_currency });
  });

  router.get('/me', (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    resolveEnergy(db, req.userId);
    resolveEquippedOutfit(db, req.userId);
    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
    res.json({ ...publicUser(fresh), xpProgress: xpProgress(fresh.xp) });
  });

  // GET /api/player/leaderboard — the "Most Rich" ranking, frozen for the
  // whole calendar day (server clock) instead of shifting live as people
  // earn/spend coins. The FIRST request after midnight recomputes it from
  // current balances and stores that as the day's snapshot; every request
  // for the rest of the day just returns that same stored snapshot — same
  // "lazily settle on read" pattern as the daily reward streak and crop/
  // animal state elsewhere in this codebase, so no separate cron/scheduler
  // process is needed. Admin accounts are excluded — they aren't real
  // players competing for the ranking, and often sit on artificially large
  // balances from testing/granting rewards.
  router.get('/leaderboard', (req, res) => {
    const today = todayStr();
    let rows = db.prepare('SELECT rank, user_id AS id, name, coins FROM leaderboard_snapshot WHERE snapshot_date = ? ORDER BY rank ASC').all(today);
    if (rows.length === 0) {
      const fresh = db.prepare('SELECT id, username, display_name, coins FROM users WHERE is_admin = 0 ORDER BY coins DESC LIMIT 10').all();
      const insert = db.prepare('INSERT INTO leaderboard_snapshot (snapshot_date, rank, user_id, name, coins) VALUES (?, ?, ?, ?, ?)');
      const txn = db.transaction((players) => {
        db.prepare('DELETE FROM leaderboard_snapshot WHERE snapshot_date != ?').run(today); // keep only today's rows around
        players.forEach((p, i) => insert.run(today, i + 1, p.id, p.display_name || p.username, p.coins));
      });
      txn(fresh);
      rows = db.prepare('SELECT rank, user_id AS id, name, coins FROM leaderboard_snapshot WHERE snapshot_date = ? ORDER BY rank ASC').all(today);
    }
    res.json(rows.map((r) => ({ id: r.id, name: r.name, coins: r.coins })));
  });

  // GET /api/player/outfits - every outfit, flagged with whether this player owns it
  router.get('/outfits', (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
    const all = db.prepare('SELECT * FROM outfit_types ORDER BY required_level, cost').all();
    const t = Math.floor(Date.now() / 1000);
    const ownedRows = db.prepare('SELECT outfit_id, expires_at FROM owned_outfits WHERE user_id = ?').all(req.userId);
    const ownedMap = new Map(ownedRows.map((r) => [r.outfit_id, r.expires_at]));
    res.json(all.map((o) => {
      const expiresAt = ownedMap.get(o.id);
      // NULL expires_at (the free default outfit) never expires; anything
      // else is only "actively owned" while its rental hasn't run out —
      // an expired rental shows in the shop like it was never bought, so
      // it can be re-rented instead of just silently failing to equip.
      const isOwned = ownedMap.has(o.id) && (expiresAt === null || expiresAt > t);
      return { ...o, owned: isOwned, equipped: o.id === user.equipped_outfit, expiresAt: expiresAt || null };
    }));
  });

  // POST /api/player/equip-outfit  { outfitId } - switch to an already-owned outfit, free
  router.post('/equip-outfit', (req, res) => {
    const { outfitId } = req.body || {};
    const owned = db.prepare('SELECT * FROM owned_outfits WHERE user_id = ? AND outfit_id = ?').get(req.userId, outfitId);
    if (!owned) return res.status(400).json({ error: "You don't own that outfit yet" });
    const t = Math.floor(Date.now() / 1000);
    if (owned.expires_at !== null && owned.expires_at <= t) {
      return res.status(400).json({ error: 'That costume rental expired — renew it in the Shop to wear it again' });
    }
    db.prepare('UPDATE users SET equipped_outfit = ?, dye_color = NULL WHERE id = ?').run(outfitId, req.userId);
    res.json({ ok: true, outfitId });
  });

  router.get('/inventory', (req, res) => {
    // Bag-only sweep (no farmId — placed decorations are handled by
    // serializeFarm instead) so a seasonal item still sitting un-placed
    // in the Bag disappears here too, even in a session that never
    // happens to load the farm view first.
    resolveSeasonalExpiry(db, null, req.userId);
    const rows = db.prepare('SELECT item_id, quantity FROM inventory WHERE user_id = ? AND quantity > 0').all(req.userId);
    res.json(rows);
  });

  // GET /api/player/fridge — cold storage for cooking ingredients, kept
  // separate from the Bag (see fridge_storage table). Requires an actual
  // Refrigerator placed somewhere indoors — same "you need the furniture
  // for this" pattern as the Silo gating feed-crafting.
  router.get('/fridge', (req, res) => {
    const rows = db.prepare('SELECT item_id, quantity FROM fridge_storage WHERE user_id = ? AND quantity > 0').all(req.userId);
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

    // Coins day: grantRewards handles it (and any incidental level-up
    // energy bonus). Energy day: credited directly via addEnergy instead
    // — grantRewards only knows about coins/xp, not a standalone energy
    // grant.
    const granted = reward.coins ? grantRewards(db, req.userId, { coins: reward.coins }) : { coins: null, xp: null, level: null };
    const energyAfter = reward.energy ? addEnergy(db, req.userId, reward.energy) : granted.energy;

    res.json({ ok: true, streakDay, reward, balances: { ...granted, energy: energyAfter } });
  });

  return router;
};

function todayStr() {
  // Philippine Time (UTC+8) day boundary — this game's players are in the
  // Philippines, so "the next day" (daily reward streaks, the leaderboard
  // snapshot) should flip at Manila midnight, not UTC midnight (which is
  // actually 8am in Manila — resetting things mid-morning instead of at
  // actual midnight was confusing). Adding 8 hours to the current UTC
  // instant, then reading the date back out via toISOString(), gives the
  // correct Manila calendar date without needing a timezone library.
  const phtMillis = Date.now() + 8 * 60 * 60 * 1000;
  return new Date(phtMillis).toISOString().slice(0, 10);
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
