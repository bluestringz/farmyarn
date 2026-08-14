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
    for (const listing of listings) {
      if (listing.quantity > 0) addInventory(db, ownerId, listing.item_id, listing.quantity);
    }
    db.prepare('DELETE FROM marketplace_listings WHERE stall_id = ?').run(stallId);
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
      listings: listingsStmt.all(s.id).map((l) => ({ id: l.id, itemId: l.item_id, price: l.price, quantity: l.quantity })),
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
  router.post('/list', (req, res) => {
    const { itemId, quantity, price } = req.body || {};
    const qty = parseInt(quantity, 10);
    const unitPrice = parseInt(price, 10);
    if (!qty || qty < 1) return res.status(400).json({ error: 'Invalid quantity' });
    if (!unitPrice || unitPrice < 1) return res.status(400).json({ error: 'Invalid price' });

    const stall = db.prepare('SELECT * FROM marketplace_stalls WHERE renter_id = ?').get(req.userId);
    if (!stall) return res.status(400).json({ error: 'Rent a stall first' });

    const invRow = db.prepare('SELECT * FROM inventory WHERE user_id = ? AND item_id = ?').get(req.userId, itemId);
    if (!invRow || invRow.quantity < qty) return res.status(400).json({ error: 'Not enough of that item in your inventory' });

    db.prepare('UPDATE inventory SET quantity = quantity - ? WHERE id = ?').run(qty, invRow.id);

    const existing = db.prepare('SELECT * FROM marketplace_listings WHERE stall_id = ? AND item_id = ?').get(stall.id, itemId);
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

    if (listing.quantity > 0) addInventory(db, req.userId, listing.item_id, listing.quantity);
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
