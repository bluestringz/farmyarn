// server/db/migrate.js
// Creates the SQLite schema. Safe to run multiple times (IF NOT EXISTS).
// Also seeds static game-definition tables (crop types, building types, etc.)

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'farmco-op.db');

function migrate(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT, -- separate public-facing name; NULL until the player sets one (first set is free, changes after cost Premium Points)
    password_hash TEXT NOT NULL,
    avatar TEXT DEFAULT 'default',
    gender TEXT NOT NULL DEFAULT 'male', -- 'male' | 'female' — controls the character's base look
    equipped_outfit TEXT, -- references outfit_types(id); NULL = default starter clothes
    dye_color TEXT, -- optional custom shirt-color override, bought at the Market
    level INTEGER NOT NULL DEFAULT 1,
    xp INTEGER NOT NULL DEFAULT 0,
    coins INTEGER NOT NULL DEFAULT 100,
    premium_currency INTEGER NOT NULL DEFAULT 0,
    energy INTEGER NOT NULL DEFAULT 1000,
    energy_updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    is_admin INTEGER NOT NULL DEFAULT 0,
    is_banned INTEGER NOT NULL DEFAULT 0,
    suspended_until INTEGER, -- unix timestamp; NULL = not suspended. Temporary, unlike is_banned (permanent).
    is_resting INTEGER NOT NULL DEFAULT 0, -- sitting/lying on furniture — regenerates energy faster while true
    friend_water_count INTEGER NOT NULL DEFAULT 0, -- how many times today this player has watered a FRIEND's crop — resets daily, makes each successive help cost more gold
    friend_water_date TEXT, -- 'YYYY-MM-DD' the count above is for; a new day resets the count to 0
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    last_login INTEGER
  );

  CREATE TABLE IF NOT EXISTS farms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    farm_name TEXT NOT NULL DEFAULT 'My Farm',
    width INTEGER NOT NULL DEFAULT 12,
    height INTEGER NOT NULL DEFAULT 12,
    expansion_level INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );

  -- Static definition tables (game content, not per-player state) --

  CREATE TABLE IF NOT EXISTS crop_types (
    id TEXT PRIMARY KEY,           -- e.g. 'wheat'
    name TEXT NOT NULL,
    seed_cost INTEGER NOT NULL,
    sell_price INTEGER NOT NULL,
    xp_reward INTEGER NOT NULL,
    growth_seconds INTEGER NOT NULL,
    required_level INTEGER NOT NULL DEFAULT 1,
    sprite TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS building_types (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    cost INTEGER NOT NULL,
    required_level INTEGER NOT NULL DEFAULT 1,
    width INTEGER NOT NULL DEFAULT 2,
    height INTEGER NOT NULL DEFAULT 2,
    sprite TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'building'
  );

  CREATE TABLE IF NOT EXISTS decoration_types (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    cost INTEGER NOT NULL,
    required_level INTEGER NOT NULL DEFAULT 1,
    width INTEGER NOT NULL DEFAULT 1,
    height INTEGER NOT NULL DEFAULT 1,
    sprite TEXT NOT NULL,
    growable INTEGER NOT NULL DEFAULT 0, -- 1 = starts as a sapling and needs time (+ watering) to mature
    growth_seconds INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS animal_types (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    cost INTEGER NOT NULL,
    required_level INTEGER NOT NULL DEFAULT 1,
    product_item_id TEXT NOT NULL,
    production_seconds INTEGER NOT NULL,
    sprite TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS item_types (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    sell_price INTEGER NOT NULL DEFAULT 0,
    sprite TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'produce'
  );

  CREATE TABLE IF NOT EXISTS outfit_types (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    cost INTEGER NOT NULL,
    required_level INTEGER NOT NULL DEFAULT 1,
    gender TEXT NOT NULL DEFAULT 'unisex', -- 'male' | 'female' | 'unisex'
    shirt_color TEXT NOT NULL,
    pants_color TEXT NOT NULL,
    hat_color TEXT,
    style TEXT NOT NULL DEFAULT 'overalls', -- 'overalls' | 'dress' | 'shirt'
    sprite_key TEXT NOT NULL DEFAULT 'classic' -- which character sprite set to use (see public/assets/characters/)
  );

  CREATE TABLE IF NOT EXISTS owned_outfits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    outfit_id TEXT NOT NULL REFERENCES outfit_types(id),
    acquired_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    expires_at INTEGER, -- unix timestamp; NULL = never expires (the free default outfit only — every paid costume gets one)
    UNIQUE(user_id, outfit_id)
  );

  CREATE TABLE IF NOT EXISTS interior_types (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    cost INTEGER NOT NULL,
    required_level INTEGER NOT NULL DEFAULT 1,
    width INTEGER NOT NULL DEFAULT 1,
    height INTEGER NOT NULL DEFAULT 1,
    sprite TEXT NOT NULL
  );

  -- A fixed set of Marketplace stalls shared by every player — a lightweight
  -- player-to-player trading hub, separate from the always-available system
  -- Shop. Renting a stall lets a player list one item type for other real
  -- players to buy directly from them.
  CREATE TABLE IF NOT EXISTS marketplace_stalls (
    id INTEGER PRIMARY KEY,
    renter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    rented_until INTEGER,
    listing_item_id TEXT,
    listing_price INTEGER,
    listing_quantity INTEGER DEFAULT 0
  );

  -- A stall can carry several different items for sale at once (e.g. wheat
  -- seeds AND eggs side by side), unlike the old single listing_item_id/
  -- listing_price/listing_quantity columns on marketplace_stalls above
  -- (kept, unused going forward, purely so an old row's data isn't lost —
  -- see the one-time migration in addColumnsIfMissing).
  CREATE TABLE IF NOT EXISTS marketplace_listings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stall_id INTEGER NOT NULL REFERENCES marketplace_stalls(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    price INTEGER NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );

  -- Per-player state tables --

  CREATE TABLE IF NOT EXISTS farm_tiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    farm_id INTEGER NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'grass', -- grass | plowed | locked
    UNIQUE(farm_id, x, y)
  );

  CREATE TABLE IF NOT EXISTS crops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    farm_id INTEGER NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
    tile_x INTEGER NOT NULL,
    tile_y INTEGER NOT NULL,
    crop_type TEXT NOT NULL REFERENCES crop_types(id),
    planted_at INTEGER NOT NULL,
    growth_end_at INTEGER NOT NULL,
    watered INTEGER NOT NULL DEFAULT 0,
    watered_by INTEGER, -- last visitor who watered (for help tracking), nullable
    state TEXT NOT NULL DEFAULT 'growing', -- growing | ready | dead (un-watered too long) | withered (ready too long, un-harvested)
    UNIQUE(farm_id, tile_x, tile_y)
  );

  CREATE TABLE IF NOT EXISTS farm_objects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    farm_id INTEGER NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
    object_type TEXT NOT NULL, -- 'building' | 'decoration' | 'animal' | 'interior'
    item_id TEXT NOT NULL,     -- references building_types/decoration_types/animal_types/interior_types id
    location TEXT NOT NULL DEFAULT 'outdoor', -- 'outdoor' | 'indoor' — which grid this sits on
    grid_x INTEGER NOT NULL,
    grid_y INTEGER NOT NULL,
    rotation INTEGER NOT NULL DEFAULT 0,
    state TEXT,                -- freeform JSON string for object-specific state
    last_collected_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0,
    UNIQUE(user_id, item_id)
  );

  -- A second, separate item pool from inventory (the Bag) — deposited at
  -- the Storage Shed to declutter the Bag, withdrawn back whenever needed.
  -- Same shape as inventory on purpose (item_id/quantity), just a
  -- different "location" for the same kind of stack.
  CREATE TABLE IF NOT EXISTS storage_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0,
    UNIQUE(user_id, item_id)
  );

  CREATE TABLE IF NOT EXISTS friends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | blocked
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    UNIQUE(requester_id, receiver_id)
  );

  CREATE TABLE IF NOT EXISTS help_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    visitor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_type TEXT NOT NULL, -- 'crop' | 'animal'
    target_id INTEGER NOT NULL,
    action_type TEXT NOT NULL, -- 'water' | 'collect_help'
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    read INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS password_reset_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message TEXT, -- optional note from the player explaining who they are / how to verify them
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'resolved'
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    resolved_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, -- NULL = global chat, set = whisper
    message TEXT NOT NULL,
    is_announcement INTEGER NOT NULL DEFAULT 0, -- sent from the admin panel — shown distinctly, to everyone
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );

  CREATE INDEX IF NOT EXISTS idx_chat_global ON chat_messages(to_user_id, created_at);

  CREATE TABLE IF NOT EXISTS daily_rewards_claimed (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    streak_day INTEGER NOT NULL,
    claimed_date TEXT NOT NULL, -- YYYY-MM-DD (server date)
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    UNIQUE(user_id, claimed_date)
  );

  CREATE INDEX IF NOT EXISTS idx_crops_farm ON crops(farm_id);
  CREATE INDEX IF NOT EXISTS idx_objects_farm ON farm_objects(farm_id);
  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read);
  CREATE INDEX IF NOT EXISTS idx_friends_users ON friends(requester_id, receiver_id);
  `);

  addColumnsIfMissing(db);
  seedContent(db);
}

// Adds columns introduced after initial release to any pre-existing database
// (CREATE TABLE IF NOT EXISTS doesn't retroactively add new columns).
function addColumnsIfMissing(db) {
  const existingCols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (!existingCols.includes('suspended_until')) {
    db.exec('ALTER TABLE users ADD COLUMN suspended_until INTEGER');
  }
  if (!existingCols.includes('is_resting')) {
    db.exec('ALTER TABLE users ADD COLUMN is_resting INTEGER NOT NULL DEFAULT 0');
  }
  if (!existingCols.includes('friend_water_count')) {
    db.exec('ALTER TABLE users ADD COLUMN friend_water_count INTEGER NOT NULL DEFAULT 0');
  }
  if (!existingCols.includes('friend_water_date')) {
    db.exec('ALTER TABLE users ADD COLUMN friend_water_date TEXT');
  }
  if (!existingCols.includes('display_name')) {
    db.exec('ALTER TABLE users ADD COLUMN display_name TEXT');
  }
  if (!existingCols.includes('gender')) {
    db.exec("ALTER TABLE users ADD COLUMN gender TEXT NOT NULL DEFAULT 'male'");
  }
  const chatCols = db.prepare("PRAGMA table_info(chat_messages)").all().map((c) => c.name);
  if (!chatCols.includes('is_announcement')) {
    db.exec('ALTER TABLE chat_messages ADD COLUMN is_announcement INTEGER NOT NULL DEFAULT 0');
  }
  const ownedOutfitCols = db.prepare("PRAGMA table_info(owned_outfits)").all().map((c) => c.name);
  if (!ownedOutfitCols.includes('expires_at')) {
    db.exec('ALTER TABLE owned_outfits ADD COLUMN expires_at INTEGER');
  }
  if (!existingCols.includes('equipped_outfit')) {
    db.exec('ALTER TABLE users ADD COLUMN equipped_outfit TEXT');
  }
  if (!existingCols.includes('dye_color')) {
    db.exec('ALTER TABLE users ADD COLUMN dye_color TEXT');
  }
  const objectCols = db.prepare("PRAGMA table_info(farm_objects)").all().map((c) => c.name);
  if (!objectCols.includes('location')) {
    db.exec("ALTER TABLE farm_objects ADD COLUMN location TEXT NOT NULL DEFAULT 'outdoor'");
  }
  const decoCols = db.prepare("PRAGMA table_info(decoration_types)").all().map((c) => c.name);
  if (!decoCols.includes('growable')) {
    db.exec('ALTER TABLE decoration_types ADD COLUMN growable INTEGER NOT NULL DEFAULT 0');
  }
  if (!decoCols.includes('growth_seconds')) {
    db.exec('ALTER TABLE decoration_types ADD COLUMN growth_seconds INTEGER NOT NULL DEFAULT 0');
  }
  const outfitCols = db.prepare("PRAGMA table_info(outfit_types)").all().map((c) => c.name);
  if (!outfitCols.includes('sprite_key')) {
    db.exec("ALTER TABLE outfit_types ADD COLUMN sprite_key TEXT NOT NULL DEFAULT 'classic'");
  }
  // These four outfits never got real matching artwork and were hidden
  // from the shop — anyone who already had one equipped gets switched back
  // to the free default look instead of being stuck wearing something that
  // no longer shows up anywhere in the UI. Plain data fix, not a schema
  // change, so it's safe to just run this every startup (no-op once done).
  db.exec(`
    UPDATE users SET equipped_outfit = 'classic_overalls'
    WHERE equipped_outfit IN ('red_flannel', 'blue_dungarees', 'straw_worker', 'harvest_gold')
  `);
  // ONE-TIME top-up for accounts still stuck at the OLD energy ceiling
  // (20) from before this update — new energy default is 1000 (see
  // MAX_ENERGY in lib/gameLogic.js).
  //
  // BUG FIX: this used to check "energy <= 20" as a proxy for "this must
  // be an old stuck account" — but that's actually really easy for a
  // genuinely active player to hit through completely normal play (energy
  // only regenerates 1 per 3 minutes, so someone plowing/planting/
  // watering/harvesting a lot can easily run their energy down to 20 or
  // below). Since this runs on every server start, and this game gets
  // redeployed often, active players kept getting their energy silently
  // reset back up to 1000 any time a deploy happened to land while their
  // energy was already low from normal spending — NOT what "one-time
  // top-up" was supposed to mean. Fixed by using an actual one-time flag
  // column instead of re-deriving "is this an old account" from a energy
  // value that legitimately changes during normal play.
  const migrationCols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (!migrationCols.includes('energy_v2_migrated')) {
    db.exec('ALTER TABLE users ADD COLUMN energy_v2_migrated INTEGER NOT NULL DEFAULT 0');
  }
  db.exec(`
    UPDATE users SET energy = 1000, energy_v2_migrated = 1
    WHERE energy_v2_migrated = 0 AND energy <= 20
  `);
  // Accounts that were already above the old 20-point ceiling when this
  // shipped (meaning they'd already been topped up some other way, or are
  // fresh registrations that start at 1000 anyway) never needed the
  // top-up — just mark them done so this UPDATE has nothing left to touch
  // on future restarts, matching the "only ever runs once" intent.
  db.exec('UPDATE users SET energy_v2_migrated = 1 WHERE energy_v2_migrated = 0');

  // One-time migration: coop/barn interiors used to be ONE shared room per
  // farm regardless of how many physical coop/barn buildings existed
  // (location='indoor_coop' / 'indoor_barn'). Now each specific building
  // has its own separate room (location='indoor:<farm_objects.id>') — see
  // server/lib/interiorSpaces.js. Anything still sitting at the old shared
  // locations gets moved into the farm's first matching building so
  // nothing already placed gets silently orphaned/unreachable. Safe to
  // re-run: once migrated, nothing is left at the old location values, so
  // this is a no-op on every subsequent server start.
  const oldCoopFurniture = db.prepare("SELECT DISTINCT farm_id FROM farm_objects WHERE location = 'indoor_coop'").all();
  const oldBarnFurniture = db.prepare("SELECT DISTINCT farm_id FROM farm_objects WHERE location = 'indoor_barn'").all();
  const migrateOldRoom = db.transaction((farmId, oldLocation, buildingItemId) => {
    const building = db.prepare("SELECT id FROM farm_objects WHERE farm_id = ? AND item_id = ? AND object_type = 'building' ORDER BY id LIMIT 1")
      .get(farmId, buildingItemId);
    if (!building) return; // no matching building left on this farm — leave as-is rather than guess
    db.prepare('UPDATE farm_objects SET location = ? WHERE farm_id = ? AND location = ?')
      .run(`indoor:${building.id}`, farmId, oldLocation);
  });
  for (const row of oldCoopFurniture) migrateOldRoom(row.farm_id, 'indoor_coop', 'chicken_coop');
  for (const row of oldBarnFurniture) migrateOldRoom(row.farm_id, 'indoor_barn', 'cow_barn');

  // One-time migration: costumes used to be bought once and owned forever
  // — now every paid costume (anything except the free classic_overalls
  // default) is a 7-day rental instead (see /api/shop/buy-outfit). Anyone
  // who already owned a paid costume before this change gets a one-time
  // 7-day grace period starting now, rather than instantly losing access
  // to something they already paid for under the old permanent-ownership
  // rules. Only touches rows that don't already have an expiration set,
  // so this is a no-op on every subsequent server start.
  db.prepare(`
    UPDATE owned_outfits SET expires_at = ? + (7 * 86400)
    WHERE expires_at IS NULL AND outfit_id != 'classic_overalls'
  `).run(Math.floor(Date.now() / 1000));

  // One-time migration: each stall used to hold exactly ONE listing at a
  // time (the listing_item_id/listing_price/listing_quantity columns on
  // marketplace_stalls above) — now a stall can carry several different
  // items via the marketplace_listings table. Move any existing single
  // listing over so it isn't lost, then clear the old columns so this
  // doesn't re-run and duplicate it on the next server start.
  const oldListings = db.prepare('SELECT id, listing_item_id, listing_price, listing_quantity FROM marketplace_stalls WHERE listing_item_id IS NOT NULL').all();
  if (oldListings.length) {
    const insertListing = db.prepare('INSERT INTO marketplace_listings (stall_id, item_id, price, quantity) VALUES (?, ?, ?, ?)');
    const clearOld = db.prepare('UPDATE marketplace_stalls SET listing_item_id = NULL, listing_price = NULL, listing_quantity = 0 WHERE id = ?');
    const migrateListings = db.transaction(() => {
      for (const row of oldListings) {
        insertListing.run(row.id, row.listing_item_id, row.listing_price, row.listing_quantity);
        clearOld.run(row.id);
      }
    });
    migrateListings();
  }

  // Seed (or top up) the fixed marketplace stalls — 20 rentable stalls total.
  // Uses INSERT OR IGNORE so it's safe to bump the count later and re-run
  // against a database that already has the original 12.
  const insertStall = db.prepare('INSERT OR IGNORE INTO marketplace_stalls (id) VALUES (?)');
  const tx = db.transaction(() => { for (let i = 1; i <= 20; i++) insertStall.run(i); });
  tx();
}

function seedContent(db) {
  const upsertCrop = db.prepare(`
    INSERT INTO crop_types (id, name, seed_cost, sell_price, xp_reward, growth_seconds, required_level, sprite)
    VALUES (@id, @name, @seed_cost, @sell_price, @xp_reward, @growth_seconds, @required_level, @sprite)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, seed_cost=excluded.seed_cost,
      sell_price=excluded.sell_price, xp_reward=excluded.xp_reward,
      growth_seconds=excluded.growth_seconds, required_level=excluded.required_level, sprite=excluded.sprite
  `);

  const crops = [
    { id: 'wheat',      name: 'Wheat',      seed_cost: 10,  sell_price: 22,  xp_reward: 3,  growth_seconds: 1200,   required_level: 1, sprite: 'wheat' },
    { id: 'rice',       name: 'Rice',       seed_cost: 18,  sell_price: 42,  xp_reward: 5,  growth_seconds: 3600,   required_level: 1, sprite: 'rice' },
    { id: 'corn',       name: 'Corn',       seed_cost: 20,  sell_price: 60,  xp_reward: 7,  growth_seconds: 10800,  required_level: 1, sprite: 'corn' },
    { id: 'carrot',     name: 'Carrot',     seed_cost: 15,  sell_price: 68,  xp_reward: 8,  growth_seconds: 18000,  required_level: 2, sprite: 'carrot' },
    { id: 'potato',     name: 'Potato',     seed_cost: 25,  sell_price: 150, xp_reward: 18, growth_seconds: 54000,  required_level: 2, sprite: 'potato' },
    { id: 'tomato',     name: 'Tomato',     seed_cost: 30,  sell_price: 190, xp_reward: 22, growth_seconds: 61200,  required_level: 3, sprite: 'tomato' },
    { id: 'strawberry', name: 'Strawberry', seed_cost: 40,  sell_price: 320, xp_reward: 38, growth_seconds: 86400,  required_level: 4, sprite: 'strawberry' },
    { id: 'pumpkin',    name: 'Pumpkin',    seed_cost: 60,  sell_price: 600, xp_reward: 70, growth_seconds: 172800, required_level: 5, sprite: 'pumpkin' },
  ];
  const txCrops = db.transaction((rows) => rows.forEach((r) => upsertCrop.run(r)));
  txCrops(crops);

  const upsertBuilding = db.prepare(`
    INSERT INTO building_types (id, name, cost, required_level, width, height, sprite, category)
    VALUES (@id, @name, @cost, @required_level, @width, @height, @sprite, @category)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, cost=excluded.cost,
      required_level=excluded.required_level, width=excluded.width, height=excluded.height,
      sprite=excluded.sprite, category=excluded.category
  `);
  const buildings = [
    { id: 'farmhouse',    name: 'Farmhouse',    cost: 0,    required_level: 1, width: 2, height: 2, sprite: 'farmhouse', category: 'building' },
    { id: 'barn',         name: 'Barn',         cost: 800,  required_level: 3, width: 3, height: 2, sprite: 'barn', category: 'building' },
    { id: 'silo',         name: 'Silo',         cost: 600,  required_level: 4, width: 1, height: 2, sprite: 'silo', category: 'building' },
    { id: 'well',         name: 'Well',         cost: 300,  required_level: 2, width: 1, height: 1, sprite: 'well', category: 'building' },
    { id: 'market_stall', name: 'Market Stall', cost: 500,  required_level: 3, width: 2, height: 2, sprite: 'market', category: 'building' },
    { id: 'storage_shed', name: 'Storage Shed', cost: 450,  required_level: 2, width: 2, height: 2, sprite: 'storage', category: 'building' },
    { id: 'chicken_coop', name: 'Chicken Coop', cost: 350,  required_level: 2, width: 2, height: 2, sprite: 'coop', category: 'building' },
    { id: 'cow_barn',     name: 'Cow Barn',     cost: 900,  required_level: 5, width: 3, height: 2, sprite: 'cowbarn', category: 'building' },
    { id: 'workshop',     name: 'Workshop',     cost: 700,  required_level: 4, width: 2, height: 2, sprite: 'workshop', category: 'building' },
  ];
  const txBuildings = db.transaction((rows) => rows.forEach((r) => upsertBuilding.run(r)));
  txBuildings(buildings);

  const upsertDeco = db.prepare(`
    INSERT INTO decoration_types (id, name, cost, required_level, width, height, sprite, growable, growth_seconds)
    VALUES (@id, @name, @cost, @required_level, @width, @height, @sprite, @growable, @growth_seconds)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, cost=excluded.cost,
      required_level=excluded.required_level, width=excluded.width, height=excluded.height, sprite=excluded.sprite,
      growable=excluded.growable, growth_seconds=excluded.growth_seconds
  `);
  const decorations = [
    { id: 'fence',      name: 'Fence',       cost: 5,   required_level: 1, width: 1, height: 1, sprite: 'fence', growable: 0, growth_seconds: 0 },
    { id: 'tree',       name: 'Tree',        cost: 50,  required_level: 1, width: 1, height: 1, sprite: 'tree', growable: 1, growth_seconds: 172800 }, // 2 days as a sapling before it's a full tree
    { id: 'flower',     name: 'Flower Bed',  cost: 20,  required_level: 1, width: 1, height: 1, sprite: 'flower', growable: 0, growth_seconds: 0 },
    { id: 'bush',       name: 'Bush',        cost: 15,  required_level: 1, width: 1, height: 1, sprite: 'bush', growable: 0, growth_seconds: 0 },
    { id: 'hay_bale',   name: 'Hay Bale',    cost: 10,  required_level: 1, width: 1, height: 1, sprite: 'hay', growable: 0, growth_seconds: 0 },
    { id: 'bench',      name: 'Bench',       cost: 40,  required_level: 2, width: 1, height: 1, sprite: 'bench', growable: 0, growth_seconds: 0 },
    { id: 'crafted_bench', name: 'Crafted Bench', cost: 0, required_level: 1, width: 1, height: 1, sprite: 'bench', growable: 0, growth_seconds: 0 },
    { id: 'lamp',       name: 'Lamp Post',   cost: 60,  required_level: 2, width: 1, height: 1, sprite: 'lamp', growable: 0, growth_seconds: 0 },
    { id: 'sign',       name: 'Sign',        cost: 25,  required_level: 1, width: 1, height: 1, sprite: 'sign', growable: 0, growth_seconds: 0 },
    { id: 'path',       name: 'Path Tile',   cost: 8,   required_level: 1, width: 1, height: 1, sprite: 'path', growable: 0, growth_seconds: 0 },
    { id: 'pond',       name: 'Pond',        cost: 150, required_level: 3, width: 2, height: 2, sprite: 'pond', growable: 0, growth_seconds: 0 },
  ];
  const txDeco = db.transaction((rows) => rows.forEach((r) => upsertDeco.run(r)));
  txDeco(decorations);

  const upsertAnimal = db.prepare(`
    INSERT INTO animal_types (id, name, cost, required_level, product_item_id, production_seconds, sprite)
    VALUES (@id, @name, @cost, @required_level, @product_item_id, @production_seconds, @sprite)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, cost=excluded.cost,
      required_level=excluded.required_level, product_item_id=excluded.product_item_id,
      production_seconds=excluded.production_seconds, sprite=excluded.sprite
  `);
  const animals = [
    { id: 'chicken', name: 'Chicken', cost: 100, required_level: 2, product_item_id: 'egg',   production_seconds: 6 * 3600,  sprite: 'chicken' },
    { id: 'cow',     name: 'Cow',     cost: 400, required_level: 5, product_item_id: 'milk',  production_seconds: 9 * 3600, sprite: 'cow' },
    { id: 'sheep',   name: 'Sheep',   cost: 300, required_level: 4, product_item_id: 'wool',  production_seconds: 8 * 3600, sprite: 'sheep' },
    { id: 'pig',     name: 'Pig',     cost: 250, required_level: 3, product_item_id: 'truffle', production_seconds: 7 * 3600, sprite: 'pig' },
  ];
  const txAnimals = db.transaction((rows) => rows.forEach((r) => upsertAnimal.run(r)));
  txAnimals(animals);

  const upsertItem = db.prepare(`
    INSERT INTO item_types (id, name, sell_price, sprite, category)
    VALUES (@id, @name, @sell_price, @sprite, @category)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, sell_price=excluded.sell_price,
      sprite=excluded.sprite, category=excluded.category
  `);
  const items = [
    { id: 'egg',      name: 'Egg',      sell_price: 12, sprite: 'egg', category: 'animal_product' },
    { id: 'milk',     name: 'Milk',     sell_price: 45, sprite: 'milk', category: 'animal_product' },
    { id: 'wool',     name: 'Wool',     sell_price: 38, sprite: 'wool', category: 'animal_product' },
    { id: 'truffle',  name: 'Truffle',  sell_price: 60, sprite: 'truffle', category: 'animal_product' },
    { id: 'log',      name: 'Log',      sell_price: 25, sprite: 'log', category: 'material' },
    { id: 'chicken_feed', name: 'Chicken Feed', sell_price: 3, sprite: 'feed', category: 'feed' },
    { id: 'cow_feed',     name: 'Cow Feed',     sell_price: 6, sprite: 'feed', category: 'feed' },
    { id: 'sheep_feed',   name: 'Sheep Feed',   sell_price: 5, sprite: 'feed', category: 'feed' },
    { id: 'pig_feed',     name: 'Pig Feed',     sell_price: 7, sprite: 'feed', category: 'feed' },
    { id: 'bread',            name: 'Bread',            sell_price: 5,  sprite: 'food', category: 'food' },
    { id: 'rice_bowl',        name: 'Rice Bowl',        sell_price: 9,  sprite: 'food', category: 'food' },
    { id: 'corn_soup',        name: 'Corn Soup',        sell_price: 13, sprite: 'food', category: 'food' },
    { id: 'carrot_stew',      name: 'Carrot Stew',      sell_price: 15, sprite: 'food', category: 'food' },
    { id: 'mashed_potato',    name: 'Mashed Potato',    sell_price: 30, sprite: 'food', category: 'food' },
    { id: 'tomato_soup',      name: 'Tomato Soup',      sell_price: 38, sprite: 'food', category: 'food' },
    { id: 'strawberry_cake',  name: 'Strawberry Cake',  sell_price: 65, sprite: 'food', category: 'food' },
    { id: 'pumpkin_pie',      name: 'Pumpkin Pie',      sell_price: 120, sprite: 'food', category: 'food' },
    { id: 'ice_cream',        name: 'Ice Cream',        sell_price: 0,   sprite: 'food', category: 'food' },
    { id: 'hotdog',           name: 'Hotdog',           sell_price: 0,   sprite: 'food', category: 'food' },
    { id: 'fried_egg',        name: 'Fried Egg',        sell_price: 20,  sprite: 'food', category: 'food' },
    { id: 'milkshake',        name: 'Milkshake',        sell_price: 55,  sprite: 'food', category: 'food' },
    { id: 'truffle_dish',     name: 'Truffle Dish',     sell_price: 140, sprite: 'food', category: 'food' },
  ];
  const txItems = db.transaction((rows) => rows.forEach((r) => upsertItem.run(r)));
  txItems(items);

  const upsertOutfit = db.prepare(`
    INSERT INTO outfit_types (id, name, cost, required_level, gender, shirt_color, pants_color, hat_color, style, sprite_key)
    VALUES (@id, @name, @cost, @required_level, @gender, @shirt_color, @pants_color, @hat_color, @style, @sprite_key)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, cost=excluded.cost, required_level=excluded.required_level,
      gender=excluded.gender, shirt_color=excluded.shirt_color, pants_color=excluded.pants_color,
      hat_color=excluded.hat_color, style=excluded.style, sprite_key=excluded.sprite_key
  `);
  // sprite_key selects which character sprite set to actually draw (see
  // public/assets/characters/) — only outfits with a real matching sprite
  // set look different in-game; others fall back to 'classic' (the default
  // look) since there's no artwork for them yet, rather than pretending.
  const outfits = [
    { id: 'classic_overalls', name: 'Classic Farmer', cost: 0,   required_level: 1, gender: 'unisex', shirt_color: '#4f8fd6', pants_color: '#3f5f8a', hat_color: '#e0b060', style: 'shirt', sprite_key: 'classic' },
    { id: 'green_flannel',    name: 'Green Flannel',   cost: 25, required_level: 1, gender: 'unisex', shirt_color: '#4f7c3a', pants_color: '#3f5f8a', hat_color: '#e0b060', style: 'shirt', sprite_key: 'green' },
    { id: 'red_flannel',      name: 'Red Flannel',      cost: 25, required_level: 2, gender: 'male',   shirt_color: '#c0392b', pants_color: '#4a3521', hat_color: '#e0b060', style: 'shirt', sprite_key: 'classic' },
    { id: 'blue_dungarees',   name: 'Blue Dungarees',   cost: 25, required_level: 2, gender: 'male',   shirt_color: '#f4f4f4', pants_color: '#4066a8', hat_color: '#e0b060', style: 'overalls', sprite_key: 'classic' },
    { id: 'meadow_dress',     name: 'Meadow Dress',     cost: 25, required_level: 2, gender: 'female', shirt_color: '#e05a7e', pants_color: '#e05a7e', hat_color: '#e0b060', style: 'dress', sprite_key: 'classic' },
    { id: 'sunflower_dress',  name: 'Sunflower Dress',  cost: 180, required_level: 3, gender: 'female', shirt_color: '#f4c95d', pants_color: '#f4c95d', hat_color: '#e0b060', style: 'dress', sprite_key: 'classic' },
    { id: 'straw_worker',     name: 'Straw Worker Set', cost: 220, required_level: 3, gender: 'unisex', shirt_color: '#7a9c5a', pants_color: '#5e5140', hat_color: '#c9a13c', style: 'overalls', sprite_key: 'classic' },
    { id: 'harvest_gold',     name: 'Harvest Gold Vest', cost: 300, required_level: 5, gender: 'unisex', shirt_color: '#e8a527', pants_color: '#4a3521', hat_color: '#8a5a34', style: 'shirt', sprite_key: 'classic' },
    { id: 'gentleman_suit',   name: 'Gentleman / Gentlewoman', cost: 25, required_level: 4, gender: 'unisex', shirt_color: '#fdf6e8', pants_color: '#4a3521', hat_color: '#6b4423', style: 'shirt', sprite_key: 'gentleman' },
    { id: 'winter_coat',      name: 'Winter Coat',      cost: 25, required_level: 4, gender: 'unisex', shirt_color: '#2b4a7a', pants_color: '#2b4a7a', hat_color: '#2b4a7a', style: 'shirt', sprite_key: 'winter' },
    { id: 'festival_yukata',  name: 'Festival Yukata',   cost: 25, required_level: 4, gender: 'unisex', shirt_color: '#1e2f5c', pants_color: '#1e2f5c', hat_color: '#c0392b', style: 'shirt', sprite_key: 'festival' },
  ];
  const txOutfits = db.transaction((rows) => rows.forEach((r) => upsertOutfit.run(r)));
  txOutfits(outfits);

  const upsertInterior = db.prepare(`
    INSERT INTO interior_types (id, name, cost, required_level, width, height, sprite)
    VALUES (@id, @name, @cost, @required_level, @width, @height, @sprite)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, cost=excluded.cost,
      required_level=excluded.required_level, width=excluded.width, height=excluded.height, sprite=excluded.sprite
  `);
  const interiorItems = [
    { id: 'rug',       name: 'Rug',           cost: 40,  required_level: 1, width: 2, height: 1, sprite: 'rug' },
    { id: 'table',     name: 'Dining Table',  cost: 90,  required_level: 1, width: 2, height: 1, sprite: 'table' },
    { id: 'chair',     name: 'Chair',         cost: 30,  required_level: 1, width: 1, height: 1, sprite: 'chair' },
    { id: 'cabinet',   name: 'Cabinet',       cost: 110, required_level: 2, width: 1, height: 1, sprite: 'cabinet' },
    { id: 'bed',       name: 'Bed',           cost: 150, required_level: 1, width: 2, height: 1, sprite: 'bed' },
    { id: 'potted_plant', name: 'Potted Plant', cost: 35, required_level: 1, width: 1, height: 1, sprite: 'potted_plant' },
    { id: 'painting',  name: 'Painting',      cost: 60,  required_level: 2, width: 1, height: 1, sprite: 'painting' },
    { id: 'fireplace', name: 'Fireplace',     cost: 200, required_level: 3, width: 1, height: 1, sprite: 'fireplace' },
    { id: 'stove',     name: 'Stove',         cost: 250, required_level: 1, width: 1, height: 1, sprite: 'stove' },
    { id: 'bookshelf', name: 'Bookshelf',     cost: 130, required_level: 2, width: 1, height: 1, sprite: 'bookshelf' },
    // Workshop-crafted furniture — never bought with coins in the Shop
    // (cost: 0, and hidden from the Shop's Interior tab in ui.js), made
    // instead from Wood at the Workshop building. Same look as their
    // store-bought counterparts (reuses the sprite) but a distinct id/name
    // ("Crafted Bed" etc.) so they're tellable apart, and — unlike regular
    // store-bought furniture — sellable at a Marketplace stall. The bench
    // is NOT here — it stays an outdoor decoration like the regular bench,
    // not indoor-only furniture; its crafted version lives in
    // decoration_types instead.
    { id: 'crafted_chair',     name: 'Crafted Chair',     cost: 0, required_level: 1, width: 1, height: 1, sprite: 'chair' },
    { id: 'crafted_bed',       name: 'Crafted Bed',       cost: 0, required_level: 1, width: 2, height: 1, sprite: 'bed' },
    { id: 'crafted_cabinet',   name: 'Crafted Cabinet',   cost: 0, required_level: 1, width: 1, height: 1, sprite: 'cabinet' },
    { id: 'crafted_bookshelf', name: 'Crafted Bookshelf', cost: 0, required_level: 1, width: 1, height: 1, sprite: 'bookshelf' },
  ];
  const txInterior = db.transaction((rows) => rows.forEach((r) => upsertInterior.run(r)));
  txInterior(interiorItems);
}

function getDb() {
  const fs = require('fs');
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // If an admin uploaded a backup via the admin panel's Restore feature,
  // it's waiting here as a "pending" file rather than having overwritten
  // the live DB directly — swapping it in only at startup (before any
  // connection is open) is the one moment this can never corrupt anything.
  // The previous live file is kept as a .pre-restore-backup safety net.
  const pendingRestorePath = DB_PATH + '.restore-pending';
  if (fs.existsSync(pendingRestorePath)) {
    if (fs.existsSync(DB_PATH)) {
      fs.copyFileSync(DB_PATH, DB_PATH + '.pre-restore-backup');
    }
    // journal_mode is WAL (see migrate() below), which means recent writes
    // can still be sitting in a `-wal` sidecar file rather than the main
    // .db file yet. Swapping the main file alone but leaving the OLD
    // database's stale -wal/-shm behind meant SQLite replayed that old,
    // stale WAL into the freshly-restored file on open — silently undoing
    // the restore back to the pre-restore state. Both must go.
    for (const suffix of ['-wal', '-shm']) {
      try { fs.unlinkSync(DB_PATH + suffix); } catch (e) { /* fine if it didn't exist */ }
    }
    fs.renameSync(pendingRestorePath, DB_PATH);
    console.log('Restored database from an uploaded backup (previous live file saved as .pre-restore-backup).');
  }

  const db = new Database(DB_PATH);
  migrate(db);
  return db;
}

if (require.main === module) {
  const db = getDb();
  console.log('Migration + seed complete at', DB_PATH);
  db.close();
}

module.exports = { getDb, DB_PATH };
