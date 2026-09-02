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
    gm_points INTEGER NOT NULL DEFAULT 0, -- rare currency ONLY an admin can grant (see admin panel > give GM Points) — used exclusively for Special Outfits (see outfit_types.currency)
    energy INTEGER NOT NULL DEFAULT 1000,
    energy_updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    is_admin INTEGER NOT NULL DEFAULT 0,
    is_banned INTEGER NOT NULL DEFAULT 0,
    suspended_until INTEGER, -- unix timestamp; NULL = not suspended. Temporary, unlike is_banned (permanent).
    is_resting INTEGER NOT NULL DEFAULT 0, -- sitting/lying on furniture — regenerates energy faster while true
    session_version INTEGER NOT NULL DEFAULT 0, -- bumps on every GAME login; a JWT with a stale version is a logged-out-elsewhere session
    admin_session_version INTEGER NOT NULL DEFAULT 0, -- separate counter for the admin PANEL specifically — an admin logging into the game and the admin panel with the same account no longer kick each other out, since each has its own slot
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
    is_event_place INTEGER NOT NULL DEFAULT 0, -- at most one farm has this set — see /api/admin/set-event-place; everyone can visit it like the Market/Park, but only its owner (an admin) can place/build there, same as any other farm's owner-only placement rule
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
    growth_seconds INTEGER NOT NULL DEFAULT 0,
    -- Fruit trees only (Mango/Apple/Avocado) — NULL/0 for every other
    -- decoration. Once mature (growable's growth_seconds elapsed), a fruit
    -- tree produces produces_item_id every production_seconds, has to be
    -- collected within fruit_spoil_seconds of becoming ready or that
    -- batch rots, and the whole tree dies once lifespan_seconds have
    -- passed since it matured — see resolveFruitTreeSpoilage/
    -- resolveFruitTreeDeaths in server/lib/gameLogic.js.
    produces_item_id TEXT,
    production_seconds INTEGER NOT NULL DEFAULT 0,
    fruit_spoil_seconds INTEGER NOT NULL DEFAULT 0,
    lifespan_seconds INTEGER NOT NULL DEFAULT 0,
    yield_min INTEGER NOT NULL DEFAULT 0,
    yield_max INTEGER NOT NULL DEFAULT 0
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
    category TEXT NOT NULL DEFAULT 'produce',
    -- Only meaningful for food/snacks (category 'food', plus Ice Cream/
    -- Hot Dog) — how much Energy eating one restores. 0 for everything
    -- else. Admin-editable via Shop Prices (PRICE_TABLES) alongside
    -- sell_price, even though it isn't itself a price — see
    -- /api/farm/eat, which reads this instead of a hardcoded value.
    energy_restore INTEGER NOT NULL DEFAULT 0,
    -- Only meaningful for a small set of BUYABLE consumable tools (the
    -- Megaphone so far) — 0 for everything else, which is never directly
    -- purchasable here (crops/decorations/etc. all have their own cost
    -- column on their own tables; this is specifically for stackable
    -- Bag items that don't fit any of those). See /api/shop/buy-tool.
    cost INTEGER NOT NULL DEFAULT 0
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
    sprite_key TEXT NOT NULL DEFAULT 'classic', -- which character sprite set to use (see public/assets/characters/)
    currency TEXT NOT NULL DEFAULT 'premium', -- 'premium' (Premium Points, anyone can earn/buy) | 'gm_points' (Special Outfits — an admin has to grant these first, see the admin panel)
    rental_days INTEGER NOT NULL DEFAULT 7 -- how long one purchase/renewal lasts before it expires (Special Outfits use 14)
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
  -- listing_type distinguishes an ordinary stackable inventory item ('item',
  -- the default) from a costume ('outfit') — a costume listing is always
  -- quantity 1 (owned_outfits only ever holds one of a given costume per
  -- player) and carries its OWN expires_at, since a costume's 7-day rental
  -- clock keeps running the whole time it's sitting in a stall — see
  -- server/routes/marketplace.js for the full listing/buying logic.
  CREATE TABLE IF NOT EXISTS marketplace_listings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stall_id INTEGER NOT NULL REFERENCES marketplace_stalls(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    price INTEGER NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0,
    listing_type TEXT NOT NULL DEFAULT 'item',
    expires_at INTEGER,
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

  -- Small key/value store for global, admin-tunable game rules that aren't
  -- tied to any single catalog item (e.g. the animal starve timer, which
  -- applies to every animal type rather than living on animal_types). Value
  -- is always an integer number of seconds. Missing key = fall back to the
  -- hardcoded default in gameLogic.js, so this table only needs a row once
  -- an admin actually changes something away from default.
  CREATE TABLE IF NOT EXISTS game_settings (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );

  -- One frozen "Most Rich" ranking per calendar day (server date, same
  -- YYYY-MM-DD convention as daily_rewards_claimed above) — recomputed
  -- lazily on the FIRST leaderboard request after midnight (see
  -- getLeaderboard in server/routes/player.js), not on every request, so
  -- the ranking only ever changes once a day instead of shifting live as
  -- people earn/spend coins.
  CREATE TABLE IF NOT EXISTS leaderboard_snapshot (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_date TEXT NOT NULL,
    rank INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    coins INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_leaderboard_date ON leaderboard_snapshot(snapshot_date);

  -- Optional per-item purchase cap for the Shop (seeds, buildings,
  -- decorations, animals, interiors) — a GLOBAL count shared by every
  -- player, not a per-player limit. Absence of a row for a given
  -- (category, item_id) means "unlimited", same as before this feature
  -- existed — an admin only needs to add a row for the specific items
  -- they actually want to cap. max_stock is the cap "Renew" resets back
  -- to; current_stock is what's actually left to buy right now.
  CREATE TABLE IF NOT EXISTS shop_stock (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL, -- 'crop' | 'building' | 'decoration' | 'animal' | 'interior'
    item_id TEXT NOT NULL,
    max_stock INTEGER NOT NULL,
    current_stock INTEGER NOT NULL,
    UNIQUE(category, item_id)
  );

  -- Separate cold storage for cooking ingredients, distinct from the Bag
  -- (the 'inventory' table) — lets crops/animal products used for cooking
  -- live in the Refrigerator instead of cluttering the Bag. The Stove's
  -- /api/farm/cook route draws from here FIRST, then the Bag, for
  -- whichever ingredient a recipe calls for.
  CREATE TABLE IF NOT EXISTS fridge_storage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    item_id TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0,
    UNIQUE(user_id, item_id)
  );
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
  if (!existingCols.includes('session_version')) {
    db.exec('ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0');
  }
  if (!existingCols.includes('admin_session_version')) {
    db.exec('ALTER TABLE users ADD COLUMN admin_session_version INTEGER NOT NULL DEFAULT 0');
  }
  if (!existingCols.includes('friend_water_count')) {
    db.exec('ALTER TABLE users ADD COLUMN friend_water_count INTEGER NOT NULL DEFAULT 0');
  }
  if (!existingCols.includes('friend_water_date')) {
    db.exec('ALTER TABLE users ADD COLUMN friend_water_date TEXT');
  }
  const farmCols = db.prepare("PRAGMA table_info(farms)").all().map((c) => c.name);
  if (!farmCols.includes('is_event_place')) {
    db.exec('ALTER TABLE farms ADD COLUMN is_event_place INTEGER NOT NULL DEFAULT 0');
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
  const marketplaceListingCols = db.prepare("PRAGMA table_info(marketplace_listings)").all().map((c) => c.name);
  if (!marketplaceListingCols.includes('listing_type')) {
    db.exec("ALTER TABLE marketplace_listings ADD COLUMN listing_type TEXT NOT NULL DEFAULT 'item'");
  }
  if (!marketplaceListingCols.includes('expires_at')) {
    db.exec('ALTER TABLE marketplace_listings ADD COLUMN expires_at INTEGER');
  }
  if (!existingCols.includes('gm_points')) {
    db.exec('ALTER TABLE users ADD COLUMN gm_points INTEGER NOT NULL DEFAULT 0');
  }
  const outfitTypeCols = db.prepare("PRAGMA table_info(outfit_types)").all().map((c) => c.name);
  if (!outfitTypeCols.includes('currency')) {
    db.exec("ALTER TABLE outfit_types ADD COLUMN currency TEXT NOT NULL DEFAULT 'premium'");
  }
  if (!outfitTypeCols.includes('rental_days')) {
    db.exec('ALTER TABLE outfit_types ADD COLUMN rental_days INTEGER NOT NULL DEFAULT 7');
  }
  const decorationTypeCols = db.prepare("PRAGMA table_info(decoration_types)").all().map((c) => c.name);
  const decorationNewCols = {
    produces_item_id: 'TEXT', production_seconds: 'INTEGER NOT NULL DEFAULT 0',
    fruit_spoil_seconds: 'INTEGER NOT NULL DEFAULT 0', lifespan_seconds: 'INTEGER NOT NULL DEFAULT 0',
    yield_min: 'INTEGER NOT NULL DEFAULT 0', yield_max: 'INTEGER NOT NULL DEFAULT 0',
  };
  for (const [col, type] of Object.entries(decorationNewCols)) {
    if (!decorationTypeCols.includes(col)) db.exec(`ALTER TABLE decoration_types ADD COLUMN ${col} ${type}`);
  }
  const itemTypeCols = db.prepare("PRAGMA table_info(item_types)").all().map((c) => c.name);
  if (!itemTypeCols.includes('energy_restore')) {
    db.exec('ALTER TABLE item_types ADD COLUMN energy_restore INTEGER NOT NULL DEFAULT 0');
  }
  if (!itemTypeCols.includes('cost')) {
    db.exec('ALTER TABLE item_types ADD COLUMN cost INTEGER NOT NULL DEFAULT 0');
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
    ON CONFLICT(id) DO NOTHING
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
    ON CONFLICT(id) DO NOTHING
  `);
  const buildings = [
    { id: 'farmhouse',    name: 'House',        cost: 100000, required_level: 1, width: 2, height: 2, sprite: 'farmhouse', category: 'building' },
    { id: 'mansion',      name: 'Mansion',       cost: 10000000, required_level: 1, width: 7, height: 4, sprite: 'mansion', category: 'building' },
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
    INSERT INTO decoration_types (id, name, cost, required_level, width, height, sprite, growable, growth_seconds,
      produces_item_id, production_seconds, fruit_spoil_seconds, lifespan_seconds, yield_min, yield_max)
    VALUES (@id, @name, @cost, @required_level, @width, @height, @sprite, @growable, @growth_seconds,
      @produces_item_id, @production_seconds, @fruit_spoil_seconds, @lifespan_seconds, @yield_min, @yield_max)
    ON CONFLICT(id) DO NOTHING
  `);
  // Fruit-tree-only fields default to "not a fruit tree" (0/null) for
  // every other decoration — filled in here so each row below only needs
  // to specify them when it actually IS a fruit tree, instead of every
  // existing decoration needing 6 new boilerplate fields added.
  const DECORATION_DEFAULTS = { produces_item_id: null, production_seconds: 0, fruit_spoil_seconds: 0, lifespan_seconds: 0, yield_min: 0, yield_max: 0 };
  const decorations = [
    { id: 'fence',      name: 'Fence',       cost: 5,   required_level: 1, width: 1, height: 1, sprite: 'fence', growable: 0, growth_seconds: 0 },
    { id: 'tree',       name: 'Tree',        cost: 50,  required_level: 1, width: 1, height: 1, sprite: 'tree', growable: 1, growth_seconds: 172800 }, // 2 days as a sapling before it's a full tree
    { id: 'flower',     name: 'Flower Bed',  cost: 20,  required_level: 1, width: 1, height: 1, sprite: 'flower', growable: 0, growth_seconds: 0 },
    { id: 'bush',       name: 'Bush',        cost: 15,  required_level: 1, width: 1, height: 1, sprite: 'bush', growable: 0, growth_seconds: 0 },
    { id: 'hay_bale',   name: 'Hay Bale',    cost: 10,  required_level: 1, width: 1, height: 1, sprite: 'hay', growable: 0, growth_seconds: 0 },
    { id: 'bench',      name: 'Bench',       cost: 40,  required_level: 2, width: 1, height: 1, sprite: 'bench', growable: 0, growth_seconds: 0 },
    { id: 'crafted_bench', name: 'Crafted Bench', cost: 0, required_level: 1, width: 1, height: 1, sprite: 'bench', growable: 0, growth_seconds: 0 },
    { id: 'lamp',       name: 'Lamp Post',   cost: 60,  required_level: 2, width: 1, height: 1, sprite: 'lamp', growable: 0, growth_seconds: 0 },
    // Keeps outdoor animals warm at night within a few tiles of it — see
    // resolveAnimalColdDeaths in server/lib/gameLogic.js. An animal kept
    // outdoors (not housed in a coop/barn) with no Bonfire nearby at
    // night, for too long, dies of cold — same as a coop/barn animal with
    // no Fireplace inside.
    { id: 'bonfire',    name: 'Bonfire',     cost: 80,  required_level: 1, width: 1, height: 1, sprite: 'bonfire', growable: 0, growth_seconds: 0 },
    { id: 'sign',       name: 'Sign',        cost: 25,  required_level: 1, width: 1, height: 1, sprite: 'sign', growable: 0, growth_seconds: 0 },
    { id: 'path',       name: 'Path Tile',   cost: 8,   required_level: 1, width: 1, height: 1, sprite: 'path', growable: 0, growth_seconds: 0 },
    { id: 'pond',       name: 'Pond',        cost: 150, required_level: 3, width: 2, height: 2, sprite: 'pond', growable: 0, growth_seconds: 0 },
    // Fruit trees — grow like the plain Tree above (1 day to mature,
    // faster with watering, same as any other growable), but unlike it,
    // stay alive afterward producing fruit every 6 hours (yield 5-15,
    // random) for 5 days before dying of old age. Fruit left uncollected
    // for more than 1 hour after becoming ready rots and is lost — see
    // resolveFruitTreeSpoilage/resolveFruitTreeDeaths in gameLogic.js.
    { id: 'mango_tree',   name: 'Mango Tree',   cost: 1500, required_level: 1, width: 1, height: 1, sprite: 'mango_tree',
      growable: 1, growth_seconds: 86400, produces_item_id: 'mango', production_seconds: 21600, fruit_spoil_seconds: 3600, lifespan_seconds: 432000, yield_min: 5, yield_max: 15 },
    { id: 'apple_tree',   name: 'Apple Tree',   cost: 2500, required_level: 1, width: 1, height: 1, sprite: 'apple_tree',
      growable: 1, growth_seconds: 86400, produces_item_id: 'apple', production_seconds: 21600, fruit_spoil_seconds: 3600, lifespan_seconds: 432000, yield_min: 5, yield_max: 15 },
    { id: 'avocado_tree', name: 'Avocado Tree', cost: 3500, required_level: 1, width: 1, height: 1, sprite: 'avocado_tree',
      growable: 1, growth_seconds: 86400, produces_item_id: 'avocado', production_seconds: 21600, fruit_spoil_seconds: 3600, lifespan_seconds: 432000, yield_min: 5, yield_max: 15 },
  ].map((d) => ({ ...DECORATION_DEFAULTS, ...d }));
  const txDeco = db.transaction((rows) => rows.forEach((r) => upsertDeco.run(r)));
  txDeco(decorations);

  const upsertAnimal = db.prepare(`
    INSERT INTO animal_types (id, name, cost, required_level, product_item_id, production_seconds, sprite)
    VALUES (@id, @name, @cost, @required_level, @product_item_id, @production_seconds, @sprite)
    ON CONFLICT(id) DO NOTHING
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
    INSERT INTO item_types (id, name, sell_price, sprite, category, energy_restore, cost)
    VALUES (@id, @name, @sell_price, @sprite, @category, @energy_restore, @cost)
    ON CONFLICT(id) DO NOTHING
  `);
  const items = [
    { id: 'egg',      name: 'Egg',      sell_price: 12, sprite: 'egg', category: 'animal_product' },
    { id: 'milk',     name: 'Milk',     sell_price: 45, sprite: 'milk', category: 'animal_product' },
    { id: 'wool',     name: 'Wool',     sell_price: 38, sprite: 'wool', category: 'animal_product' },
    { id: 'truffle',  name: 'Truffle',  sell_price: 60, sprite: 'truffle', category: 'animal_product' },
    { id: 'mango',    name: 'Mango',    sell_price: 20, sprite: 'mango', category: 'fruit' },
    { id: 'apple',    name: 'Apple',    sell_price: 35, sprite: 'apple', category: 'fruit' },
    { id: 'avocado',  name: 'Avocado',  sell_price: 45, sprite: 'avocado', category: 'fruit' },
    { id: 'log',      name: 'Log',      sell_price: 25, sprite: 'log', category: 'material' },
    { id: 'chicken_feed', name: 'Chicken Feed', sell_price: 3, sprite: 'feed', category: 'feed' },
    { id: 'cow_feed',     name: 'Cow Feed',     sell_price: 6, sprite: 'feed', category: 'feed' },
    { id: 'sheep_feed',   name: 'Sheep Feed',   sell_price: 5, sprite: 'feed', category: 'feed' },
    { id: 'pig_feed',     name: 'Pig Feed',     sell_price: 7, sprite: 'feed', category: 'feed' },
    // energy_restore is what /api/farm/eat actually grants — admin-editable
    // via Shop Prices alongside sell_price, see PRICE_TABLES in admin.js.
    { id: 'bread',            name: 'Bread',            sell_price: 5,  sprite: 'food', category: 'food', energy_restore: 5 },
    { id: 'rice_bowl',        name: 'Rice Bowl',        sell_price: 9,  sprite: 'food', category: 'food', energy_restore: 6 },
    { id: 'corn_soup',        name: 'Corn Soup',        sell_price: 13, sprite: 'food', category: 'food', energy_restore: 7 },
    { id: 'carrot_stew',      name: 'Carrot Stew',      sell_price: 15, sprite: 'food', category: 'food', energy_restore: 8 },
    { id: 'mashed_potato',    name: 'Mashed Potato',    sell_price: 30, sprite: 'food', category: 'food', energy_restore: 10 },
    { id: 'tomato_soup',      name: 'Tomato Soup',      sell_price: 38, sprite: 'food', category: 'food', energy_restore: 11 },
    { id: 'strawberry_cake',  name: 'Strawberry Cake',  sell_price: 65, sprite: 'food', category: 'food', energy_restore: 14 },
    { id: 'pumpkin_pie',      name: 'Pumpkin Pie',      sell_price: 120, sprite: 'food', category: 'food', energy_restore: 17 },
    { id: 'ice_cream',        name: 'Ice Cream',        sell_price: 0,   sprite: 'food', category: 'food', energy_restore: 5 },
    { id: 'hotdog',           name: 'Hotdog',           sell_price: 0,   sprite: 'food', category: 'food', energy_restore: 8 },
    { id: 'fried_egg',        name: 'Fried Egg',        sell_price: 20,  sprite: 'food', category: 'food', energy_restore: 6 },
    { id: 'milkshake',        name: 'Milkshake',        sell_price: 55,  sprite: 'food', category: 'food', energy_restore: 10 },
    { id: 'truffle_dish',     name: 'Truffle Dish',     sell_price: 140, sprite: 'food', category: 'food', energy_restore: 18 },
    // A rare, expensive multi-ingredient brew — see /api/farm/cook-energy-
    // potion (a dedicated route, not the single-ingredient COOK_RECIPES
    // system every other dish here uses) for the recipe and its
    // deliberately low success chance.
    { id: 'energy_potion',    name: 'Energy Potion',    sell_price: 1500, sprite: 'food', category: 'food', energy_restore: 600 },
    // A buyable consumable Tool, not food — see /api/shop/buy-tool and
    // /api/chat/shout. Not sellable back (sell_price 0), doesn't restore
    // energy — its whole purpose is being spent on a single Shout.
    { id: 'megaphone',        name: 'Megaphone',        sell_price: 0,   sprite: 'megaphone', category: 'tool', cost: 25000 },
  ].map((it) => ({ energy_restore: 0, cost: 0, ...it }));
  const txItems = db.transaction((rows) => rows.forEach((r) => upsertItem.run(r)));
  txItems(items);

  const upsertOutfit = db.prepare(`
    INSERT INTO outfit_types (id, name, cost, required_level, gender, shirt_color, pants_color, hat_color, style, sprite_key, currency, rental_days)
    VALUES (@id, @name, @cost, @required_level, @gender, @shirt_color, @pants_color, @hat_color, @style, @sprite_key, @currency, @rental_days)
    ON CONFLICT(id) DO NOTHING
  `);
  // sprite_key selects which character sprite set to actually draw (see
  // public/assets/characters/) — only outfits with a real matching sprite
  // set look different in-game; others fall back to 'classic' (the default
  // look) since there's no artwork for them yet, rather than pretending.
  // `currency`/`rental_days` default to the ordinary Premium-Points/7-day
  // rental every other costume uses — only set explicitly below for the
  // Special Outfits category (GM Points, 14-day rental, admin-granted only).
  const outfits = [
    { id: 'classic_overalls', name: 'Classic Farmer', cost: 0,   required_level: 1, gender: 'unisex', shirt_color: '#4f8fd6', pants_color: '#3f5f8a', hat_color: '#e0b060', style: 'shirt', sprite_key: 'classic', currency: 'premium', rental_days: 7 },
    { id: 'green_flannel',    name: 'Green Flannel',   cost: 25, required_level: 1, gender: 'unisex', shirt_color: '#4f7c3a', pants_color: '#3f5f8a', hat_color: '#e0b060', style: 'shirt', sprite_key: 'green', currency: 'premium', rental_days: 7 },
    { id: 'red_flannel',      name: 'Red Flannel',      cost: 25, required_level: 2, gender: 'male',   shirt_color: '#c0392b', pants_color: '#4a3521', hat_color: '#e0b060', style: 'shirt', sprite_key: 'classic', currency: 'premium', rental_days: 7 },
    { id: 'blue_dungarees',   name: 'Blue Dungarees',   cost: 25, required_level: 2, gender: 'male',   shirt_color: '#f4f4f4', pants_color: '#4066a8', hat_color: '#e0b060', style: 'overalls', sprite_key: 'classic', currency: 'premium', rental_days: 7 },
    { id: 'meadow_dress',     name: 'Meadow Dress',     cost: 25, required_level: 2, gender: 'female', shirt_color: '#e05a7e', pants_color: '#e05a7e', hat_color: '#e0b060', style: 'dress', sprite_key: 'classic', currency: 'premium', rental_days: 7 },
    { id: 'sunflower_dress',  name: 'Sunflower Dress',  cost: 180, required_level: 3, gender: 'female', shirt_color: '#f4c95d', pants_color: '#f4c95d', hat_color: '#e0b060', style: 'dress', sprite_key: 'classic', currency: 'premium', rental_days: 7 },
    { id: 'straw_worker',     name: 'Straw Worker Set', cost: 220, required_level: 3, gender: 'unisex', shirt_color: '#7a9c5a', pants_color: '#5e5140', hat_color: '#c9a13c', style: 'overalls', sprite_key: 'classic', currency: 'premium', rental_days: 7 },
    { id: 'harvest_gold',     name: 'Harvest Gold Vest', cost: 300, required_level: 5, gender: 'unisex', shirt_color: '#e8a527', pants_color: '#4a3521', hat_color: '#8a5a34', style: 'shirt', sprite_key: 'classic', currency: 'premium', rental_days: 7 },
    { id: 'gentleman_suit',   name: 'Gentleman / Gentlewoman', cost: 25, required_level: 4, gender: 'unisex', shirt_color: '#fdf6e8', pants_color: '#4a3521', hat_color: '#6b4423', style: 'shirt', sprite_key: 'gentleman', currency: 'premium', rental_days: 7 },
    { id: 'winter_coat',      name: 'Winter Coat',      cost: 25, required_level: 4, gender: 'unisex', shirt_color: '#2b4a7a', pants_color: '#2b4a7a', hat_color: '#2b4a7a', style: 'shirt', sprite_key: 'winter', currency: 'premium', rental_days: 7 },
    { id: 'festival_yukata',  name: 'Festival Yukata',   cost: 25, required_level: 4, gender: 'unisex', shirt_color: '#1e2f5c', pants_color: '#1e2f5c', hat_color: '#c0392b', style: 'shirt', sprite_key: 'festival', currency: 'premium', rental_days: 7 },
    // ---- Special Outfits — GM Points only, 1 point, 2-week (14-day) rental.
    // GM Points can ONLY be granted by an admin (Admin Panel > Give GM
    // Points) — there's no way to earn or buy them through normal play,
    // by design (see server/routes/admin.js's give-gm-points route).
    { id: 'lancer_costume',    name: 'Lancer',    cost: 1, required_level: 1, gender: 'unisex', shirt_color: '#1a2540', pants_color: '#0d1830', hat_color: '#3d8fe0', style: 'shirt', sprite_key: 'lancer', currency: 'gm_points', rental_days: 14 },
    { id: 'sorcerer_costume',  name: 'Sorcerer',  cost: 1, required_level: 1, gender: 'unisex', shirt_color: '#241332', pants_color: '#150a1f', hat_color: '#9b5fd9', style: 'shirt', sprite_key: 'sorcerer', currency: 'gm_points', rental_days: 14 },
    { id: 'swordsman_costume', name: 'Swordsman', cost: 1, required_level: 1, gender: 'unisex', shirt_color: '#1a1a2e', pants_color: '#0d0d1a', hat_color: '#f4c95d', style: 'shirt', sprite_key: 'swordsman', currency: 'gm_points', rental_days: 14 },
  ];
  const txOutfits = db.transaction((rows) => rows.forEach((r) => upsertOutfit.run(r)));
  txOutfits(outfits);

  const upsertInterior = db.prepare(`
    INSERT INTO interior_types (id, name, cost, required_level, width, height, sprite)
    VALUES (@id, @name, @cost, @required_level, @width, @height, @sprite)
    ON CONFLICT(id) DO NOTHING
  `);
  const interiorItems = [
    { id: 'rug',       name: 'Rug',           cost: 40,  required_level: 1, width: 2, height: 1, sprite: 'rug' },
    { id: 'table',     name: 'Dining Table',  cost: 90,  required_level: 1, width: 2, height: 1, sprite: 'table' },
    { id: 'chair',     name: 'Chair',         cost: 30,  required_level: 1, width: 1, height: 1, sprite: 'chair' },
    { id: 'cabinet',   name: 'Cabinet',       cost: 110, required_level: 2, width: 1, height: 1, sprite: 'cabinet' },
    // Tap it to see every costume you actually own and switch between
    // them — buying a costume in the Shop no longer wears it right away,
    // this is now the only place that does (see /api/shop/buy-outfit and
    // openClosetPanel in main.js).
    { id: 'closet',    name: 'Closet',        cost: 150, required_level: 1, width: 1, height: 1, sprite: 'closet' },
    // Cold storage for cooking ingredients, separate from the Bag — see
    // fridge_storage table + /api/player/fridge, /api/shop/fridge-deposit,
    // /api/shop/fridge-withdraw. The Stove pulls from here first when
    // cooking.
    { id: 'refrigerator', name: '2-Door Refrigerator', cost: 200, required_level: 1, width: 1, height: 1, sprite: 'refrigerator' },
    { id: 'bed',       name: 'Bed',           cost: 150, required_level: 1, width: 2, height: 1, sprite: 'bed' },
    { id: 'potted_plant', name: 'Potted Plant', cost: 35, required_level: 1, width: 1, height: 1, sprite: 'potted_plant' },
    { id: 'painting',  name: 'Painting',      cost: 60,  required_level: 2, width: 1, height: 1, sprite: 'painting' },
    { id: 'fireplace', name: 'Fireplace',     cost: 200, required_level: 3, width: 1, height: 1, sprite: 'fireplace' },
    { id: 'stove',     name: 'Stove',         cost: 250, required_level: 1, width: 1, height: 1, sprite: 'stove' },
    { id: 'bookshelf', name: 'Bookshelf',     cost: 130, required_level: 2, width: 1, height: 1, sprite: 'bookshelf' },
    { id: 'wall',       name: 'Wall',          cost: 20,  required_level: 1, width: 1, height: 1, sprite: 'wall' },
    { id: 'staircase',  name: 'Staircase',     cost: 500, required_level: 1, width: 1, height: 1, sprite: 'staircase' },
    // Wall/light decor — frame(s), a light source you can actually place
    // indoors (see the night-darkness punch-through logic in game.js's
    // _drawWeatherOverlay), a TV, an aircon unit, and a side table.
    { id: 'table_lamp', name: 'Table Lamp',    cost: 55,  required_level: 1, width: 1, height: 1, sprite: 'table_lamp' },
    { id: 'wall_light',  name: 'Wall Light',    cost: 65,  required_level: 2, width: 1, height: 1, sprite: 'wall_light' },
    { id: 'tv',          name: 'TV',            cost: 140, required_level: 2, width: 1, height: 1, sprite: 'tv' },
    { id: 'aircon',       name: 'Air Conditioner', cost: 160, required_level: 3, width: 1, height: 1, sprite: 'aircon' },
    { id: 'side_table',   name: 'Side Table',    cost: 45,  required_level: 1, width: 1, height: 1, sprite: 'side_table' },
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
