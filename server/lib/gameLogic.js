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

// Default values (seconds) for the global, admin-tunable timers below —
// used whenever game_settings has no row for that key yet (i.e. an admin
// has never overridden it). See ADMIN PANEL > Timers > Global Rules.
const DEFAULT_TIMERS = {
  crop_death_unwatered_seconds: 12 * 3600,
  crop_wither_unharvested_seconds: 12 * 3600,
  animal_starve_seconds: 24 * 3600,
  animal_cold_death_seconds: 4 * 3600,
};

// Reads one tunable global timer (in seconds) from game_settings, falling
// back to its hardcoded default if the admin hasn't overridden it. Cheap
// single-row lookup — called at most a few times per farm load, so no
// caching needed.
function getTimerSetting(db, key) {
  const row = db.prepare('SELECT value FROM game_settings WHERE key = ?').get(key);
  return row ? row.value : DEFAULT_TIMERS[key];
}

// Resolve (lazily update) crop states for a farm based on server time.
// This is called whenever a farm is loaded/queried so growth is always accurate
// regardless of whether the owner was online.
// How long a crop is allowed to sit before it's considered abandoned:
//  - UNWATERED crops die outright N hours after being planted.
//  - Crops that finished growing but sat un-harvested for N hours past
//    that wither instead (still visible/clearable, just yield nothing).
// Both windows are admin-tunable (see DEFAULT_TIMERS / game_settings above).

