const express = require('express');
const { grantRewards, addInventory, nowSec } = require('../lib/gameLogic');
const {
  INTERIOR_WIDTH, INTERIOR_HEIGHT, HOUSE_LOCATION,
  ENTERABLE_BUILDING_DIMENSIONS, BUILDING_ALLOWED_ANIMALS,
  isEnterableBuildingType, buildingIdFromLocation,
} = require('../lib/interiorSpaces');

const DYE_COST = 25;
const DYE_PALETTE = ['#c0392b', '#e8a527', '#4f8f2e', '#3d8fe0', '#8e44ad', '#e05a7e', '#4a3521', '#f4f4f4'];

// Given a `location` value ('outdoor', 'indoor', or 'indoor:<buildingId>'),
// returns { width, height } for placement/overlap bounds-checking.
function interiorBoundsFor(db, farmId, location) {
  if (location === HOUSE_LOCATION) return { width: INTERIOR_WIDTH, height: INTERIOR_HEIGHT };
  const buildingId = buildingIdFromLocation(location);
  if (buildingId) {
    const building = db.prepare('SELECT item_id FROM farm_objects WHERE id = ? AND farm_id = ?').get(buildingId, farmId);
    if (building && ENTERABLE_BUILDING_DIMENSIONS[building.item_id]) return ENTERABLE_BUILDING_DIMENSIONS[building.item_id];
  }
  return { width: INTERIOR_WIDTH, height: INTERIOR_HEIGHT };
}

