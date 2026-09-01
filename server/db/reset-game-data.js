// Usage: node server/db/reset-game-data.js --confirm
//
// Resets EVERY player's game progress back to exactly what a brand-new
// account starts with — same starting coins/energy/level, a fresh 12x12
// all-grass farm with just a starter Farmhouse, empty Bag, etc. — as if
// everyone re-registered, WITHOUT actually touching the accounts
// themselves: usernames, passwords, display names, and admin status are
// left completely alone, so nobody needs to sign up again or loses their
// login.
//
// This is deliberately a standalone command-line script, not something
// exposed as an in-game admin panel button — it's rare, irreversible, and
// affects every single player at once, so it should take a deliberate
// action on the actual server/database machine, not just a stray click.
//
// Safety:
//   - Running it with NO arguments does a DRY RUN — it prints exactly what
//     it WOULD do (row counts affected) and changes nothing. You have to
//     pass --confirm explicitly to actually perform the reset.
//   - Everything happens inside one database transaction — if anything
//     fails partway through, the whole reset is rolled back rather than
//     leaving the database in a half-reset state.
//   - There is no undo. Take a backup of the database file first if
//     there's any doubt.
require('dotenv').config();
const { getDb } = require('./migrate');
const { initFarmTiles } = require('../lib/gameLogic');

const CONFIRMED = process.argv.includes('--confirm');
const db = getDb();

function run() {
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const farmCount = db.prepare('SELECT COUNT(*) AS c FROM farms').get().c;

  console.log(`Found ${userCount} account(s) and ${farmCount} farm(s).`);
  console.log('');
  console.log('This will, for EVERY account:');
  console.log('  KEEP:   username, password, display name, avatar, gender, admin status, account creation date');
  console.log('  RESET:  coins -> 100, energy -> 1000, level -> 1, xp -> 0, premium points -> 0, GM points -> 0');
  console.log('          equipped outfit -> default starter clothes, dye color -> none, resting/ban/suspension status -> cleared');
  console.log('  WIPE:   the farm itself (back to a fresh 12x12 plot with just a starter Farmhouse), all crops,');
  console.log('          everything placed on the farm, the Bag, Storage Shed, Refrigerator, owned costumes (back to');
  console.log('          just the free starter outfit), Marketplace stall rentals/listings, friend list, chat history,');
  console.log('          notifications, and daily-reward claim history (everyone can claim Day 1 again)');
  console.log('');

  if (!CONFIRMED) {
    console.log('DRY RUN — nothing has been changed. Re-run with --confirm to actually perform the reset:');
    console.log('  node server/db/reset-game-data.js --confirm');
    db.close();
    return;
  }

  const users = db.prepare('SELECT id FROM users').all();

  const tx = db.transaction(() => {
    // Sitewide/shared tables — cleared once, not per-user.
    db.prepare('DELETE FROM chat_messages').run();
    db.prepare('DELETE FROM notifications').run();
    db.prepare('DELETE FROM password_reset_requests').run();
    db.prepare('DELETE FROM help_actions').run();
    db.prepare('DELETE FROM friends').run();
    db.prepare('DELETE FROM daily_rewards_claimed').run();
    db.prepare('DELETE FROM marketplace_listings').run();
    // marketplace_stalls are fixed pre-seeded slots (id is not
    // autoincrement) — clear who's renting each one instead of deleting
    // the rows themselves.
    db.prepare('UPDATE marketplace_stalls SET renter_id = NULL, rented_until = NULL, listing_item_id = NULL, listing_price = NULL, listing_quantity = 0').run();

    for (const { id: userId } of users) {
      // Reset the account's PROGRESS columns back to a fresh signup's
      // defaults — everything else on the row (username, password_hash,
      // display_name, avatar, gender, is_admin, created_at) is left alone.
      db.prepare(`
        UPDATE users SET
          level = 1, xp = 0, coins = 100, premium_currency = 0, gm_points = 0,
          energy = 1000, energy_updated_at = strftime('%s','now'),
          equipped_outfit = NULL, dye_color = NULL,
          is_banned = 0, suspended_until = NULL, is_resting = 0,
          friend_water_count = 0, friend_water_date = NULL
        WHERE id = ?
      `).run(userId);

      db.prepare('DELETE FROM owned_outfits WHERE user_id = ?').run(userId);
      db.prepare('INSERT INTO owned_outfits (user_id, outfit_id) VALUES (?, ?)').run(userId, 'classic_overalls');

      db.prepare('DELETE FROM inventory WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM storage_items WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM fridge_storage WHERE user_id = ?').run(userId);

      const farm = db.prepare('SELECT id FROM farms WHERE owner_id = ?').get(userId);
      if (farm) {
        db.prepare('DELETE FROM crops WHERE farm_id = ?').run(farm.id);
        db.prepare('DELETE FROM farm_objects WHERE farm_id = ?').run(farm.id);
        db.prepare('DELETE FROM farm_tiles WHERE farm_id = ?').run(farm.id);
        db.prepare('UPDATE farms SET width = 12, height = 12, expansion_level = 0 WHERE id = ?').run(farm.id);
        initFarmTiles(db, farm.id, 12, 12);
        // Same starter Farmhouse a brand-new signup gets — see
        // server/routes/auth.js's /register route.
        db.prepare(`
          INSERT INTO farm_objects (farm_id, object_type, item_id, grid_x, grid_y, rotation)
          VALUES (?, 'building', 'farmhouse', 0, 0, 0)
        `).run(farm.id);
      }
    }
  });
  tx();

  console.log(`✅ Done — reset ${users.length} account(s) to a fresh start.`);
  db.close();
}

run();