function resolveCropStates(db, farmId) {
  const t = nowSec();
  const CROP_DEATH_UNWATERED_SECONDS = getTimerSetting(db, 'crop_death_unwatered_seconds');
  const CROP_WITHER_UNHARVESTED_SECONDS = getTimerSetting(db, 'crop_wither_unharvested_seconds');
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

// A chicken/pig/sheep/cow that hasn't been fed within the starve window
// dies — same "lazily settle on read" pattern as crop growth/death above,
// called wherever a farm's objects get fetched (both outdoor AND indoor,
// since animals can live in the coop/barn now too — see interiorSpaces.js).
// Reference point is whichever is more recent: the last time it was fed,
// or when it was placed (for an animal that's never been fed at all).
// Window length is admin-tunable (see DEFAULT_TIMERS / game_settings above).

function resolveAnimalDeaths(db, farmId) {
  const t = nowSec();
  const ANIMAL_STARVE_SECONDS = getTimerSetting(db, 'animal_starve_seconds');
  const animals = db.prepare("SELECT * FROM farm_objects WHERE farm_id = ? AND object_type = 'animal'").all(farmId);
  for (const animal of animals) {
    let state = null;
    try { state = animal.state ? JSON.parse(animal.state) : null; } catch (e) { state = null; }
    const referencePoint = (state && state.lastFed) || animal.created_at;
    if (t - referencePoint > ANIMAL_STARVE_SECONDS) {
      db.prepare('DELETE FROM farm_objects WHERE id = ?').run(animal.id);
    }
  }
}

// A chicken/pig/sheep/cow left cold too long also dies — separate from
// starvation above. An animal is "cold" only at night AND without a heat
// source nearby: a Fireplace somewhere in the SAME indoor room for one
// housed in a coop/barn, or a Bonfire within BONFIRE_RADIUS tiles for one
// kept outdoors on the open farm. Unlike starvation (a single "hasn't
// been fed since X" timestamp), coldness is a live environmental
// condition that can start and stop — state.coldSince marks when it FIRST
// went cold; it's cleared the moment it's warm again (day breaks, or a
// heat source shows up nearby), so partial cold spells never carry over
// and stack toward death. Same lazy "resolve whenever the farm is
// fetched" pattern as everything else here — this is not a live ticking
// simulation.
const BONFIRE_RADIUS = 3; // tiles, outdoor Bonfire only

function resolveAnimalColdDeaths(db, farmId) {
  const t = nowSec();
  // Filipino playerbase — Philippine Time (UTC+8), same convention as
  // todayStr() in routes/player.js, so "is it night" here agrees with
  // what the player actually sees in the client's own day/night tint
  // (which uses the player's local device clock, virtually always PHT).
  const phtHour = new Date(t * 1000 + 8 * 3600 * 1000).getUTCHours();
  const isNight = phtHour >= 19 || phtHour < 5;

  const animals = db.prepare("SELECT * FROM farm_objects WHERE farm_id = ? AND object_type = 'animal'").all(farmId);
  if (animals.length === 0) return;

  const COLD_DEATH_SECONDS = getTimerSetting(db, 'animal_cold_death_seconds');
  const fireplaceLocations = new Set(
    db.prepare("SELECT DISTINCT location FROM farm_objects WHERE farm_id = ? AND object_type = 'interior' AND item_id = 'fireplace'")
      .all(farmId).map((r) => r.location)
  );
  const bonfires = db.prepare("SELECT grid_x, grid_y FROM farm_objects WHERE farm_id = ? AND object_type = 'decoration' AND item_id = 'bonfire' AND location = 'outdoor'").all(farmId);

  for (const animal of animals) {
    const isWarm = animal.location === 'outdoor'
      ? bonfires.some((b) => Math.abs(b.grid_x - animal.grid_x) <= BONFIRE_RADIUS && Math.abs(b.grid_y - animal.grid_y) <= BONFIRE_RADIUS)
      : fireplaceLocations.has(animal.location);
    const isCold = isNight && !isWarm;

    let state = {};
    try { state = animal.state ? JSON.parse(animal.state) : {}; } catch (e) { state = {}; }

    if (isCold) {
      if (!state.coldSince) {
        state.coldSince = t;
        db.prepare('UPDATE farm_objects SET state = ? WHERE id = ?').run(JSON.stringify(state), animal.id);
      } else if (t - state.coldSince > COLD_DEATH_SECONDS) {
        db.prepare('DELETE FROM farm_objects WHERE id = ?').run(animal.id);
      }
    } else if (state.coldSince) {
      delete state.coldSince;
      db.prepare('UPDATE farm_objects SET state = ? WHERE id = ?').run(JSON.stringify(state), animal.id);
    }
  }
}

// Resolve animal production readiness is handled inline at read-time (see routes/farm.js)
// since animal state lives inside farm_objects.state as JSON, not a dedicated table.

// Fruit trees (Mango/Apple/Avocado) — see decoration_types' produces_item_id
// etc. columns. Once mature (the SAME growable-decoration growth state
// every tree/sapling already uses — state.growthEndAt), a fruit tree
// keeps producing on a repeating cycle: ready every production_seconds,
// but if left uncollected for longer than fruit_spoil_seconds past
// becoming ready, that batch rots — this fast-forwards last_collected_at
// past every FULLY SPOILED cycle a farm hasn't been visited during, so a
// long-neglected tree doesn't show ancient "ready" fruit that's actually
// long gone, and so collect-fruit's own readiness check only ever sees a
// batch that's genuinely still collectible right now.
function resolveFruitTreeSpoilage(db, farmId) {
  const t = nowSec();
  const trees = db.prepare(`
    SELECT fo.id, fo.state, fo.last_collected_at, dt.production_seconds, dt.fruit_spoil_seconds
    FROM farm_objects fo JOIN decoration_types dt ON fo.item_id = dt.id
    WHERE fo.farm_id = ? AND fo.object_type = 'decoration' AND dt.produces_item_id IS NOT NULL
  `).all(farmId);
  for (const tree of trees) {
    let growth;
    try { growth = tree.state ? JSON.parse(tree.state) : null; } catch (e) { growth = null; }
    if (!growth || !growth.growthEndAt || growth.growthEndAt > t) continue; // still a sapling
    const cycleLen = tree.production_seconds;
    const spoilLen = tree.fruit_spoil_seconds;
    if (!cycleLen) continue;
    // Math.max, not || — see the same reasoning in shop.js's
    // /collect-fruit and farm.js's resolveObject: last_collected_at is
    // set to the PLANTING time at insert (always truthy), not left null
    // until first collected the way it naturally is for animals.
    const startBase = Math.max(tree.last_collected_at, growth.growthEndAt);
    let base = startBase;
    let iterations = 0;
    while (t >= base + cycleLen + spoilLen && iterations < 1000) {
      base += cycleLen;
      iterations++;
    }
    if (base !== startBase) {
      db.prepare('UPDATE farm_objects SET last_collected_at = ? WHERE id = ?').run(base, tree.id);
    }
  }
}

// A fruit tree dies of old age lifespan_seconds after it MATURES (not
// from when it was planted) — same lazy "resolve whenever the farm is
// read" pattern as every other neglect/death check in this file.
function resolveFruitTreeDeaths(db, farmId) {
  const t = nowSec();
  const trees = db.prepare(`
    SELECT fo.id, fo.state, dt.lifespan_seconds
    FROM farm_objects fo JOIN decoration_types dt ON fo.item_id = dt.id
    WHERE fo.farm_id = ? AND fo.object_type = 'decoration' AND dt.produces_item_id IS NOT NULL
  `).all(farmId);
  for (const tree of trees) {
    let growth;
    try { growth = tree.state ? JSON.parse(tree.state) : null; } catch (e) { growth = null; }
    if (!growth || !growth.growthEndAt || growth.growthEndAt > t) continue; // still a sapling, not "alive" to die yet
    if (!tree.lifespan_seconds) continue;
    if (t >= growth.growthEndAt + tree.lifespan_seconds) {
      db.prepare('DELETE FROM farm_objects WHERE id = ?').run(tree.id);
    }
  }
}

// How many units a single harvest/collection yields — always at least 1,
// with a shrinking chance at each additional piece (cascading: each roll
// only happens if the previous one succeeded), so the max is rare but not
// impossible. Crops and animal products use different odds/caps (crops
// can go up to 5, animal products cap at 3 — animal products are
// generally worth more per unit, so a smaller ceiling keeps them from
// snowballing as fast as a big crop harvest can).
const HARVEST_QTY_CASCADE = [1, 0.85, 0.65, 0.35, 0.19]; // 1pc guaranteed, 85% for a 2nd, 65% for a 3rd (given the 2nd), 35% for a 4th, 19% for a 5th
const ANIMAL_QTY_CASCADE = [1, 0.40, 0.09]; // 1pc guaranteed, 40% for a 2nd, 9% for a 3rd (given the 2nd)

function rollCascadeQuantity(cascade) {
  let qty = 0;
  for (const chance of cascade) {
    if (Math.random() < chance) qty++;
    else break;
  }
  return qty;
}
function rollHarvestQuantity() { return rollCascadeQuantity(HARVEST_QTY_CASCADE); }
function rollAnimalQuantity() { return rollCascadeQuantity(ANIMAL_QTY_CASCADE); }

function grantRewards(db, userId, { coins = 0, xp = 0 } = {}) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return null;
  const newCoins = user.coins + coins;
  const newXp = user.xp + xp;
  const oldLevel = levelForXp(user.xp);
  const newLevel = levelForXp(newXp);
  db.prepare('UPDATE users SET coins = ?, xp = ?, level = ? WHERE id = ?')
    .run(newCoins, newXp, newLevel, userId);
  let energy;
  if (newLevel > oldLevel) {
    // A little "leveling up feels good" bonus — +100 energy per level
    // gained (so a rare multi-level jump from one big XP grant still gets
    // credit for every level it crossed, not just a flat one-time bonus).
    energy = addEnergy(db, userId, 100 * (newLevel - oldLevel));
    db.prepare(`INSERT INTO notifications (user_id, type, message) VALUES (?, 'level_up', ?)`)
      .run(userId, `You reached Level ${newLevel}! +${100 * (newLevel - oldLevel)} energy`);
  }
  return { coins: newCoins, xp: newXp, level: newLevel, leveledUp: newLevel > oldLevel, energy };
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
  db.prepare('UPDATE users SET energy = ? WHERE id = ?').run(next, userId);
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
  nowSec, xpForLevel, levelForXp, xpProgress, initFarmTiles, resolveCropStates, resolveAnimalDeaths, resolveAnimalColdDeaths,
  resolveFruitTreeSpoilage, resolveFruitTreeDeaths,
  grantRewards, addInventory, notify, resolveEnergy, spendEnergy, addEnergy, MAX_ENERGY,
  isReservedName, startResting, stopResting, resolveEquippedOutfit, rollHarvestQuantity, rollAnimalQuantity,
  getTimerSetting, DEFAULT_TIMERS,
};
