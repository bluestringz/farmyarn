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
// How long a crop is allowed to sit before it's considered abandoned:
//  - UNWATERED crops die outright 3 hours after being planted.
//  - Crops that finished growing but sat un-harvested for 2 hours past
//    that wither instead (still visible/clearable, just yield nothing).
const CROP_DEATH_UNWATERED_SECONDS = 3 * 3600;
const CROP_WITHER_UNHARVESTED_SECONDS = 2 * 3600;

function resolveCropStates(db, farmId) {
  const t = nowSec();
  // A crop only actually finishes growing once it's been watered at least
  // once — watering was previously just an optional 10%-faster speed
  // boost, meaning a crop still fully matured on its own even if you never
  // watered it at all. Requiring `watered = 1` here means an un-watered
  // crop just sits at 100% progress and waits, instead of quietly
  // finishing anyway.
  db.prepare(`
    UPDATE crops SET state = 'ready'
    WHERE farm_id = ? AND state = 'growing' AND watered = 1 AND growth_end_at <= ?
  `).run(farmId, t);

  // Left un-watered too long: the seed just dies. Cleared by re-plowing
  // over it (or tapping Harvest, which yields nothing for a dead crop —
  // see the /harvest route).
  db.prepare(`
    UPDATE crops SET state = 'dead'
    WHERE farm_id = ? AND state = 'growing' AND watered = 0 AND ? - planted_at > ?
  `).run(farmId, t, CROP_DEATH_UNWATERED_SECONDS);

  // Fully grown but left un-harvested too long: it wilts on the vine
  // instead of waiting forever. growth_end_at doubles as "the moment it
  // became ready" here (that's when the 'ready' transition above fires),
  // so wither timing is measured from there.
  db.prepare(`
    UPDATE crops SET state = 'withered'
    WHERE farm_id = ? AND state = 'ready' AND ? - growth_end_at > ?
  `).run(farmId, t, CROP_WITHER_UNHARVESTED_SECONDS);
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

// Energy has a max of 1000, and slowly regenerates on its own (1 point
// every 3 minutes) so a player is never fully stuck — sitting/lying on a
// chair or bed (see startResting/stopResting) regenerates faster (1 point
// every 2 minutes) while active, and cooking + eating food at a stove
// restores a chunk at once for an immediate boost.
// resolveEnergy() lazily "catches up" a user's stored energy based on how
// long it's been since energy_updated_at, the same pattern crops use for
// growth — no background job needed, it just settles on read.
const MAX_ENERGY = 1000;
const ENERGY_REGEN_SECONDS = 3 * 60; // 1 point per 3 minutes, normal
const ENERGY_REGEN_SECONDS_RESTING = 2 * 60; // 1 point per 2 minutes, while resting

function resolveEnergy(db, userId) {
  const user = db.prepare('SELECT energy, energy_updated_at, is_resting FROM users WHERE id = ?').get(userId);
  if (!user) return null;
  const regenSeconds = user.is_resting ? ENERGY_REGEN_SECONDS_RESTING : ENERGY_REGEN_SECONDS;
  const elapsed = nowSec() - (user.energy_updated_at || nowSec());
  const regen = Math.floor(elapsed / regenSeconds);
  if (regen <= 0 || user.energy >= MAX_ENERGY) return user.energy;
  const newEnergy = Math.min(MAX_ENERGY, user.energy + regen);
  // Only "spend" the regen time that was actually used, so partial progress
  // toward the next point isn't lost/reset.
  const usedSeconds = regen * regenSeconds;
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

// Start/stop resting (sitting on a chair, lying on a bed) — always resolve
// energy FIRST at the OLD rate before flipping is_resting, so the elapsed
// time before the switch is credited at the rate that actually applied
// during it, not retroactively at the new rate.
function startResting(db, userId) {
  resolveEnergy(db, userId);
  db.prepare('UPDATE users SET is_resting = 1 WHERE id = ?').run(userId);
}

function stopResting(db, userId) {
  resolveEnergy(db, userId);
  db.prepare('UPDATE users SET is_resting = 0 WHERE id = ?').run(userId);
}

// Costumes are 7-day rentals (see /api/shop/buy-outfit) — if whatever's
// currently equipped has quietly expired since it was last checked, this
// snaps the player back to the free classic_overalls default rather than
// leaving them wearing a costume their record shows they no longer have
// active. Called lazily wherever a fresh user row is about to be sent to
// the client (login, /me), the same "settle it on read" pattern energy
// and crop growth already use.
function resolveEquippedOutfit(db, userId) {
  const user = db.prepare('SELECT equipped_outfit FROM users WHERE id = ?').get(userId);
  if (!user || !user.equipped_outfit || user.equipped_outfit === 'classic_overalls') return;
  const owned = db.prepare('SELECT expires_at FROM owned_outfits WHERE user_id = ? AND outfit_id = ?').get(userId, user.equipped_outfit);
  const t = nowSec();
  const stillActive = owned && (owned.expires_at === null || owned.expires_at > t);
  if (!stillActive) {
    db.prepare("UPDATE users SET equipped_outfit = 'classic_overalls', dye_color = NULL WHERE id = ?").run(userId);
  }
}

// Adds energy (from eating food), capped at MAX_ENERGY. Does not touch
// energy_updated_at's regen bookkeeping beyond resolving first, so idle
// regen still resumes correctly afterward.
function addEnergy(db, userId, amount) {
  const current = resolveEnergy(db, userId) || 0;
  const next = Math.min(MAX_ENERGY, current + amount);
  db.prepare('UPDATE users SET energy = ?, energy_updated_at = ? WHERE id = ?').run(next, userId);
  return next;
}

// Blocks players from taking on names that impersonate staff/authority —
// used for both the login username (registration) and the public display
// name (first-time set + paid changes). Two tiers:
//  - longer, unambiguous phrases are blocked as a plain substring anywhere
//    in the name, since a real username is very unlikely to contain them
//    by coincidence (nobody's legitimately named "xAdminX" or "TeamOfficial").
//  - short strings (gm, mod, dev, staff, owner, sys) are only blocked as
//    the WHOLE name (optionally with trailing digits, e.g. "gm99") because
//    matching them as a bare substring would false-positive on ordinary
//    names that just happen to contain those letters (e.g. "Kingman").
const RESERVED_NAME_SUBSTRINGS = [
  'admin', 'administrator', 'gamemaster', 'moderator', 'official', 'farmyarn', 'support',
];
const RESERVED_NAME_EXACT = ['gm', 'mod', 'dev', 'staff', 'owner', 'sys'];

function isReservedName(name) {
  const normalized = (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (RESERVED_NAME_SUBSTRINGS.some((term) => normalized.includes(term))) return true;
  return RESERVED_NAME_EXACT.some((term) => new RegExp(`^${term}\\d*$`).test(normalized));
}

module.exports = {
  nowSec, xpForLevel, levelForXp, xpProgress, initFarmTiles, resolveCropStates,
  grantRewards, addInventory, notify, resolveEnergy, spendEnergy, addEnergy, MAX_ENERGY,
  isReservedName, startResting, stopResting, resolveEquippedOutfit,
};
