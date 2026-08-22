// server/lib/shopStock.js
// Optional GLOBAL purchase caps for the Shop (seeds, buildings,
// decorations, animals, interiors) — shared by server/routes/shop.js (the
// actual purchase routes, which must check/consume stock) and
// server/routes/admin.js (the admin panel screen for setting/renewing
// stock), so both always agree on what "out of stock" means.
//
// A missing row for a (category, item_id) pair means "unlimited" — this
// table is opt-in per item, not a blanket restriction, so every item that
// existed before this feature keeps working exactly as it did.

// Returns the stock row for one item, or undefined if it's unlimited
// (no cap has ever been configured for it).
function getStockRow(db, category, itemId) {
  return db.prepare('SELECT * FROM shop_stock WHERE category = ? AND item_id = ?').get(category, itemId);
}

// Returns a Map of "category:item_id" -> { maxStock, currentStock } for
// every item that has a configured cap — used to annotate the shop
// catalog response so the client can show "X left" / grey out a sold-out
// item without a separate round trip per item.
function getAllStock(db) {
  const rows = db.prepare('SELECT category, item_id, max_stock, current_stock FROM shop_stock').all();
  const map = new Map();
  for (const r of rows) map.set(`${r.category}:${r.item_id}`, { maxStock: r.max_stock, currentStock: r.current_stock });
  return map;
}

// Attempts to take `qty` units off an item's stock. Returns
// { ok: true, remaining } on success (or when the item is unlimited —
// remaining is null in that case), or { ok: false, remaining } if there
// isn't enough left — the caller should reject the purchase entirely
// rather than silently buying a partial quantity, so the buyer can retry
// with a smaller amount.
function consumeStock(db, category, itemId, qty) {
  const row = getStockRow(db, category, itemId);
  if (!row) return { ok: true, remaining: null }; // unlimited — nothing to track
  if (row.current_stock < qty) return { ok: false, remaining: row.current_stock };
  db.prepare('UPDATE shop_stock SET current_stock = current_stock - ? WHERE id = ?').run(qty, row.id);
  return { ok: true, remaining: row.current_stock - qty };
}

// Admin action: define (or redefine) an item's cap AND immediately set
// how many are available right now to that same number — "set stock to
// 50" means "there are 50 available starting now", combining configuring
// the cap and restocking into the one action an admin actually wants most
// of the time.
function setStock(db, category, itemId, amount) {
  db.prepare(`
    INSERT INTO shop_stock (category, item_id, max_stock, current_stock)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(category, item_id) DO UPDATE SET max_stock = excluded.max_stock, current_stock = excluded.current_stock
  `).run(category, itemId, amount, amount);
}

// Admin action: top the item back up to its existing cap (e.g. it sold
// out and the admin just wants to restock the same amount as before,
// without having to remember or retype the cap number).
function renewStock(db, category, itemId) {
  const row = getStockRow(db, category, itemId);
  if (!row) return false;
  db.prepare('UPDATE shop_stock SET current_stock = max_stock WHERE id = ?').run(row.id);
  return true;
}

// Admin action: remove the cap entirely — the item goes back to being
// unlimited, same as any item that's never had a cap configured.
function removeStock(db, category, itemId) {
  db.prepare('DELETE FROM shop_stock WHERE category = ? AND item_id = ?').run(category, itemId);
}

module.exports = { getStockRow, getAllStock, consumeStock, setStock, renewStock, removeStock };