module.exports = function shopRoutes(db) {
  const router = express.Router();

  // GET /api/shop/catalog - everything purchasable, grouped by category
  router.get('/catalog', (req, res) => {
    const crops = db.prepare('SELECT * FROM crop_types ORDER BY required_level, seed_cost').all();
    // Farmhouse is granted free at registration and is not re-purchasable —
    // exclude it from the buildable list so players can't place duplicates.
    const buildings = db.prepare("SELECT * FROM building_types ORDER BY required_level, cost").all();
    const decorations = db.prepare('SELECT * FROM decoration_types ORDER BY required_level, cost').all();
    const animals = db.prepare('SELECT * FROM animal_types ORDER BY required_level, cost').all();
    const items = db.prepare('SELECT * FROM item_types ORDER BY sell_price').all();
    const outfits = db.prepare('SELECT * FROM outfit_types ORDER BY required_level, cost').all();
    const interiors = db.prepare('SELECT * FROM interior_types ORDER BY required_level, cost').all();
    res.json({ crops, buildings, decorations, animals, items, outfits, interiors, dyePalette: DYE_PALETTE, dyeCost: DYE_COST });
  });

  // POST /api/shop/buy-seed  { cropType, quantity } — seeds must be bought here first;
  // they land in the player's inventory (as `seed_<cropType>`) and are consumed one at a
  // time when planting.
  router.post('/buy-seed', (req, res) => {
    const { cropType, quantity } = req.body || {};
    const qty = parseInt(quantity, 10) || 1;
    if (qty < 1 || qty > 99) return res.status(400).json({ error: 'Invalid quantity' });

    const crop = db.prepare('SELECT * FROM crop_types WHERE id = ?').get(cropType);
    if (!crop) return res.status(400).json({ error: 'Unknown crop type' });

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
    if (user.level < crop.required_level) return res.status(400).json({ error: `Requires level ${crop.required_level}` });
    const totalCost = crop.seed_cost * qty;
    if (user.coins < totalCost) return res.status(400).json({ error: 'Not enough coins' });

    db.prepare('UPDATE users SET coins = coins - ? WHERE id = ?').run(totalCost, req.userId);
    addInventory(db, req.userId, `seed_${cropType}`, qty);

    const updated = db.prepare('SELECT coins FROM users WHERE id = ?').get(req.userId);
    res.json({ ok: true, cropType, quantity: qty, coinsSpent: totalCost, coins: updated.coins });
  });

  // POST /api/shop/buy-outfit  { outfitId } — buys (if not already owned) and equips immediately
  const OUTFIT_RENTAL_SECONDS = 7 * 86400; // 7 days per purchase/renewal

  router.post('/buy-outfit', (req, res) => {
    const { outfitId } = req.body || {};
    const outfit = db.prepare('SELECT * FROM outfit_types WHERE id = ?').get(outfitId);
    if (!outfit) return res.status(400).json({ error: 'Unknown outfit' });

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
    if (outfit.gender !== 'unisex' && outfit.gender !== user.gender) {
      return res.status(400).json({ error: `This outfit is styled for ${outfit.gender} characters` });
    }
    if (user.level < outfit.required_level) return res.status(400).json({ error: `Requires level ${outfit.required_level}` });

    const t = Math.floor(Date.now() / 1000);
    const owned = db.prepare('SELECT * FROM owned_outfits WHERE user_id = ? AND outfit_id = ?').get(req.userId, outfitId);
    let purchased = false;

    if (outfit.cost === 0) {
      // The free default outfit — no rental, no expiration, own it once.
      if (!owned) db.prepare('INSERT INTO owned_outfits (user_id, outfit_id, expires_at) VALUES (?, ?, NULL)').run(req.userId, outfitId);
    } else {
      const isActive = owned && owned.expires_at && owned.expires_at > t;
      // Can't buy/renew while the current rental is still running — has to
      // actually expire first. No early stacking of extra days.
      if (isActive) {
        const daysLeft = Math.ceil((owned.expires_at - t) / 86400);
        return res.status(400).json({ error: `You already have this costume — it's active for ${daysLeft} more day${daysLeft === 1 ? '' : 's'}` });
      }
      const newExpiry = t + OUTFIT_RENTAL_SECONDS;
      if ((user.premium_currency || 0) < outfit.cost) {
        return res.status(400).json({ error: `Not enough Premium Points — need ${outfit.cost}, have ${user.premium_currency || 0}` });
      }
      db.prepare('UPDATE users SET premium_currency = premium_currency - ? WHERE id = ?').run(outfit.cost, req.userId);
      if (owned) {
        db.prepare('UPDATE owned_outfits SET expires_at = ? WHERE id = ?').run(newExpiry, owned.id);
      } else {
        db.prepare('INSERT INTO owned_outfits (user_id, outfit_id, expires_at) VALUES (?, ?, ?)').run(req.userId, outfitId, newExpiry);
      }
      purchased = true;
    }
    // Switching outfits clears any custom dye — dye is a per-shirt tint, not a permanent trait.
    db.prepare('UPDATE users SET equipped_outfit = ?, dye_color = NULL WHERE id = ?').run(outfitId, req.userId);

    const updated = db.prepare('SELECT coins, premium_currency FROM users WHERE id = ?').get(req.userId);
    const finalOwned = db.prepare('SELECT expires_at FROM owned_outfits WHERE user_id = ? AND outfit_id = ?').get(req.userId, outfitId);
    res.json({ ok: true, outfitId, purchased, expiresAt: finalOwned ? finalOwned.expires_at : null, coins: updated.coins, premiumCurrency: updated.premium_currency });
  });

  // POST /api/shop/dye  { color } — recolors the shirt of the currently equipped outfit
  router.post('/dye', (req, res) => {
    const { color } = req.body || {};
    if (!DYE_PALETTE.includes(color)) return res.status(400).json({ error: 'Unknown dye color' });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
    if (user.coins < DYE_COST) return res.status(400).json({ error: `Dyeing costs ${DYE_COST} coins` });
    db.prepare('UPDATE users SET coins = coins - ?, dye_color = ? WHERE id = ?').run(DYE_COST, color, req.userId);
    const updated = db.prepare('SELECT coins FROM users WHERE id = ?').get(req.userId);
    res.json({ ok: true, dyeColor: color, coins: updated.coins });
  });

  // POST /api/shop/buy-placeable  { category: 'building'|'decoration'|'animal'|'interior', itemId, quantity }
  // Buys N units into the player's inventory (as `${category}_${itemId}`), same pattern as
  // seeds. Placement is a separate step (place-object) — this is what makes the Build tool
  // only show things you've actually bought, instead of paying at placement time.
  router.post('/buy-placeable', (req, res) => {
    const { category, itemId, quantity } = req.body || {};
    if (!['building', 'decoration', 'animal', 'interior'].includes(category)) {
      return res.status(400).json({ error: 'Invalid category' });
    }
    if (category === 'building' && itemId === 'farmhouse') {
      return res.status(400).json({ error: 'You already have a farmhouse — it was placed for free when you registered.' });
    }
    const qty = parseInt(quantity, 10) || 1;
    if (qty < 1 || qty > 99) return res.status(400).json({ error: 'Invalid quantity' });

    const def = lookupDefSync(db, category, itemId);
    if (!def) return res.status(400).json({ error: 'Unknown item' });

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
    if (user.level < def.required_level) return res.status(400).json({ error: `Requires level ${def.required_level}` });
    const totalCost = def.cost * qty;
    if (user.coins < totalCost) return res.status(400).json({ error: 'Not enough coins' });

    db.prepare('UPDATE users SET coins = coins - ? WHERE id = ?').run(totalCost, req.userId);
    addInventory(db, req.userId, `${category}_${itemId}`, qty);

    const updated = db.prepare('SELECT coins FROM users WHERE id = ?').get(req.userId);
    res.json({ ok: true, category, itemId, quantity: qty, coinsSpent: totalCost, coins: updated.coins });
  });

  // POST /api/shop/place-object  { category, itemId, x, y, rotation, location }
  // Consumes 1 owned (already-bought) unit from inventory and places it on
  // the farm. location: 'outdoor' (default), 'indoor' (the house), or
  // 'indoor:<buildingId>' for a specific coop/barn/cow_barn's own room.
  router.post('/place-object', (req, res) => {
    const { category, itemId, x, y, rotation, location } = req.body || {};
    if (!['building', 'decoration', 'animal', 'interior'].includes(category)) {
      return res.status(400).json({ error: 'Invalid category' });
    }

    const farm = db.prepare('SELECT * FROM farms WHERE owner_id = ?').get(req.userId);
    if (!farm) return res.status(404).json({ error: 'Farm not found' });

    // Figure out which room `location` actually refers to (if any), and —
    // for a per-building room — which building it belongs to, so animal
    // placements can be checked against what that specific building allows.
    let loc = 'outdoor';
    let penBuildingItemId = null; // set only if `location` is a real animal-pen room
    if (location === HOUSE_LOCATION) {
      loc = HOUSE_LOCATION;
    } else {
      const buildingId = buildingIdFromLocation(location);
      if (buildingId) {
        const building = db.prepare("SELECT * FROM farm_objects WHERE id = ? AND farm_id = ? AND object_type = 'building'")
          .get(buildingId, farm.id);
        if (building && isEnterableBuildingType(building.item_id)) {
          loc = location;
          penBuildingItemId = building.item_id;
        }
      }
    }
    const isIndoor = loc !== 'outdoor';
    const allowedAnimalsHere = penBuildingItemId ? (BUILDING_ALLOWED_ANIMALS[penBuildingItemId] || []) : [];
    const isAnimalPen = allowedAnimalsHere.length > 0;
    const categoryAllowedIndoors = category === 'interior' || (isAnimalPen && category === 'animal');
    if (isIndoor && !categoryAllowedIndoors) {
      return res.status(400).json({ error: isAnimalPen ? 'Only furniture and animals can be placed here' : 'Only interior items can be placed indoors' });
    }
    if (!isIndoor && category === 'interior') {
      return res.status(400).json({ error: 'Interior items can only be placed indoors' });
    }
    if (category === 'animal' && isAnimalPen && !allowedAnimalsHere.includes(itemId)) {
      return res.status(400).json({ error: `This building only houses: ${allowedAnimalsHere.join(', ')}` });
    }

    const def = lookupDefSync(db, category, itemId);
    if (!def) return res.status(400).json({ error: 'Unknown item' });

    const invItemId = `${category}_${itemId}`;
    const invRow = db.prepare('SELECT * FROM inventory WHERE user_id = ? AND item_id = ?').get(req.userId, invItemId);
    if (!invRow || invRow.quantity < 1) {
      return res.status(400).json({ error: `You don't own a ${def.name} to place — buy one from the Shop first` });
    }

    const w = def.width || 1, h = def.height || 1;
    const bounds = isIndoor ? interiorBoundsFor(db, farm.id, loc) : { width: farm.width, height: farm.height };
    const boundsW = bounds.width, boundsH = bounds.height;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x + w > boundsW || y + h > boundsH) {
      return res.status(400).json({ error: 'Placement out of bounds' });
    }
    const blocking = findOverlap(db, farm.id, loc, x, y, w, h);
    if (blocking) {
      return res.status(400).json({
        error: `That spot already has a ${blocking.def ? blocking.def.name : blocking.object.item_id} on it (at ${blocking.object.grid_x},${blocking.object.grid_y}) — remove it first or pick a different spot.`,
      });
    }

    db.prepare('UPDATE inventory SET quantity = quantity - 1 WHERE id = ?').run(invRow.id);

    // Growable decorations (currently just trees) start life as a sapling —
    // state stores the growth timer as JSON, mirroring how crops track
    // planted_at/growth_end_at, just folded into the freeform state column
    // since farm_objects is shared by many non-growable object types too.
    let state = null;
    if (category === 'decoration' && def.growable) {
      const t = nowSec();
      state = JSON.stringify({ plantedAt: t, growthEndAt: t + def.growth_seconds, watered: 0 });
    }

    const info = db.prepare(`
      INSERT INTO farm_objects (farm_id, object_type, item_id, location, grid_x, grid_y, rotation, state, last_collected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(farm.id, category, itemId, loc, x, y, rotation || 0, state, nowSec());

    res.json({ ok: true, objectId: info.lastInsertRowid });
  });

  // POST /api/shop/set-sign-text  { objectId, text } — customize a Sign's
  // text, costing coins every time (first time OR editing it again) since
  // it's a paid customization, not a one-time unlock.
  const SIGN_TEXT_COST = 150;
  const MAX_SIGN_TEXT_LENGTH = 24;
  router.post('/set-sign-text', (req, res) => {
    const { objectId, text } = req.body || {};
    const signText = (text || '').toString().trim();
    if (!signText) return res.status(400).json({ error: 'Enter some text for the sign' });
    if (signText.length > MAX_SIGN_TEXT_LENGTH) return res.status(400).json({ error: `Keep it under ${MAX_SIGN_TEXT_LENGTH} characters` });

    const farm = db.prepare('SELECT * FROM farms WHERE owner_id = ?').get(req.userId);
    if (!farm) return res.status(404).json({ error: 'Farm not found' });
    const obj = db.prepare("SELECT * FROM farm_objects WHERE id = ? AND farm_id = ? AND item_id = 'sign'").get(objectId, farm.id);
    if (!obj) return res.status(404).json({ error: 'Sign not found on your farm' });

    const user = db.prepare('SELECT coins FROM users WHERE id = ?').get(req.userId);
    if (user.coins < SIGN_TEXT_COST) return res.status(400).json({ error: `Customizing a sign costs 🪙${SIGN_TEXT_COST}` });

    db.prepare('UPDATE users SET coins = coins - ? WHERE id = ?').run(SIGN_TEXT_COST, req.userId);
    db.prepare('UPDATE farm_objects SET state = ? WHERE id = ?').run(JSON.stringify({ text: signText }), obj.id);

    const updated = db.prepare('SELECT coins FROM users WHERE id = ?').get(req.userId);
    res.json({ ok: true, text: signText, coins: updated.coins });
  });

  // POST /api/shop/move-object  { objectId, x, y, rotation }
  router.post('/move-object', (req, res) => {
    const { objectId, x, y, rotation } = req.body || {};
    const farm = db.prepare('SELECT * FROM farms WHERE owner_id = ?').get(req.userId);
    if (!farm) return res.status(404).json({ error: 'Farm not found' });

    const obj = db.prepare('SELECT * FROM farm_objects WHERE id = ? AND farm_id = ?').get(objectId, farm.id);
    if (!obj) return res.status(404).json({ error: 'Object not found on your farm' });
    if (obj.object_type === 'building') {
      return res.status(400).json({ error: "Buildings can't be moved — remove and re-place them instead." });
    }
    if (obj.item_id === 'tree') {
      return res.status(400).json({ error: "A planted tree can't be moved — chop it down and plant a new one instead." });
    }

    const def = lookupDefSync(db, obj.object_type, obj.item_id);
    const w = def.width || 1, h = def.height || 1;
    const isIndoor = obj.location !== 'outdoor';
    const bounds = isIndoor ? interiorBoundsFor(db, farm.id, obj.location) : { width: farm.width, height: farm.height };
    const boundsW = bounds.width, boundsH = bounds.height;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x + w > boundsW || y + h > boundsH) {
      return res.status(400).json({ error: 'Placement out of bounds' });
    }
    const blocking = findOverlap(db, farm.id, obj.location, x, y, w, h, objectId);
    if (blocking) {
      return res.status(400).json({
        error: `That spot already has a ${blocking.def ? blocking.def.name : blocking.object.item_id} on it (at ${blocking.object.grid_x},${blocking.object.grid_y}) — remove it first or pick a different spot.`,
      });
    }

    db.prepare('UPDATE farm_objects SET grid_x = ?, grid_y = ?, rotation = ?, updated_at = ? WHERE id = ?')
      .run(x, y, rotation ?? obj.rotation, nowSec(), objectId);
    res.json({ ok: true });
  });

  // DELETE /api/shop/object/:id - remove any object the OWNER placed (fixes mistaken placements;
  // not a refund system, just removal).
  router.delete('/object/:id', (req, res) => {
    const farm = db.prepare('SELECT * FROM farms WHERE owner_id = ?').get(req.userId);
    if (!farm) return res.status(404).json({ error: 'Farm not found' });
    const obj = db.prepare('SELECT * FROM farm_objects WHERE id = ? AND farm_id = ?').get(req.params.id, farm.id);
    if (!obj) return res.status(404).json({ error: 'Object not found on your farm' });
    if (obj.item_id === 'farmhouse') {
      return res.status(400).json({ error: "Your house can't be removed — it's the one building every farm needs." });
    }
    db.prepare('DELETE FROM farm_objects WHERE id = ?').run(obj.id);
    res.json({ ok: true });
  });

  // Wheat-to-feed conversion at the Silo — 2 wheat per chicken feed, scaling
  // up for bigger animals. Matches "no feeds = no eggs": collecting from an
  // animal now requires having fed it since its last collection.
  const FEED_RECIPES = {
    chicken: { wheatCost: 1, feedItemId: 'chicken_feed' },
    sheep: { wheatCost: 3, feedItemId: 'sheep_feed' },
    pig: { wheatCost: 4, feedItemId: 'pig_feed' },
    cow: { wheatCost: 5, feedItemId: 'cow_feed' },
  };

  // Workshop-crafted furniture — turns Wood (logs, from chopping trees)
  // into furniture that reuses its store-bought counterpart's look but has
  // its own distinct id/name ("Crafted Bed" etc.) and, unlike store-bought
  // furniture, can be sold at a Marketplace stall. `category` decides the
  // inventory item id prefix used below (interior_ vs decoration_ — the
  // bench is an outdoor decoration, not indoor furniture, so it's the one
  // exception here).
  const FURNITURE_RECIPES = {
    crafted_bench:     { woodCost: 5,  category: 'decoration', name: 'Crafted Bench' },
    crafted_chair:     { woodCost: 5,  category: 'interior', name: 'Crafted Chair' },
    crafted_cabinet:   { woodCost: 10, category: 'interior', name: 'Crafted Cabinet' },
    crafted_bookshelf: { woodCost: 10, category: 'interior', name: 'Crafted Bookshelf' },
    crafted_bed:       { woodCost: 15, category: 'interior', name: 'Crafted Bed' },
  };

  // POST /api/shop/craft-furniture { furnitureType, quantity } — requires
  // owning a Workshop building; consumes Wood (the 'log' material item)
  // from inventory, produces the matching crafted furniture piece.
  router.post('/craft-furniture', (req, res) => {
    const { furnitureType, quantity } = req.body || {};
    const qty = parseInt(quantity, 10);
    if (!qty || qty < 1) return res.status(400).json({ error: 'Invalid quantity' });
    const recipe = FURNITURE_RECIPES[furnitureType];
    if (!recipe) return res.status(400).json({ error: 'Unknown furniture type' });

    const farm = db.prepare('SELECT * FROM farms WHERE owner_id = ?').get(req.userId);
    if (!farm) return res.status(404).json({ error: 'Farm not found' });
    const workshop = db.prepare("SELECT * FROM farm_objects WHERE farm_id = ? AND item_id = 'workshop'").get(farm.id);
    if (!workshop) return res.status(400).json({ error: 'You need a Workshop on your farm to craft furniture' });

    const woodNeeded = recipe.woodCost * qty;
    const woodRow = db.prepare("SELECT * FROM inventory WHERE user_id = ? AND item_id = 'log'").get(req.userId);
    if (!woodRow || woodRow.quantity < woodNeeded) {
      return res.status(400).json({ error: `Not enough Wood — need ${woodNeeded}, have ${woodRow ? woodRow.quantity : 0}` });
    }

    db.prepare('UPDATE inventory SET quantity = quantity - ? WHERE id = ?').run(woodNeeded, woodRow.id);
    addInventory(db, req.userId, `${recipe.category}_${furnitureType}`, qty);
    res.json({ ok: true, furnitureType, quantity: qty, woodSpent: woodNeeded });
  });

  // POST /api/shop/craft-feed { animalType, quantity } — requires owning a
  // Silo building; consumes wheat from inventory, produces matching feed.
  router.post('/craft-feed', (req, res) => {
    const { animalType, quantity } = req.body || {};
    const qty = parseInt(quantity, 10);
    if (!qty || qty < 1) return res.status(400).json({ error: 'Invalid quantity' });
    const recipe = FEED_RECIPES[animalType];
    if (!recipe) return res.status(400).json({ error: 'Unknown animal type' });

    const farm = db.prepare('SELECT * FROM farms WHERE owner_id = ?').get(req.userId);
    if (!farm) return res.status(404).json({ error: 'Farm not found' });
    const silo = db.prepare("SELECT * FROM farm_objects WHERE farm_id = ? AND item_id = 'silo'").get(farm.id);
    if (!silo) return res.status(400).json({ error: 'You need a Silo on your farm to make feed' });

    const wheatNeeded = recipe.wheatCost * qty;
    const wheatRow = db.prepare("SELECT * FROM inventory WHERE user_id = ? AND item_id = 'wheat'").get(req.userId);
    if (!wheatRow || wheatRow.quantity < wheatNeeded) {
      return res.status(400).json({ error: `Not enough wheat — need ${wheatNeeded}, have ${wheatRow ? wheatRow.quantity : 0}` });
    }

    db.prepare('UPDATE inventory SET quantity = quantity - ? WHERE id = ?').run(wheatNeeded, wheatRow.id);
    addInventory(db, req.userId, recipe.feedItemId, qty);
    res.json({ ok: true, feedItemId: recipe.feedItemId, quantity: qty, wheatSpent: wheatNeeded });
  });

  // POST /api/shop/feed-animal { objectId } — consumes 1 matching feed,
  // and is required at least once since the animal's last collection
  // before you're allowed to collect from it again.
  router.post('/feed-animal', (req, res) => {
    const { objectId } = req.body || {};
    const farm = db.prepare('SELECT * FROM farms WHERE owner_id = ?').get(req.userId);
    if (!farm) return res.status(404).json({ error: 'Farm not found' });

    const obj = db.prepare("SELECT * FROM farm_objects WHERE id = ? AND farm_id = ? AND object_type = 'animal'").get(objectId, farm.id);
    if (!obj) return res.status(404).json({ error: 'Animal not found on your farm' });
    const recipe = FEED_RECIPES[obj.item_id];
    if (!recipe) return res.status(400).json({ error: "This animal doesn't need feed" });

    // Feeding only unlocks ONE collection — can't stack up feedings ahead
    // of time. Blocked until the animal is actually collected from again
    // (which resets last_collected_at, making a past lastFed "stale").
    let state = {};
    try { state = obj.state ? JSON.parse(obj.state) : {}; } catch (e) { state = {}; }
    const last = obj.last_collected_at || obj.created_at;
    if (state.lastFed && state.lastFed >= last) {
      return res.status(400).json({ error: 'Already fed — wait for it to be ready and collect first.' });
    }

    const feedRow = db.prepare('SELECT * FROM inventory WHERE user_id = ? AND item_id = ?').get(req.userId, recipe.feedItemId);
    if (!feedRow || feedRow.quantity < 1) {
      return res.status(400).json({ error: `No ${recipe.feedItemId.replace('_', ' ')} in your Bag — make some at the Silo first` });
    }

    db.prepare('UPDATE inventory SET quantity = quantity - 1 WHERE id = ?').run(feedRow.id);
    const t = nowSec();
    state.lastFed = t;
    // If the production window already elapsed while this animal sat
    // unfed (it couldn't produce anything without food anyway, so that
    // time wasn't doing anything useful), restart the timer fresh from
    // right now instead of leaving the stale reference point in place —
    // otherwise feeding a long-neglected animal made it instantly ready
    // in the same moment, the same bug as un-watered crops had.
    const animalType = db.prepare('SELECT production_seconds FROM animal_types WHERE id = ?').get(obj.item_id);
    const prodSeconds = animalType ? animalType.production_seconds : 0;
    let updateSql = 'UPDATE farm_objects SET state = ? WHERE id = ?';
    let updateParams = [JSON.stringify(state), obj.id];
    if (t >= last + prodSeconds) {
      updateSql = 'UPDATE farm_objects SET state = ?, last_collected_at = ? WHERE id = ?';
      updateParams = [JSON.stringify(state), t, obj.id];
    }
    db.prepare(updateSql).run(...updateParams);
    res.json({ ok: true });
  });

  // POST /api/shop/collect-animal { objectId }
  router.post('/collect-animal', (req, res) => {
    const { objectId } = req.body || {};
    const farm = db.prepare('SELECT * FROM farms WHERE owner_id = ?').get(req.userId);
    if (!farm) return res.status(404).json({ error: 'Farm not found' });

    const obj = db.prepare('SELECT * FROM farm_objects WHERE id = ? AND farm_id = ? AND object_type = ?')
      .get(objectId, farm.id, 'animal');
    if (!obj) return res.status(404).json({ error: 'Animal not found on your farm' });

    const animalType = db.prepare('SELECT * FROM animal_types WHERE id = ?').get(obj.item_id);
    const last = obj.last_collected_at || obj.created_at;
    const readyAt = last + animalType.production_seconds;
    if (nowSec() < readyAt) return res.status(400).json({ error: 'Not ready yet' });

    if (FEED_RECIPES[obj.item_id]) {
      let state = {};
      try { state = obj.state ? JSON.parse(obj.state) : {}; } catch (e) { state = {}; }
      if (!state.lastFed || state.lastFed < last) {
        return res.status(400).json({ error: 'Feed this animal before collecting — no feed, no product!' });
      }
    }

    db.prepare('UPDATE farm_objects SET last_collected_at = ? WHERE id = ?').run(nowSec(), obj.id);
    addInventory(db, req.userId, animalType.product_item_id, 1);
    const reward = grantRewards(db, req.userId, { coins: 0, xp: 1 });

    res.json({ ok: true, product: animalType.product_item_id, reward });
  });

  return router;
};

// Returns the blocking object (with its def attached) if the given footprint
// overlaps something already there, or null if the spot is clear.
function findOverlap(db, farmId, location, x, y, w, h, excludeId) {
  const objects = db.prepare(
    'SELECT * FROM farm_objects WHERE farm_id = ? AND location = ?' + (excludeId ? ' AND id != ?' : '')
  ).all(...(excludeId ? [farmId, location, excludeId] : [farmId, location]));
  for (const o of objects) {
    const def = lookupDefSync(db, o.object_type, o.item_id);
    const ow = def ? def.width || 1 : 1;
    const oh = def ? def.height || 1 : 1;
    const overlap = x < o.grid_x + ow && x + w > o.grid_x && y < o.grid_y + oh && y + h > o.grid_y;
    if (overlap) return { object: o, def };
  }
  return null;
}

function lookupDefSync(db, type, itemId) {
  const table = type === 'building' ? 'building_types'
    : type === 'decoration' ? 'decoration_types'
    : type === 'animal' ? 'animal_types'
    : 'interior_types';
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(itemId);
}

module.exports.INTERIOR_WIDTH = INTERIOR_WIDTH;
module.exports.INTERIOR_HEIGHT = INTERIOR_HEIGHT;
