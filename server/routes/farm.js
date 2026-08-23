const express = require('express');
const {
  nowSec, resolveCropStates, resolveAnimalDeaths, grantRewards, addInventory, notify,
  resolveEnergy, spendEnergy, addEnergy, xpProgress, rollHarvestQuantity,
} = require('../lib/gameLogic');
const {
  INTERIOR_WIDTH, INTERIOR_HEIGHT, HOUSE_LOCATION,
  ENTERABLE_BUILDING_DIMENSIONS, BUILDING_FLOOR_COUNT, isEnterableBuildingType, locationForBuilding,
} = require('../lib/interiorSpaces');

const WATER_COST = 1; // coins per self-watering (smallest whole-coin stand-in for ~0.3 gold)
const FRIEND_WATER_COST = 3; // flat coins for helping water a friend's crop, every time

module.exports = function farmRoutes(db, io) {
  const router = express.Router();

  function getOwnFarm(userId) {
    return db.prepare('SELECT * FROM farms WHERE owner_id = ?').get(userId);
  }

  function serializeFarm(farm) {
    resolveCropStates(db, farm.id);
    resolveAnimalDeaths(db, farm.id);
    const tiles = db.prepare('SELECT x, y, state FROM farm_tiles WHERE farm_id = ?').all(farm.id);
    const crops = db.prepare('SELECT * FROM crops WHERE farm_id = ?').all(farm.id);
    const objects = db.prepare("SELECT * FROM farm_objects WHERE farm_id = ? AND location = 'outdoor'").all(farm.id).map(resolveObject);
    const owner = db.prepare('SELECT id, username, display_name, level, avatar FROM users WHERE id = ?').get(farm.owner_id);
    return {
      id: farm.id,
      ownerId: farm.owner_id,
      ownerUsername: owner.display_name || owner.username,
      ownerLevel: owner.level,
      ownerAvatar: owner.avatar,
      farmName: farm.farm_name,
      width: farm.width,
      height: farm.height,
      expansionLevel: farm.expansion_level,
      tiles,
      crops,
      objects,
      serverTime: nowSec(),
    };
  }

  // Animal objects carry production state in the `state` JSON column so we don't need
  // a separate table; resolve "ready to collect" here, at read time, using server time.
  function resolveObject(obj) {
    if (obj.object_type !== 'animal') return obj;
    const animalType = db.prepare('SELECT * FROM animal_types WHERE id = ?').get(obj.item_id);
    if (!animalType) return obj;
    const last = obj.last_collected_at || obj.created_at;
    const readyAt = last + animalType.production_seconds;
    return { ...obj, readyAt, ready: nowSec() >= readyAt };
  }

  // GET /api/farm/me - full state of the logged-in player's own farm
  router.get('/me', (req, res) => {
    const farm = getOwnFarm(req.userId);
    if (!farm) return res.status(404).json({ error: 'Farm not found' });
    res.json(serializeFarm(farm));
  });

  // ---- STORAGE SHED — a second item pool separate from the Bag, so you
  // can stash things there to declutter without losing them. No coin
  // cost either way (moving items around your own farm, not a trade).
  // Declared BEFORE the /:userId route below — that route's :userId param
  // would otherwise happily match the literal string "storage" too
  // (Express matches routes in declaration order), silently swallowing
  // every request to this path with a confusing "Farm not found".
  function addStorage(itemId, qty, userId) {
    const existing = db.prepare('SELECT * FROM storage_items WHERE user_id = ? AND item_id = ?').get(userId, itemId);
    if (existing) {
      db.prepare('UPDATE storage_items SET quantity = quantity + ? WHERE id = ?').run(qty, existing.id);
    } else {
      db.prepare('INSERT INTO storage_items (user_id, item_id, quantity) VALUES (?, ?, ?)').run(userId, itemId, qty);
    }
  }

  router.get('/storage', (req, res) => {
    const rows = db.prepare('SELECT item_id, quantity FROM storage_items WHERE user_id = ? AND quantity > 0').all(req.userId);
    res.json(rows);
  });

  router.post('/storage-deposit', (req, res) => {
    const { itemId, quantity } = req.body || {};
    const qty = parseInt(quantity, 10);
    if (!qty || qty < 1) return res.status(400).json({ error: 'Invalid quantity' });

    const invRow = db.prepare('SELECT * FROM inventory WHERE user_id = ? AND item_id = ?').get(req.userId, itemId);
    if (!invRow || invRow.quantity < qty) return res.status(400).json({ error: 'Not enough in your Bag' });

    db.prepare('UPDATE inventory SET quantity = quantity - ? WHERE id = ?').run(qty, invRow.id);
    addStorage(itemId, qty, req.userId);
    res.json({ ok: true, itemId, quantity: qty });
  });

  router.post('/storage-withdraw', (req, res) => {
    const { itemId, quantity } = req.body || {};
    const qty = parseInt(quantity, 10);
    if (!qty || qty < 1) return res.status(400).json({ error: 'Invalid quantity' });

    const storeRow = db.prepare('SELECT * FROM storage_items WHERE user_id = ? AND item_id = ?').get(req.userId, itemId);
    if (!storeRow || storeRow.quantity < qty) return res.status(400).json({ error: 'Not enough in storage' });

    db.prepare('UPDATE storage_items SET quantity = quantity - ? WHERE id = ?').run(qty, storeRow.id);
    addInventory(db, req.userId, itemId, qty);
    res.json({ ok: true, itemId, quantity: qty });
  });

  // GET /api/farm/event-place — find whichever farm is currently
  // designated the Event Place (see /api/admin/set-event-place), if any.
  // Anyone can call this (not just admins) — it's how the "Event Place"
  // toolbar button finds where to take you.
  router.get('/event-place', (req, res) => {
    const farm = db.prepare('SELECT * FROM farms WHERE is_event_place = 1').get();
    if (!farm) return res.status(404).json({ error: 'No Event Place has been set up yet' });
    const payload = serializeFarm(farm);
    payload.isOwner = farm.owner_id === req.userId;
    res.json(payload);
  });

  // GET /api/farm/:userId - view any player's farm (read-only visit)
  router.get('/:userId', (req, res) => {
    const targetId = parseInt(req.params.userId, 10);
    const farm = db.prepare('SELECT * FROM farms WHERE owner_id = ?').get(targetId);
    if (!farm) return res.status(404).json({ error: 'Farm not found' });
    const payload = serializeFarm(farm);
    payload.isOwner = targetId === req.userId;
    res.json(payload);
  });

  // Shared by /me/interior (viewing your own) and /:userId/interior
  // (visiting someone else's, read-only on the client side) — same rules
  // either way for WHICH room you can look into, since anyone can already
  // see a farm's outdoor layout without being friends with the owner.
  function handleInteriorRequest(req, res, farmOwnerId) {
    const farm = db.prepare('SELECT * FROM farms WHERE owner_id = ?').get(farmOwnerId);
    if (!farm) return res.status(404).json({ error: 'Farm not found' });
    resolveAnimalDeaths(db, farm.id); // covers animals in here too, not just outdoor — same farm_id either way

    const buildingId = parseInt(req.query.buildingId, 10);
    if (buildingId) {
      const building = db.prepare("SELECT * FROM farm_objects WHERE id = ? AND farm_id = ? AND object_type = 'building'")
        .get(buildingId, farm.id);
      if (!building) return res.status(404).json({ error: 'Building not found on that farm' });
      if (!isEnterableBuildingType(building.item_id)) {
        return res.status(400).json({ error: 'That building has no interior to enter' });
      }
      const maxFloor = BUILDING_FLOOR_COUNT[building.item_id] || 1;
      let floor = parseInt(req.query.floor, 10) || 1;
      if (floor < 1) floor = 1;
      if (floor > maxFloor) floor = maxFloor;
      const dims = ENTERABLE_BUILDING_DIMENSIONS[building.item_id];
      const location = locationForBuilding(building.id, floor);
      const objects = db.prepare('SELECT * FROM farm_objects WHERE farm_id = ? AND location = ?').all(farm.id, location);
      return res.json({
        width: dims.width, height: dims.height, location,
        buildingType: building.item_id, buildingId: building.id,
        floor, maxFloor,
        objects, serverTime: nowSec(),
      });
    }

    // Default / ?space=house — the singleton house interior.
    const objects = db.prepare('SELECT * FROM farm_objects WHERE farm_id = ? AND location = ?').all(farm.id, HOUSE_LOCATION);
    res.json({ width: INTERIOR_WIDTH, height: INTERIOR_HEIGHT, location: HOUSE_LOCATION, buildingType: 'farmhouse', objects, serverTime: nowSec() });
  }

  // GET /api/farm/me/interior?space=house|coop|barn - the interior of one
  // of the player's enterable buildings (defaults to the house for
  // backward compatibility with older clients).
  // GET /api/farm/me/interior?space=house — the house (singleton).
  // GET /api/farm/me/interior?buildingId=<farm_objects.id> — any other
  // enterable building (coop/barn/cow_barn); each specific building placed
  // has its own separate room, not shared with others of the same type.
  router.get('/me/interior', (req, res) => {
    handleInteriorRequest(req, res, req.userId);
  });

  // GET /api/farm/:userId/interior — same as above but for visiting
  // someone else's house/coop/barn/cow_barn. Read-only on the client side
  // (placing/moving/removing furniture and animals stays owner-only,
  // enforced separately in shop.js) — this route just lets a visitor SEE
  // what's inside, the same way they can already see the outdoor farm.
  router.get('/:userId/interior', (req, res) => {
    const targetId = parseInt(req.params.userId, 10);
    handleInteriorRequest(req, res, targetId);
  });

  // ---- PLOW (also doubles as UNDO PLOW: tapping an already-plowed, empty
  // tile reverts it to grass, in case a plow was placed by mistake) ----
  router.post('/plow', (req, res) => {
    const { x, y } = req.body || {};
    const farm = getOwnFarm(req.userId);
    if (!farm || !inBounds(farm, x, y)) return res.status(400).json({ error: 'Invalid tile' });

    const tile = db.prepare('SELECT * FROM farm_tiles WHERE farm_id = ? AND x = ? AND y = ?').get(farm.id, x, y);
    if (!tile) return res.status(400).json({ error: 'Invalid tile' });

    if (tile.state === 'grass') {
      if (!spendEnergy(db, req.userId, 1)) return res.status(400).json({ error: 'Not enough energy' });
      db.prepare('UPDATE farm_tiles SET state = ? WHERE id = ?').run('plowed', tile.id);
      return res.json({ ok: true, tile: { x, y, state: 'plowed' }, energy: resolveEnergy(db, req.userId) });
    }

    if (tile.state === 'plowed') {
      const crop = db.prepare('SELECT * FROM crops WHERE farm_id = ? AND tile_x = ? AND tile_y = ?').get(farm.id, x, y);
      if (crop) return res.status(400).json({ error: 'Cannot un-plow a tile with a crop on it' });
      // Undoing a plow is free (no energy cost) — it's just correcting a misclick.
      db.prepare('UPDATE farm_tiles SET state = ? WHERE id = ?').run('grass', tile.id);
      return res.json({ ok: true, tile: { x, y, state: 'grass' } });
    }

    return res.status(400).json({ error: 'Tile cannot be plowed' });
  });

  // ---- PLANT (consumes a seed from inventory — seeds are bought from the Shop first) ----
  router.post('/plant', (req, res) => {
    const { x, y, cropType } = req.body || {};
    const farm = getOwnFarm(req.userId);
    if (!farm || !inBounds(farm, x, y)) return res.status(400).json({ error: 'Invalid tile' });

    const tile = db.prepare('SELECT * FROM farm_tiles WHERE farm_id = ? AND x = ? AND y = ?').get(farm.id, x, y);
    if (!tile || tile.state !== 'plowed') return res.status(400).json({ error: 'Tile must be plowed first' });

    const existingCrop = db.prepare('SELECT * FROM crops WHERE farm_id = ? AND tile_x = ? AND tile_y = ?').get(farm.id, x, y);
    if (existingCrop) return res.status(400).json({ error: 'Tile already has a crop' });

    const crop = db.prepare('SELECT * FROM crop_types WHERE id = ?').get(cropType);
    if (!crop) return res.status(400).json({ error: 'Unknown crop type' });

    const seedItemId = `seed_${cropType}`;
    const seedRow = db.prepare('SELECT * FROM inventory WHERE user_id = ? AND item_id = ?').get(req.userId, seedItemId);
    if (!seedRow || seedRow.quantity < 1) {
      return res.status(400).json({ error: `No ${crop.name} seeds — buy some from the Shop first` });
    }

    if (!spendEnergy(db, req.userId, 1)) return res.status(400).json({ error: 'Not enough energy' });

    db.prepare('UPDATE inventory SET quantity = quantity - 1 WHERE id = ?').run(seedRow.id);

    const t = nowSec();
    db.prepare(`
      INSERT INTO crops (farm_id, tile_x, tile_y, crop_type, planted_at, growth_end_at, watered, state)
      VALUES (?, ?, ?, ?, ?, ?, 0, 'growing')
    `).run(farm.id, x, y, cropType, t, t + crop.growth_seconds);

    res.json({
      ok: true,
      crop: { x, y, cropType, plantedAt: t, growthEndAt: t + crop.growth_seconds, state: 'growing' },
      energy: resolveEnergy(db, req.userId),
    });
  });

  // ---- WATER (own crop or a friend's, i.e. the "help" action) ----
  router.post('/water', (req, res) => {
    const { ownerId, x, y } = req.body || {};
    const targetOwnerId = ownerId || req.userId;
    const farm = db.prepare('SELECT * FROM farms WHERE owner_id = ?').get(targetOwnerId);
    if (!farm) return res.status(404).json({ error: 'Farm not found' });

    const isVisitor = targetOwnerId !== req.userId;
    if (isVisitor) {
      const friendship = getFriendship(db, req.userId, targetOwnerId);
      if (!friendship) return res.status(403).json({ error: 'You must be friends to help on this farm' });
    }

    const crop = db.prepare('SELECT * FROM crops WHERE farm_id = ? AND tile_x = ? AND tile_y = ?').get(farm.id, x, y);
    if (!crop || crop.state !== 'growing') return res.status(400).json({ error: 'No growing crop there' });
    if (crop.watered) return res.status(400).json({ error: 'Already watered this cycle' });

    if (isVisitor) {
      // Limit: a visitor can only help a specific crop once per growth cycle (enforced by
      // the `watered` flag itself, since watering flips it and it only resets on replanting).
      const alreadyHelped = db.prepare(`
        SELECT 1 FROM help_actions WHERE visitor_id = ? AND owner_id = ? AND target_type = 'crop' AND target_id = ?
      `).get(req.userId, targetOwnerId, crop.id);
      if (alreadyHelped) return res.status(400).json({ error: 'You already helped with this crop' });

      // Helping costs gold too — flat 3 coins every time, deliberately
      // more than the 1-coin self-watering cost.
      const helper = db.prepare('SELECT coins FROM users WHERE id = ?').get(req.userId);
      if (helper.coins < FRIEND_WATER_COST) {
        return res.status(400).json({ error: `Helping water a friend's crop costs ${FRIEND_WATER_COST} coins — not enough coins` });
      }
      db.prepare('UPDATE users SET coins = coins - ? WHERE id = ?').run(FRIEND_WATER_COST, req.userId);
    } else {
      // Watering your own crop costs a small amount of coins (our currency is whole
      // coins, so this is the closest whole-number stand-in for "~0.3 gold per water").
      const user = db.prepare('SELECT coins FROM users WHERE id = ?').get(req.userId);
      if (user.coins < WATER_COST) return res.status(400).json({ error: `Watering costs ${WATER_COST} coin(s) — not enough coins` });
      if (!spendEnergy(db, req.userId, 1)) return res.status(400).json({ error: 'Not enough energy' });
      db.prepare('UPDATE users SET coins = coins - ? WHERE id = ?').run(WATER_COST, req.userId);
    }

    // Watering speeds up growth by 10% — but if the crop sat unwatered
    // long enough that its growth window already elapsed (it couldn't
    // become ready anyway without water, so that time was never doing
    // anything useful), that stale window gets thrown out and restarted
    // fresh from right now instead. Without this, watering a
    // long-neglected crop made it "ready" in the very same instant — the
    // 10%-off math has nothing meaningful to shave off an already-expired
    // timestamp, so it just silently kept the stale value as-is.
    const t = nowSec();
    let newEnd;
    if (t >= crop.growth_end_at) {
      const cropType = db.prepare('SELECT growth_seconds FROM crop_types WHERE id = ?').get(crop.crop_type);
      newEnd = t + (cropType ? cropType.growth_seconds : 0);
    } else {
      const remaining = crop.growth_end_at - t;
      newEnd = crop.growth_end_at - Math.floor(remaining * 0.10);
    }

    db.prepare('UPDATE crops SET watered = 1, watered_by = ?, growth_end_at = ? WHERE id = ?')
      .run(req.userId, newEnd, crop.id);
    resolveCropStates(db, farm.id);

    if (isVisitor) {
      db.prepare(`
        INSERT INTO help_actions (visitor_id, owner_id, target_type, target_id, action_type)
        VALUES (?, ?, 'crop', ?, 'water')
      `).run(req.userId, targetOwnerId, crop.id);
      const visitorRow = db.prepare('SELECT COALESCE(display_name, username) AS name FROM users WHERE id = ?').get(req.userId);
      const visitorName = visitorRow.name;
      notify(db, targetOwnerId, 'help', `${visitorName} helped water your crop!`);
      emitToUser(io, targetOwnerId, 'notification', { message: `${visitorName} helped water your crop!` });
      const updatedHelper = db.prepare('SELECT coins FROM users WHERE id = ?').get(req.userId);
      return res.json({ ok: true, crop: { x, y, watered: true }, coins: updatedHelper.coins });
    }

    const updatedUser = db.prepare('SELECT coins FROM users WHERE id = ?').get(req.userId);
    res.json({ ok: true, crop: { x, y, watered: true }, coins: updatedUser.coins, energy: resolveEnergy(db, req.userId) });
  });

  // ---- WATER A GROWABLE DECORATION (currently just trees) ----
  // Same idea as watering a crop — speeds up the remaining growth time and
  // costs a coin — but operates on a farm_object's freeform `state` JSON
  // instead of the dedicated crops table.
  router.post('/water-decoration', (req, res) => {
    const { objectId } = req.body || {};
    const farm = getOwnFarm(req.userId);
    if (!farm) return res.status(404).json({ error: 'Farm not found' });

    const obj = db.prepare("SELECT * FROM farm_objects WHERE id = ? AND farm_id = ? AND object_type = 'decoration'")
      .get(objectId, farm.id);
    if (!obj) return res.status(404).json({ error: 'Not found on your farm' });

    let growth;
    try { growth = obj.state ? JSON.parse(obj.state) : null; } catch (e) { growth = null; }
    if (!growth) return res.status(400).json({ error: "This isn't something that needs watering" });
    if (growth.watered) return res.status(400).json({ error: 'Already watered — check back once it grows' });

    const t = nowSec();
    if (growth.growthEndAt <= t) return res.status(400).json({ error: 'Already fully grown' });

    const user = db.prepare('SELECT coins FROM users WHERE id = ?').get(req.userId);
    if (user.coins < WATER_COST) return res.status(400).json({ error: `Watering costs ${WATER_COST} coin(s) — not enough coins` });

    const remaining = Math.max(0, growth.growthEndAt - t);
    growth.growthEndAt = growth.growthEndAt - Math.floor(remaining * 0.10);
    growth.watered = 1;

    db.prepare('UPDATE users SET coins = coins - ? WHERE id = ?').run(WATER_COST, req.userId);
    db.prepare('UPDATE farm_objects SET state = ? WHERE id = ?').run(JSON.stringify(growth), obj.id);

    const updatedUser = db.prepare('SELECT coins FROM users WHERE id = ?').get(req.userId);
    res.json({ ok: true, objectId: obj.id, growthEndAt: growth.growthEndAt, coins: updatedUser.coins });
  });

  // ---- HARVEST A MATURE TREE (chops it down for logs) ----
  // Logs are a raw material — right now they just sit in inventory; they'll
  // become useful once a cooking/firewood system exists. Chopping removes
  // the tree entirely (matching "grow a tree, cut it once" farm-game logic)
  // — plant another sapling for more.
  router.post('/harvest-tree', (req, res) => {
    const { objectId } = req.body || {};
    const farm = getOwnFarm(req.userId);
    if (!farm) return res.status(404).json({ error: 'Farm not found' });

    const obj = db.prepare("SELECT * FROM farm_objects WHERE id = ? AND farm_id = ? AND object_type = 'decoration' AND item_id = 'tree'")
      .get(objectId, farm.id);
    if (!obj) return res.status(404).json({ error: 'Not found on your farm' });

    let growth;
    try { growth = obj.state ? JSON.parse(obj.state) : null; } catch (e) { growth = null; }
    const t = nowSec();
    if (growth && growth.growthEndAt > t) return res.status(400).json({ error: 'This tree is still a sapling — let it finish growing first' });
    // Same requirement as crops now: a tree only actually finishes once
    // it's been watered at least once, not just because its timer ran out.
    if (growth && !growth.watered) return res.status(400).json({ error: "This tree hasn't been watered yet — water it before it can finish growing" });

    db.prepare('DELETE FROM farm_objects WHERE id = ?').run(obj.id);
    const logCount = 2 + Math.floor(Math.random() * 3); // 2-4 logs
    addInventory(db, req.userId, 'log', logCount);
    const reward = grantRewards(db, req.userId, { coins: 0, xp: 2 });

    res.json({ ok: true, objectId: obj.id, logs: logCount, reward, xpProgress: xpProgress(reward.xp) });
  });

  // ---- HARVEST ----
  router.post('/harvest', (req, res) => {
    const { x, y } = req.body || {};
    const farm = getOwnFarm(req.userId);
    if (!farm || !inBounds(farm, x, y)) return res.status(400).json({ error: 'Invalid tile' });

    resolveCropStates(db, farm.id);
    const crop = db.prepare('SELECT * FROM crops WHERE farm_id = ? AND tile_x = ? AND tile_y = ?').get(farm.id, x, y);
    if (!crop) return res.status(400).json({ error: 'Nothing ready to harvest' });

    // A dead (never watered in time) or withered (grown but left too long
    // un-harvested) crop just gets cleared away — no yield, no energy
    // spent (there's nothing to actually harvest, just cleanup).
    if (crop.state === 'dead' || crop.state === 'withered') {
      db.prepare('DELETE FROM crops WHERE id = ?').run(crop.id);
      db.prepare('UPDATE farm_tiles SET state = ? WHERE farm_id = ? AND x = ? AND y = ?').run('grass', farm.id, x, y);
      const message = crop.state === 'dead'
        ? 'This crop died from never being watered — cleared the tile, but nothing to harvest.'
        : 'This crop withered from sitting too long after it was ready — cleared the tile, but nothing to harvest.';
      return res.json({ ok: true, tile: { x, y, state: 'grass' }, cleared: crop.state, message });
    }

    if (crop.state !== 'ready') return res.status(400).json({ error: 'Nothing ready to harvest' });

    if (!spendEnergy(db, req.userId, 1)) return res.status(400).json({ error: 'Not enough energy' });

    const cropType = db.prepare('SELECT * FROM crop_types WHERE id = ?').get(crop.crop_type);

    db.prepare('DELETE FROM crops WHERE id = ?').run(crop.id);
    db.prepare('UPDATE farm_tiles SET state = ? WHERE farm_id = ? AND x = ? AND y = ?').run('grass', farm.id, x, y);
    const harvestQty = rollHarvestQuantity();
    addInventory(db, req.userId, cropType.id, harvestQty);

    // A harvest has a chance to also return a seed, so players aren't
    // completely dependent on buying from the shop every time.
    const SEED_RETURN_CHANCE = 0.25;
    const gotSeed = Math.random() < SEED_RETURN_CHANCE;
    if (gotSeed) addInventory(db, req.userId, `seed_${cropType.id}`, 1);

    const reward = grantRewards(db, req.userId, { coins: 0, xp: cropType.xp_reward });
    const energy = resolveEnergy(db, req.userId);

    res.json({ ok: true, tile: { x, y, state: 'grass' }, harvested: cropType.id, harvestQuantity: harvestQty, seedReturned: gotSeed, reward, xpProgress: xpProgress(reward.xp), energy });
  });

  // ---- SELL (from inventory, at the market) ----
  router.post('/sell', (req, res) => {
    const { itemId, quantity } = req.body || {};
    const qty = parseInt(quantity, 10);
    if (!qty || qty < 1) return res.status(400).json({ error: 'Invalid quantity' });

    // Seeds can't be instant-sold here anymore — the only place to sell
    // them is a rented stall in the Marketplace, where the seller picks
    // their own price. This is what actually gives seeds a real value:
    // otherwise they're just an auto-priced commodity like everything
    // else, instead of something a player can undercut the shop on.
    if (itemId.startsWith('seed_')) {
      return res.status(400).json({ error: 'Seeds can only be sold at a Marketplace stall, not here.' });
    }

    const invRow = db.prepare('SELECT * FROM inventory WHERE user_id = ? AND item_id = ?').get(req.userId, itemId);
    if (!invRow || invRow.quantity < qty) return res.status(400).json({ error: 'Not enough in inventory' });

    const cropType = db.prepare('SELECT * FROM crop_types WHERE id = ?').get(itemId);
    const item = cropType || db.prepare('SELECT * FROM item_types WHERE id = ?').get(itemId);
    if (!item) return res.status(400).json({ error: 'Unknown item' });
    const unitPrice = cropType ? cropType.sell_price : item.sell_price;

    db.prepare('UPDATE inventory SET quantity = quantity - ? WHERE id = ?').run(qty, invRow.id);
    const reward = grantRewards(db, req.userId, { coins: unitPrice * qty, xp: 0 });

    res.json({ ok: true, sold: itemId, quantity: qty, totalCoins: unitPrice * qty, coins: reward.coins });
  });

  // ---- EXPAND FARM ----
  router.post('/expand', (req, res) => {
    const farm = getOwnFarm(req.userId);
    if (!farm) return res.status(404).json({ error: 'Farm not found' });

    const nextLevel = farm.expansion_level + 1;
    const cost = 500 * Math.pow(2, farm.expansion_level); // doubling cost per expansion
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
    if (user.coins < cost) return res.status(400).json({ error: `Expansion costs ${cost} coins` });

    const addWidth = 4, addHeight = 4;
    const newWidth = farm.width + addWidth;
    const newHeight = farm.height + addHeight;

    db.prepare('UPDATE users SET coins = coins - ? WHERE id = ?').run(cost, req.userId);
    db.prepare('UPDATE farms SET width = ?, height = ?, expansion_level = ? WHERE id = ?')
      .run(newWidth, newHeight, nextLevel, farm.id);

    const { initFarmTiles } = require('../lib/gameLogic');
    initFarmTiles(db, farm.id, newWidth, newHeight);

    res.json({ ok: true, width: newWidth, height: newHeight, expansionLevel: nextLevel, coinsSpent: cost });
  });

  // Cooking recipes: 2 of a harvested crop turns into 1 food item, which
  // restores energy when eaten. Bigger/slower-growing crops make food that
  // restores more energy, matching their higher value everywhere else.
  const COOK_RECIPES = {
    wheat:      { cropCost: 2, foodItemId: 'bread',           energyRestore: 5 },
    rice:       { cropCost: 2, foodItemId: 'rice_bowl',       energyRestore: 6 },
    corn:       { cropCost: 2, foodItemId: 'corn_soup',       energyRestore: 7 },
    carrot:     { cropCost: 2, foodItemId: 'carrot_stew',     energyRestore: 8 },
    potato:     { cropCost: 2, foodItemId: 'mashed_potato',   energyRestore: 10 },
    tomato:     { cropCost: 2, foodItemId: 'tomato_soup',     energyRestore: 11 },
    strawberry: { cropCost: 2, foodItemId: 'strawberry_cake', energyRestore: 14 },
    pumpkin:    { cropCost: 2, foodItemId: 'pumpkin_pie',     energyRestore: 17 },
    // Animal products (eggs, milk, truffles) can be cooked too — wool
    // isn't food, so it stays a pure crafting material for now.
    egg:        { cropCost: 2, foodItemId: 'fried_egg',    energyRestore: 6 },
    milk:       { cropCost: 2, foodItemId: 'milkshake',    energyRestore: 10 },
    truffle:    { cropCost: 2, foodItemId: 'truffle_dish', energyRestore: 18 },
  };

  // Ready-made snacks bought directly with coins at the Central Park carts
  // (not cooked at a Stove like the recipes above) — see /api/park/buy-snack.
  const PARK_SNACKS = {
    ice_cream: { coinCost: 75, energyRestore: 5 },
    hotdog:    { coinCost: 100, energyRestore: 8 },
  };

  // POST /api/park/buy-snack { itemId } — buy 1 ice cream or hotdog from a
  // Central Park cart straight into your Bag (no Stove/ingredients needed,
  // unlike the cooking recipes — this is a ready-made snack, paid for
  // directly in coins).
  router.post('/park-buy-snack', (req, res) => {
    const { itemId } = req.body || {};
    const snack = PARK_SNACKS[itemId];
    if (!snack) return res.status(400).json({ error: 'Unknown snack' });

    const user = db.prepare('SELECT coins FROM users WHERE id = ?').get(req.userId);
    if (user.coins < snack.coinCost) {
      return res.status(400).json({ error: `Not enough coins — need ${snack.coinCost}` });
    }
    db.prepare('UPDATE users SET coins = coins - ? WHERE id = ?').run(snack.coinCost, req.userId);
    addInventory(db, req.userId, itemId, 1);
    const updated = db.prepare('SELECT coins FROM users WHERE id = ?').get(req.userId);
    res.json({ ok: true, itemId, coins: updated.coins });
  });

  // POST /api/farm/cook { cropType, quantity, atFarmId } — requires a Stove
  // somewhere indoors on the target farm (your own house by default, or a
  // friend's if you're visiting — cooking together is allowed, unlike most
  // placement actions which stay owner-only).
  router.post('/cook', (req, res) => {
    const { cropType, quantity, atFarmId } = req.body || {};
    const qty = parseInt(quantity, 10);
    if (!qty || qty < 1) return res.status(400).json({ error: 'Invalid quantity' });
    const recipe = COOK_RECIPES[cropType];
    if (!recipe) return res.status(400).json({ error: 'Unknown ingredient' });

    const targetFarmId = atFarmId || getOwnFarm(req.userId).id;
    const stove = db.prepare("SELECT * FROM farm_objects WHERE farm_id = ? AND item_id = 'stove' AND location = 'indoor'").get(targetFarmId);
    if (!stove) return res.status(400).json({ error: 'No Stove there to cook with' });

    const cropNeeded = recipe.cropCost * qty;
    // Ingredients can live in the Fridge, the Bag, or split across both —
    // draw from the Fridge FIRST (that's the whole point of having one:
    // ingredients parked there instead of cluttering the Bag get used
    // same as anything else), then top up from the Bag for the rest.
    const fridgeRow = db.prepare('SELECT * FROM fridge_storage WHERE user_id = ? AND item_id = ?').get(req.userId, cropType);
    const fridgeQty = fridgeRow ? fridgeRow.quantity : 0;
    const cropRow = db.prepare('SELECT * FROM inventory WHERE user_id = ? AND item_id = ?').get(req.userId, cropType);
    const bagQty = cropRow ? cropRow.quantity : 0;
    if (fridgeQty + bagQty < cropNeeded) {
      return res.status(400).json({ error: `Not enough ${cropType} — need ${cropNeeded}, have ${fridgeQty + bagQty} (Fridge + Bag)` });
    }

    const fromFridge = Math.min(fridgeQty, cropNeeded);
    const fromBag = cropNeeded - fromFridge;
    if (fromFridge > 0) db.prepare('UPDATE fridge_storage SET quantity = quantity - ? WHERE id = ?').run(fromFridge, fridgeRow.id);
    if (fromBag > 0) db.prepare('UPDATE inventory SET quantity = quantity - ? WHERE id = ?').run(fromBag, cropRow.id);
    // Ingredients are spent either way (that's the risk of cooking) — but
    // each individual attempt within the batch has an independent 5%
    // chance to come out ruined, yielding one fewer food item than qty
    // asked for. Small enough to rarely matter for a batch of a few, but
    // real enough to notice on a big batch.
    const COOK_FAIL_CHANCE = 0.05;
    let succeeded = 0;
    for (let i = 0; i < qty; i++) if (Math.random() >= COOK_FAIL_CHANCE) succeeded++;
    if (succeeded > 0) addInventory(db, req.userId, recipe.foodItemId, succeeded);
    res.json({ ok: true, foodItemId: recipe.foodItemId, quantity: succeeded, attempted: qty, failed: qty - succeeded, cropSpent: cropNeeded });
  });

  // POST /api/farm/eat { foodItemId } — consumes 1 food item, restores energy.
  router.post('/eat', (req, res) => {
    const { foodItemId } = req.body || {};
    // Food can come from either a Stove recipe (COOK_RECIPES, keyed by
    // ingredient) or a Central Park snack cart (PARK_SNACKS, keyed
    // directly by the food's own item id) — normalize both into the same
    // { foodItemId, energyRestore } shape before looking up what's owned.
    const cooked = Object.values(COOK_RECIPES).find((r) => r.foodItemId === foodItemId);
    const snack = PARK_SNACKS[foodItemId];
    const energyRestore = cooked ? cooked.energyRestore : snack ? snack.energyRestore : null;
    if (energyRestore === null) return res.status(400).json({ error: 'Unknown food item' });

    const foodRow = db.prepare('SELECT * FROM inventory WHERE user_id = ? AND item_id = ?').get(req.userId, foodItemId);
    if (!foodRow || foodRow.quantity < 1) return res.status(400).json({ error: "You don't have any of that to eat" });

    db.prepare('UPDATE inventory SET quantity = quantity - 1 WHERE id = ?').run(foodRow.id);
    const energy = addEnergy(db, req.userId, energyRestore);
    res.json({ ok: true, energy, energyRestored: energyRestore });
  });

  return router;
};

function inBounds(farm, x, y) {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < farm.width && y < farm.height;
}

function getFriendship(db, userA, userB) {
  return db.prepare(`
    SELECT * FROM friends
    WHERE status = 'accepted' AND (
      (requester_id = ? AND receiver_id = ?) OR (requester_id = ? AND receiver_id = ?)
    )
  `).get(userA, userB, userB, userA);
}

function emitToUser(io, userId, event, payload) {
  if (io) io.to(`user:${userId}`).emit(event, payload);
}

module.exports.getFriendship = getFriendship;
