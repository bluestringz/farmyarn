const express = require('express');
const { nowSec, grantRewards, addInventory, notify } = require('../lib/gameLogic');

const RENT_COST = 100;
const RENT_DURATION_SECONDS = 24 * 3600; // 24 real hours

// A shared, always-on trading hub separate from the system Shop: players
// rent a stall, list several different things from their own inventory at
// their own prices (seeds included — that's the whole point: it's the only
// place seeds can be sold at all, see server/routes/farm.js's /sell route),
// and other players buy directly from them.
module.exports = function marketplaceRoutes(db) {
  const router = express.Router();

  function returnAllListingsToInventory(stallId, ownerId) {
    if (!ownerId) return;
    const listings = db.prepare('SELECT * FROM marketplace_listings WHERE stall_id = ?').all(stallId);
    const t = nowSec();
    for (const listing of listings) {
      if (listing.listing_type === 'outfit') {
        // The costume's own rental clock kept running the whole time it
        // sat in the stall — if it expired before the stall's rental
        // ended (or before the owner pulled it back), there's simply
        // nothing left to hand back, same as it expiring in their closet.
        if (listing.expires_at === null || listing.expires_at > t) {
          restoreOutfitOwnership(ownerId, listing.item_id, listing.expires_at);
        }
      } else if (listing.quantity > 0) {
        addInventory(db, ownerId, listing.item_id, listing.quantity);
      }
    }
    db.prepare('DELETE FROM marketplace_listings WHERE stall_id = ?').run(stallId);
  }

  // Gives (or restores) ownership of a costume to a player at a SPECIFIC
  // expiry time — used both when a sale transfers a costume to its buyer,
  // and when an unsold listing is handed back to its original owner.
  // owned_outfits is UNIQUE(user_id, outfit_id), so if the player already
  // has a row for this costume (e.g. they bought it again in the
  // meantime), this keeps whichever expiry is LATER rather than
  // overwriting it with a possibly-earlier one. NULL means "never
  // expires" and always wins over any finite date.
  function laterExpiry(a, b) {
    if (a === null || b === null) return null;
    return Math.max(a, b);
  }
  function restoreOutfitOwnership(userId, outfitId, expiresAt) {
    const existing = db.prepare('SELECT * FROM owned_outfits WHERE user_id = ? AND outfit_id = ?').get(userId, outfitId);
    if (existing) {
      db.prepare('UPDATE owned_outfits SET expires_at = ? WHERE id = ?').run(laterExpiry(existing.expires_at, expiresAt), existing.id);
    } else {
      db.prepare('INSERT INTO owned_outfits (user_id, outfit_id, acquired_at, expires_at) VALUES (?, ?, ?, ?)').run(userId, outfitId, nowSec(), expiresAt);
    }
  }

  function clearExpiredStalls() {
    const t = nowSec();
    const expired = db.prepare('SELECT id, renter_id FROM marketplace_stalls WHERE rented_until IS NOT NULL AND rented_until < ?').all(t);
    for (const stall of expired) {
      returnAllListingsToInventory(stall.id, stall.renter_id);
      db.prepare('UPDATE marketplace_stalls SET renter_id = NULL, rented_until = NULL WHERE id = ?').run(stall.id);
    }
  }

  // GET /api/marketplace - every stall, with renter username + ALL of its
  // current listings (a stall can carry several different items at once).
  router.get('/', (req, res) => {
    clearExpiredStalls();
    const stalls = db.prepare(`
      SELECT ms.*, COALESCE(u.display_name, u.username) AS renter_username, u.level AS renter_level
      FROM marketplace_stalls ms
      LEFT JOIN users u ON u.id = ms.renter_id
      ORDER BY ms.id
    `).all();
    const listingsStmt = db.prepare('SELECT * FROM marketplace_listings WHERE stall_id = ? ORDER BY created_at');
    res.json(stalls.map((s) => ({
      id: s.id,
      renterId: s.renter_id,
      renterUsername: s.renter_username,
      renterLevel: s.renter_level,
      rentedUntil: s.rented_until,
      isMine: s.renter_id === req.userId,
      listings: listingsStmt.all(s.id).map((l) => ({ id: l.id, itemId: l.item_id, price: l.price, quantity: l.quantity, listingType: l.listing_type, expiresAt: l.expires_at })),
    })));
  });

  // POST /api/marketplace/rent  { stallId }
  router.post('/rent', (req, res) => {
    const { stallId } = req.body || {};
    clearExpiredStalls();

    const alreadyRenting = db.prepare('SELECT id FROM marketplace_stalls WHERE renter_id = ?').get(req.userId);
    if (alreadyRenting) return res.status(400).json({ error: `You're already renting stall #${alreadyRenting.id} — leave it first` });

    const stall = db.prepare('SELECT * FROM marketplace_stalls WHERE id = ?').get(stallId);
    if (!stall) return res.status(404).json({ error: 'Stall not found' });
    if (stall.renter_id) return res.status(400).json({ error: 'That stall is already rented' });

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
    if (user.coins < RENT_COST) return res.status(400).json({ error: `Renting a stall costs ${RENT_COST} coins` });

    db.prepare('UPDATE users SET coins = coins - ? WHERE id = ?').run(RENT_COST, req.userId);
    db.prepare('UPDATE marketplace_stalls SET renter_id = ?, rented_until = ? WHERE id = ?')
      .run(req.userId, nowSec() + RENT_DURATION_SECONDS, stallId);

    const updated = db.prepare('SELECT coins FROM users WHERE id = ?').get(req.userId);
    res.json({ ok: true, stallId, rentedUntil: nowSec() + RENT_DURATION_SECONDS, coins: updated.coins });
  });

  // POST /api/marketplace/list  { itemId, quantity, price } — list something
  // from your inventory for sale at your rented stall, alongside whatever
  // else you already have listed there (seeds work here — the shop won't
  // buy them back, but your own stall will, at whatever price you set).
  // Listing the SAME item again just adds to that existing listing's
  // quantity rather than creating a confusing duplicate row.
  //
  // Costumes (outfit_types ids) are a special case: `quantity` is ignored
  // (always exactly 1 — owned_outfits only ever holds one of a given
  // costume per player) and it comes out of owned_outfits, not the
  // inventory table. Its 7-day rental clock does NOT pause or reset while
  // listed — the expires_at it already has keeps counting down, and that
  // exact expiry is what the buyer ends up with (see /buy below).
  router.post('/list', (req, res) => {
    const { itemId, quantity, price } = req.body || {};
    const unitPrice = parseInt(price, 10);
    if (!unitPrice || unitPrice < 1) return res.status(400).json({ error: 'Invalid price' });

    const stall = db.prepare('SELECT * FROM marketplace_stalls WHERE renter_id = ?').get(req.userId);
    if (!stall) return res.status(400).json({ error: 'Rent a stall first' });

    const outfitType = db.prepare('SELECT * FROM outfit_types WHERE id = ?').get(itemId);
    if (outfitType) {
      if (!outfitType.cost) return res.status(400).json({ error: "That costume can't be sold" }); // the free default — never expires, not a rental
      const owned = db.prepare('SELECT * FROM owned_outfits WHERE user_id = ? AND outfit_id = ?').get(req.userId, itemId);
      if (!owned) return res.status(400).json({ error: "You don't own that costume" });
      if (owned.expires_at !== null && owned.expires_at <= nowSec()) {
        return res.status(400).json({ error: 'That costume has already expired' });
      }
      const alreadyListed = db.prepare("SELECT id FROM marketplace_listings WHERE stall_id = ? AND item_id = ? AND listing_type = 'outfit'").get(stall.id, itemId);
      if (alreadyListed) return res.status(400).json({ error: 'Already listed at your stall' });

      db.prepare('DELETE FROM owned_outfits WHERE id = ?').run(owned.id);
      // Can't keep wearing a costume you no longer own — snap back to the
      // free default, same as if its rental had simply expired.
      const wearer = db.prepare('SELECT equipped_outfit FROM users WHERE id = ?').get(req.userId);
      if (wearer.equipped_outfit === itemId) {
        db.prepare("UPDATE users SET equipped_outfit = 'classic_overalls', dye_color = NULL WHERE id = ?").run(req.userId);
      }
      db.prepare("INSERT INTO marketplace_listings (stall_id, item_id, price, quantity, listing_type, expires_at) VALUES (?, ?, ?, 1, 'outfit', ?)")
        .run(stall.id, itemId, unitPrice, owned.expires_at);
      return res.json({ ok: true, stallId: stall.id, itemId, quantity: 1, price: unitPrice, expiresAt: owned.expires_at });
    }

    const qty = parseInt(quantity, 10);
    if (!qty || qty < 1) return res.status(400).json({ error: 'Invalid quantity' });

    const invRow = db.prepare('SELECT * FROM inventory WHERE user_id = ? AND item_id = ?').get(req.userId, itemId);
    if (!invRow || invRow.quantity < qty) return res.status(400).json({ error: 'Not enough of that item in your inventory' });

    db.prepare('UPDATE inventory SET quantity = quantity - ? WHERE id = ?').run(qty, invRow.id);

    const existing = db.prepare("SELECT * FROM marketplace_listings WHERE stall_id = ? AND item_id = ? AND listing_type = 'item'").get(stall.id, itemId);
    if (existing) {
      // Re-listing the same item updates the price to the new one and adds
      // to the quantity, rather than requiring you to cancel first.
      db.prepare('UPDATE marketplace_listings SET price = ?, quantity = quantity + ? WHERE id = ?')
        .run(unitPrice, qty, existing.id);
    } else {
      db.prepare('INSERT INTO marketplace_listings (stall_id, item_id, price, quantity) VALUES (?, ?, ?, ?)')
        .run(stall.id, itemId, unitPrice, qty);
    }

    res.json({ ok: true, stallId: stall.id, itemId, quantity: qty, price: unitPrice });
  });

  // POST /api/marketplace/remove-listing { listingId } — pulls the
  // remaining unsold quantity of ONE listing back into your inventory,
  // leaving any other items still listed at your stall untouched.
  router.post('/remove-listing', (req, res) => {
    const { listingId } = req.body || {};
    const stall = db.prepare('SELECT * FROM marketplace_stalls WHERE renter_id = ?').get(req.userId);
    if (!stall) return res.status(400).json({ error: "You don't have a rented stall" });

    const listing = db.prepare('SELECT * FROM marketplace_listings WHERE id = ? AND stall_id = ?').get(listingId, stall.id);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });

    if (listing.listing_type === 'outfit') {
      // Same "the clock never stopped" rule as returnAllListingsToInventory
      // — if it expired while sitting in the stall, there's nothing left
      // to pull back.
      if (listing.expires_at === null || listing.expires_at > nowSec()) {
        restoreOutfitOwnership(req.userId, listing.item_id, listing.expires_at);
      }
    } else if (listing.quantity > 0) {
      addInventory(db, req.userId, listing.item_id, listing.quantity);
    }
    db.prepare('DELETE FROM marketplace_listings WHERE id = ?').run(listing.id);
    res.json({ ok: true });
  });

  // POST /api/marketplace/leave — end your rental early. No refund; any
  // remaining listed quantity (all of it, every item) is returned to your
  // inventory first.
  router.post('/leave', (req, res) => {
    const stall = db.prepare('SELECT * FROM marketplace_stalls WHERE renter_id = ?').get(req.userId);
    if (!stall) return res.status(400).json({ error: "You don't have a rented stall" });

    returnAllListingsToInventory(stall.id, req.userId);
    db.prepare('UPDATE marketplace_stalls SET renter_id = NULL, rented_until = NULL WHERE id = ?').run(stall.id);
    res.json({ ok: true });
  });

  // POST /api/marketplace/buy  { listingId, quantity } — pay another player
  // directly for one of their listed items. Server-authoritative:
  // price/availability are re-checked here, never trusted from the client.
  router.post('/buy', (req, res) => {
    const { listingId, quantity } = req.body || {};
    const qty = parseInt(quantity, 10) || 1;
    clearExpiredStalls();

    const listing = db.prepare('SELECT * FROM marketplace_listings WHERE id = ?').get(listingId);
    if (!listing) return res.status(404).json({ error: 'Listing not found — it may have sold out or been removed' });
    const stall = db.prepare('SELECT * FROM marketplace_stalls WHERE id = ?').get(listing.stall_id);
    if (!stall || !stall.renter_id) return res.status(404).json({ error: 'Stall not found or unrented' });
    if (stall.renter_id === req.userId) return res.status(400).json({ error: "You can't buy from your own stall" });

    if (listing.listing_type === 'outfit') {
      // The costume's rental clock kept running the whole time it sat
      // here — if it ran out before anyone bought it, the listing is
      // simply gone, nothing to sell.
      if (listing.expires_at !== null && listing.expires_at <= nowSec()) {
        db.prepare('DELETE FROM marketplace_listings WHERE id = ?').run(listing.id);
        return res.status(400).json({ error: 'That costume expired before you could buy it' });
      }
      const buyer = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
      if (buyer.coins < listing.price) return res.status(400).json({ error: 'Not enough coins' });

      db.prepare('UPDATE users SET coins = coins - ? WHERE id = ?').run(listing.price, req.userId);
      db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').run(listing.price, stall.renter_id);

      // Whatever time was left transfers AS-IS — the buyer does not get a
      // fresh 7 days, they get exactly what the seller had remaining.
      restoreOutfitOwnership(req.userId, listing.item_id, listing.expires_at);
      db.prepare('DELETE FROM marketplace_listings WHERE id = ?').run(listing.id);

      const buyerName = db.prepare('SELECT COALESCE(display_name, username) AS name FROM users WHERE id = ?').get(req.userId).name;
      notify(db, stall.renter_id, 'market_sale', `${buyerName} bought your ${listing.item_id.replace(/_/g, ' ')} costume from your stall for 🪙${listing.price}!`);

      const updatedBuyer = db.prepare('SELECT coins FROM users WHERE id = ?').get(req.userId);
      return res.json({ ok: true, boughtQuantity: 1, totalCost: listing.price, coins: updatedBuyer.coins, expiresAt: listing.expires_at });
    }

    if (listing.quantity < qty) return res.status(400).json({ error: 'Not enough stock left of that listing' });

    const totalCost = listing.price * qty;
    const buyer = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
    if (buyer.coins < totalCost) return res.status(400).json({ error: 'Not enough coins' });

    db.prepare('UPDATE users SET coins = coins - ? WHERE id = ?').run(totalCost, req.userId);
    db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').run(totalCost, stall.renter_id);

    addInventory(db, req.userId, listing.item_id, qty);

    const remaining = listing.quantity - qty;
    if (remaining <= 0) {
      db.prepare('DELETE FROM marketplace_listings WHERE id = ?').run(listing.id);
    } else {
      db.prepare('UPDATE marketplace_listings SET quantity = ? WHERE id = ?').run(remaining, listing.id);
    }

    const buyerName = db.prepare('SELECT COALESCE(display_name, username) AS name FROM users WHERE id = ?').get(req.userId).name;
    notify(db, stall.renter_id, 'market_sale', `${buyerName} bought ${qty}x ${listing.item_id} from your stall for 🪙${totalCost}!`);

    const updatedBuyer = db.prepare('SELECT coins FROM users WHERE id = ?').get(req.userId);
    res.json({ ok: true, boughtQuantity: qty, totalCost, coins: updatedBuyer.coins });
  });

  return router;
};
