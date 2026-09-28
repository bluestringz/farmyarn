// Weekly per-player cap on how many seeds of each crop type can be bought
// from the Shop — an anti-hoarding rule, so that when an admin restocks
// seeds (see shopStock.js) one player can't sweep the whole restock before
// anyone else gets a chance.
//
// - The limit is set PER crop by an admin (Admin Panel > Weekly Seed
//   Limits), stored in the same generic game_settings key/value table the
//   timers use. 0 (or never set) means unlimited, so nothing changes until
//   an admin actually sets one.
// - "Weekly" is a fixed calendar week that resets every Monday 12:00 AM
//   Philippine time (UTC+8), not a rolling 7 days from each purchase —
//   easier for players to understand ("resets Monday") and for an admin to
//   reason about. Each player's purchases are counted per (crop, week), so
//   the counter simply starts over at zero when a new week begins.
// - Only Shop purchases count. Seeds received other ways (admin gifts,
//   buying from another player's Marketplace stall) aren't limited here.

const WEEK_OFFSET_SECONDS = 8 * 3600; // Philippine time
const DAY = 86400;

// Which week `nowSec` falls in, and when that week ends (unix seconds).
// Unix day 4 (Jan 5, 1970) was a Monday, which anchors the Monday-based
// week numbering.
function currentWeek(nowSec = Math.floor(Date.now() / 1000)) {
  const localDays = Math.floor((nowSec + WEEK_OFFSET_SECONDS) / DAY);
  const index = Math.floor((localDays - 4) / 7);
  const startLocalDay = 4 + index * 7;
  const resetAt = (startLocalDay + 7) * DAY - WEEK_OFFSET_SECONDS;
  return { index, resetAt };
}

function settingKey(cropId) {
  return `seed_weekly_limit_${cropId}`;
}

// 0 = unlimited
function getSeedWeeklyLimit(db, cropId) {
  const row = db.prepare('SELECT value FROM game_settings WHERE key = ?').get(settingKey(cropId));
  const n = row ? parseInt(row.value, 10) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function setSeedWeeklyLimit(db, cropId, limit) {
  db.prepare('INSERT INTO game_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(settingKey(cropId), limit);
}

// { limit, bought, remaining, resetAt } for one player + crop this week.
// remaining is only meaningful when limit > 0.
function seedLimitStatus(db, userId, cropId, nowSec) {
  const { index, resetAt } = currentWeek(nowSec);
  const limit = getSeedWeeklyLimit(db, cropId);
  const row = db.prepare('SELECT quantity FROM seed_purchases WHERE user_id = ? AND crop_id = ? AND week_index = ?')
    .get(userId, cropId, index);
  const bought = row ? row.quantity : 0;
  return { limit, bought, remaining: limit > 0 ? Math.max(0, limit - bought) : null, resetAt };
}

function recordSeedPurchase(db, userId, cropId, qty, nowSec) {
  const { index } = currentWeek(nowSec);
  db.prepare(`
    INSERT INTO seed_purchases (user_id, crop_id, week_index, quantity) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, crop_id, week_index) DO UPDATE SET quantity = quantity + excluded.quantity
  `).run(userId, cropId, index, qty);
  // Past weeks are never read again — keep the table from growing forever.
  db.prepare('DELETE FROM seed_purchases WHERE week_index < ?').run(index);
}

module.exports = { currentWeek, getSeedWeeklyLimit, setSeedWeeklyLimit, seedLimitStatus, recordSeedPurchase };
