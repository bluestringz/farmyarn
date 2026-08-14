// server/lib/gameLogic.js
// Server-authoritative helpers. The client NEVER dictates coins, xp, or crop state directly.

const nowSec = () => Math.floor(Date.now() / 1000);

// XP required to REACH a given level. Level 1 = 0.
// Scalable curve: 100 * level^1.6 (rounded), matches the "increasing cost per level" feel
// of classic social games without hardcoding a short table.
function xpForLevel(level) {
  if (level <= 1) return 0;
  return Math.round(100 * Math.pow(level - 1, 1.6) + 100 * (level - 1));
}

function levelForXp(xp) {
  let level = 1;
  while (xpForLevel(level + 1) <= xp) level++;
  return level;
}

function xpProgress(xp) {
  const level = levelForXp(xp);
  const currentFloor = xpForLevel(level);
  const nextCeil = xpForLevel(level + 1);
  return { level, xp, currentFloor, nextCeil, xpIntoLevel: xp - currentFloor, xpForNext: nextCeil - currentFloor };
}

// Initialize a fresh farm's tiles as grass, sized to width x height.
function initFarmTiles(db, farmId, width, height) {
  const insert = db.prepare(`INSERT OR IGNORE INTO farm_tiles (farm_id, x, y, state) VALUES (?, ?, ?, 'grass')`);
  const tx = db.transaction(() => {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        insert.run(farmId, x, y);
      }
    }
  });
  tx();
}

// Resolve (lazily update) crop states for a farm based on server time.
// This is called whenever a farm is loaded/queried so growth is always accurate
// regardless of whether the owner was online.
function resolveCropStates(db, farmId) {
  const t = nowSec();
  const stmt = db.prepare(`
    UPDATE crops SET state = 'ready'
    WHERE farm_id = ? AND state = 'growing' AND growth_end_at <= ?
  `);
  stmt.run(farmId, t);
}

// Resolve animal production readiness is handled inline at read-time (see routes/farm.js)
// since animal state lives inside farm_objects.state as JSON, not a dedicated table.

function grantRewards(db, userId, { coins = 0, xp = 0 } = {}) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return null;
  const newCoins = user.coins + coins;
  const newXp = user.xp + xp;
  const oldLevel = levelForXp(user.xp);
  const newLevel = levelForXp(newXp);
  db.prepare('UPDATE users SET coins = ?, xp = ?, level = ? WHERE id = ?')
    .run(newCoins, newXp, newLevel, userId);
  if (newLevel > oldLevel) {
    db.prepare(`INSERT INTO notifications (user_id, type, message) VALUES (?, 'level_up', ?)`)
      .run(userId, `You reached Level ${newLevel}!`);
  }
  return { coins: newCoins, xp: newXp, level: newLevel, leveledUp: newLevel > oldLevel };
}

function addInventory(db, userId, itemId, qty) {
  const existing = db.prepare('SELECT * FROM inventory WHERE user_id = ? AND item_id = ?').get(userId, itemId);
  if (existing) {
    db.prepare('UPDATE inventory SET quantity = quantity + ? WHERE id = ?').run(qty, existing.id);
  } else {
    db.prepare('INSERT INTO inventory (user_id, item_id, quantity) VALUES (?, ?, ?)').run(userId, itemId, qty);
  }
}

function notify(db, userId, type, message) {
  db.prepare(`INSERT INTO notifications (user_id, type, message) VALUES (?, ?, ?)`).run(userId, type, message);
}

// Energy has a max of 20, and slowly regenerates on its own (1 point every
// 15 minutes) so a player is never fully stuck — but the fast way back up
// is cooking + eating food at a stove, which restores a chunk at once.
// resolveEnergy() lazily "catches up" a user's stored energy based on how
// long it's been since energy_updated_at, the same pattern crops use for
// growth — no background job needed, it just settles on read.
const MAX_ENERGY = 1000;
const ENERGY_REGEN_SECONDS = 3 * 60; // 1 point per 3 minutes

function resolveEnergy(db, userId) {
  const user = db.prepare('SELECT energy, energy_updated_at FROM users WHERE id = ?').get(userId);
  if (!user) return null;
  const elapsed = nowSec() - (user.energy_updated_at || nowSec());
  const regen = Math.floor(elapsed / ENERGY_REGEN_SECONDS);
  if (regen <= 0 || user.energy >= MAX_ENERGY) return user.energy;
  const newEnergy = Math.min(MAX_ENERGY, user.energy + regen);
  // Only "spend" the regen time that was actually used, so partial progress
  // toward the next point isn't lost/reset.
  const usedSeconds = regen * ENERGY_REGEN_SECONDS;
  db.prepare('UPDATE users SET energy = ?, energy_updated_at = ? WHERE id = ?')
    .run(newEnergy, (user.energy_updated_at || nowSec()) + usedSeconds, userId);
  return newEnergy;
}

// Returns true and deducts on success, false (no change) if not enough energy.
function spendEnergy(db, userId, amount) {
  const current = resolveEnergy(db, userId);
  if (current === null || current < amount) return false;
  db.prepare('UPDATE users SET energy = ? WHERE id = ?').run(current - amount, userId);
  return true;
}

// Adds energy (from eating food), capped at MAX_ENERGY. Does not touch
// energy_updated_at's regen bookkeeping beyond resolving first, so idle
// regen still resumes correctly afterward.
function addEnergy(db, userId, amount) {
  const current = resolveEnergy(db, userId) || 0;
  const next = Math.min(MAX_ENERGY, current + amount);
  db.prepare('UPDATE users SET energy = ? WHERE id = ?').run(next, userId);
  return next;
}

module.exports = {
  nowSec, xpForLevel, levelForXp, xpProgress, initFarmTiles, resolveCropStates,
  grantRewards, addInventory, notify, resolveEnergy, spendEnergy, addEnergy, MAX_ENERGY,
};
