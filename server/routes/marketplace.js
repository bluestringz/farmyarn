const express = require('express');
const { nowSec, grantRewards } = require('../lib/gameLogic');

const RENT_COST = 100;
const RENT_DURATION_SECONDS = 24 * 3600; // 24 real hours

// A shared, always-on trading hub separate from the system Shop: players
// rent a stall, list something from their own inventory at their own price,
// and other players buy directly from them. This is what makes selling your
// harvest to real players (usually cheaper than the system Shop, since two
// players negotiate a price) actually possible, instead of only ever
// selling back to the game itself.
module.exports = function marketplaceRoutes(db) {
  const router = express.Router();

  function clearExpiredStalls() {
    const t = nowSec();
    const expired = db.prepare('SELECT id FROM marketplace_stalls WHERE rented_until IS NOT NULL AND rented_until < ?').all(t);
    if (expired.length) {
      const clear = db.prepare(`
        UPDATE marketplace_stalls SET renter_id = NULL, rented_until = NULL,
          listing_item_id = NULL, listing_price = NULL, listing_quantity = 0
        WHERE id = ?
      `);
      const tx = db.transaction((rows) => rows.forEach((r) => clear.run(r.id)));
      tx(expired);
    }
  }

  // GET /api/marketplace - every stall, with renter username + current listing
  router.get('/', (req, res) => {
    clearExpiredStalls();
    const stalls = db.prepare(`
      SELECT ms.*, COALESCE(u.display_name, u.username) AS renter_username, u.level AS renter_level
      FROM marketplace_stalls ms
      LEFT JOIN users u ON u.id = ms.renter_id
      ORDER BY ms.id
    `).all();
    res.json(stalls.map((s) => ({
      id: s.id,
      renterId: s.renter_id,
      renterUsername: s.renter_username,
      renterLevel: s.renter_level,
      rentedUntil: s.rented_until,
      isMine: s.renter_id === req.userId,
      listing: s.listing_item_id ? {
        itemId: s.listing_item_id,
        price: s.listing_price,
        quantity: s.listing_quantity,
      } : null,
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

  // POST /api/marketplace/list  { itemId, quantity, price } — list something from your
  // inventory for sale at your rented stall. Quantity is moved out of inventory now,
  // so it can't be double-sold or spent elsewhere while listed.
  router.post('/list', (req, res) => {
    const { itemId, quantity, price } = req.body || {};
    const qty = parseInt(quantity, 10);
    const unitPrice = parseInt(price, 10);
    if (!qty || qty < 1) return res.status(400).json({ error: 'Invalid quantity' });
    if (!unitPrice || unitPrice < 1) return res.status(400).json({ error: 'Invalid price' });

    const stall = db.prepare('SELECT * FROM marketplace_stalls WHERE renter_id = ?').get(req.userId);
    if (!stall) return res.status(400).json({ error: 'Rent a stall first' });
    if (stall.listing_item_id) return res.status(400).json({ error: 'Cancel your current listing before listing something new' });

    const invRow = db.prepare('SELECT * FROM inventory WHERE user_id = ? AND item_id = ?').get(req.userId, itemId);
    if (!invRow || invRow.quantity < qty) return res.status(400).json({ error: 'Not enough of that item in your inventory' });

    db.prepare('UPDATE inventory SET quantity = quantity - ? WHERE id = ?').run(qty, invRow.id);
    db.prepare('UPDATE marketplace_stalls SET listing_item_id = ?, listing_price = ?, listing_quantity = ? WHERE id = ?')
      .run(itemId, unitPrice, qty, stall.id);

    res.json({ ok: true, stallId: stall.id, itemId, quantity: qty, price: unitPrice });
  });

  // POST /api/marketplace/cancel-listing — pulls the remaining unsold quantity back
  // into your own inventory.
  router.post('/cancel-listing', (req, res) => {
    const stall = db.prepare('SELECT * FROM marketplace_stalls WHERE renter_id = ?').get(req.userId);
    if (!stall) return res.status(400).json({ error: "You don't have a rented stall" });
    if (!stall.listing_item_id) return res.status(400).json({ error: 'Nothing is currently listed' });

    if (stall.listing_quantity > 0) {
      const { addInventory } = require('../lib/gameLogic');
      addInventory(db, req.userId, stall.listing_item_id, stall.listing_quantity);
    }
    db.prepare('UPDATE marketplace_stalls SET listing_item_id = NULL, listing_price = NULL, listing_quantity = 0 WHERE id = ?')
      .run(stall.id);
    res.json({ ok: true });
  });

  // POST /api/marketplace/leave — end your rental early. No refund; any remaining
  // listed quantity is returned to your inventory first.
  router.post('/leave', (req, res) => {
    const stall = db.prepare('SELECT * FROM marketplace_stalls WHERE renter_id = ?').get(req.userId);
    if (!stall) return res.status(400).json({ error: "You don't have a rented stall" });

    if (stall.listing_quantity > 0) {
      const { addInventory } = require('../lib/gameLogic');
      addInventory(db, req.userId, stall.listing_item_id, stall.listing_quantity);
    }
    db.prepare(`
      UPDATE marketplace_stalls SET renter_id = NULL, rented_until = NULL,
        listing_item_id = NULL, listing_price = NULL, listing_quantity = 0
      WHERE id = ?
    `).run(stall.id);
    res.json({ ok: true });
  });

  // POST /api/marketplace/buy  { stallId, quantity } — pay another player directly for
  // their listed goods. Server-authoritative: price/availability are re-checked here,
  // never trusted from the client.
  router.post('/buy', (req, res) => {
    const { stallId, quantity } = req.body || {};
    const qty = parseInt(quantity, 10) || 1;
    clearExpiredStalls();

    const stall = db.prepare('SELECT * FROM marketplace_stalls WHERE id = ?').get(stallId);
    if (!stall || !stall.renter_id) return res.status(404).json({ error: 'Stall not found or unrented' });
    if (stall.renter_id === req.userId) return res.status(400).json({ error: "You can't buy from your own stall" });
    if (!stall.listing_item_id || stall.listing_quantity < qty) {
      return res.status(400).json({ error: 'Not enough stock at that stall' });
    }

    const totalCost = stall.listing_price * qty;
    const buyer = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
    if (buyer.coins < totalCost) return res.status(400).json({ error: 'Not enough coins' });

    db.prepare('UPDATE users SET coins = coins - ? WHERE id = ?').run(totalCost, req.userId);
    db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').run(totalCost, stall.renter_id);

    const { addInventory, notify } = require('../lib/gameLogic');
    addInventory(db, req.userId, stall.listing_item_id, qty);

    const remaining = stall.listing_quantity - qty;
    if (remaining <= 0) {
      db.prepare('UPDATE marketplace_stalls SET listing_item_id = NULL, listing_price = NULL, listing_quantity = 0 WHERE id = ?').run(stall.id);
    } else {
      db.prepare('UPDATE marketplace_stalls SET listing_quantity = ? WHERE id = ?').run(remaining, stall.id);
    }

    const buyerName = db.prepare('SELECT COALESCE(display_name, username) AS name FROM users WHERE id = ?').get(req.userId).name;
    notify(db, stall.renter_id, 'market_sale', `${buyerName} bought ${qty}x ${stall.listing_item_id} from your stall for 🪙${totalCost}!`);

    const updatedBuyer = db.prepare('SELECT coins FROM users WHERE id = ?').get(req.userId);
    res.json({ ok: true, boughtQuantity: qty, totalCost, coins: updatedBuyer.coins });
  });

  return router;
};
