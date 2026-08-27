const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { grantRewards, addInventory, nowSec, xpForLevel, MAX_ENERGY, getTimerSetting, DEFAULT_TIMERS } = require('../lib/gameLogic');
const { DB_PATH } = require('../db/migrate');
const { listOddsFields, oddsKey, getOverrideBp, setOverrideBp, clearOverride } = require('../lib/casinoConfig');
const { getAllStock, setStock, renewStock, removeStock } = require('../lib/shopStock');

module.exports = function adminRoutes(db, onlineUsers, io) {
  const router = express.Router();

  // POST /api/admin/announce { message } — broadcasts to every connected
  // player immediately (like a global chat message, but visually distinct
  // and sent by "the admin panel" rather than any specific player account),
  // and stores it in chat_messages so it also shows up for anyone who's
  // offline right now when they next open the chat log.
  router.post('/announce', (req, res) => {
    const message = (req.body && req.body.message || '').toString().trim();
    if (!message) return res.status(400).json({ error: 'Enter a message' });
    if (message.length > 500) return res.status(400).json({ error: 'Keep it under 500 characters' });

    const info = db.prepare('INSERT INTO chat_messages (from_user_id, to_user_id, message, is_announcement) VALUES (?, NULL, ?, 1)')
      .run(req.userId, message);

    const payload = {
      id: info.lastInsertRowid,
      fromUserId: req.userId,
      fromUsername: 'Announcement',
      message,
      isAnnouncement: true,
      created_at: Math.floor(Date.now() / 1000),
    };
    if (io) io.emit('chat:global', payload);

    res.json({ ok: true, message: payload });
  });

  // POST /api/admin/set-event-place — designates the CALLING admin's own
  // farm as THE Event Place (only one farm can hold this at a time — any
  // previous holder is automatically cleared first). Everyone can visit
  // it like the Market/Park (see /api/farm/event-place), but placing
  // things there stays owner-only, same as any other farm — since only
  // an admin calls this on their OWN farm, that means only this admin can
  // build there.
  router.post('/set-event-place', (req, res) => {
    const farm = db.prepare('SELECT * FROM farms WHERE owner_id = ?').get(req.userId);
    if (!farm) return res.status(404).json({ error: 'Farm not found' });
    db.prepare('UPDATE farms SET is_event_place = 0 WHERE is_event_place = 1').run();
    db.prepare('UPDATE farms SET is_event_place = 1 WHERE id = ?').run(farm.id);
    res.json({ ok: true });
  });

  // POST /api/admin/clear-event-place — wipes the Event Place back to
  // empty (every farm_object removed EXCEPT the farmhouse itself, which
  // can never be deleted — same rule as any other farm), so setting up a
  // new event look doesn't mean manually removing the old one piece by
  // piece. Stays the designated Event Place afterward — this resets the
  // look, it doesn't un-designate it.
  router.post('/clear-event-place', (req, res) => {
    const farm = db.prepare('SELECT * FROM farms WHERE is_event_place = 1').get();
    if (!farm) return res.status(404).json({ error: 'No Event Place is currently set' });
    db.prepare("DELETE FROM farm_objects WHERE farm_id = ? AND item_id != 'farmhouse'").run(farm.id);
    db.prepare("DELETE FROM crops WHERE farm_id = ?").run(farm.id);
    db.prepare("UPDATE farm_tiles SET state = 'grass' WHERE farm_id = ?").run(farm.id);
    res.json({ ok: true });
  });

  // Every catalog table that has a player-facing price, and which
  // column(s) on it are safe to edit — whitelisted so /set-price can't be
  // pointed at an arbitrary table/column via the request body.
  const PRICE_TABLES = {
    crop_types: ['seed_cost', 'sell_price'],
    building_types: ['cost'],
    decoration_types: ['cost'],
    animal_types: ['cost'],
    item_types: ['sell_price', 'energy_restore'],
    interior_types: ['cost'],
  };

  // GET /api/admin/shop-prices — every catalog item across every
  // price-bearing table, flattened into one list the admin panel can
  // render as a single editable table. item_types rows also carry a
  // `displayCategory` ("item_types:animal_product", "item_types:feed",
  // etc., from that table's own `category` column) so the admin panel's
  // filter can split them into their own findable groups — Egg/Milk/Wool/
  // Truffle used to be buried in one big generic "Item/Material" bucket
  // alongside completely unrelated crafting materials and cooked food,
  // making them hard to actually find. Fruit trees (Mango/Apple/Avocado)
  // get the same treatment within decoration_types — produces_item_id
  // being set is what marks a decoration as a fruit tree — so they're
  // not buried among fences/lamps/bonfires either. `table` itself stays
  // the real table name throughout (still what /set-price acts on) —
  // this is purely an extra filtering hint, not a different table.
  router.get('/shop-prices', (req, res) => {
    const rows = [];
    for (const table of Object.keys(PRICE_TABLES)) {
      const items = db.prepare(`SELECT * FROM ${table}`).all();
      for (const item of items) {
        let displayCategory = table;
        if (table === 'item_types') displayCategory = `item_types:${item.category}`;
        else if (table === 'decoration_types' && item.produces_item_id) displayCategory = 'decoration_types:fruit_tree';
        rows.push({
          table, id: item.id, name: item.name,
          displayCategory,
          fields: PRICE_TABLES[table].reduce((acc, f) => { acc[f] = item[f]; return acc; }, {}),
        });
      }
    }
    res.json(rows);
  });

  // POST /api/admin/set-price { table, id, field, value } — edits a
  // single price field on a single catalog item, live, no server restart
  // needed (existing players already own copies of an item at whatever
  // price they originally paid — this only affects future purchases/sales).
  router.post('/set-price', (req, res) => {
    const { table, id, field, value } = req.body || {};
    const allowedFields = PRICE_TABLES[table];
    if (!allowedFields || !allowedFields.includes(field)) {
      return res.status(400).json({ error: 'Unknown table or field' });
    }
    const amount = parseInt(value, 10);
    if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'Invalid price' });
    const info = db.prepare(`UPDATE ${table} SET ${field} = ? WHERE id = ?`).run(amount, id);
    if (info.changes === 0) return res.status(404).json({ error: 'Item not found' });
    res.json({ ok: true });
  });

  // ---- Timers (Admin Panel > ⏱️ Timers) ----
  // Two kinds of tunable timer:
  //  - PER-ITEM: a column that already lives on a specific catalog row
  //    (how long ONE crop type takes to grow, how long ONE animal type
  //    takes to produce). Same shape as PRICE_TABLES above.
  //  - GLOBAL: a rule that applies across every item of a kind at once
  //    (how long ANY unfed animal survives, how long ANY unwatered crop
  //    survives) — these aren't columns on a catalog table, so they're
  //    stored in the game_settings key/value table instead (see
  //    gameLogic.js DEFAULT_TIMERS / getTimerSetting for the read side).
  const TIMER_TABLES = {
    crop_types: ['growth_seconds'],
    animal_types: ['production_seconds'],
    // Trees (growth_seconds — covers all growable decorations, including
    // the plain Tree) AND fruit-tree-specific timers (production/spoil/
    // lifespan — 0 for every non-fruit-tree decoration, so those rows
    // just won't show meaningful values for those extra fields, same as
    // any other per-item field that doesn't apply to a given row).
    decoration_types: ['growth_seconds', 'production_seconds', 'fruit_spoil_seconds', 'lifespan_seconds'],
  };
  const TIMER_FIELD_LABELS = {
    growth_seconds: 'Growth Time', production_seconds: 'Production Time',
    fruit_spoil_seconds: 'Fruit Spoil Time (uncollected)', lifespan_seconds: 'Lifespan (dies after)',
  };

  // key -> { label, category } — category groups these in the admin UI
  // filter alongside the per-item tables (Crops / Animals / Global Rules).
  const GLOBAL_TIMERS = {
    crop_death_unwatered_seconds: { label: 'Crop dies if left unwatered', category: 'crop_types' },
    crop_wither_unharvested_seconds: { label: 'Crop withers if left un-harvested', category: 'crop_types' },
    animal_starve_seconds: { label: 'Animal dies if not fed', category: 'animal_types' },
    animal_cold_death_seconds: { label: 'Animal dies if left cold (no Fireplace/Bonfire nearby at night)', category: 'animal_types' },
  };

  // GET /api/admin/timers — every tunable timer, per-item AND global,
  // flattened into one list the admin panel renders as a single table
  // (with a category filter, same UX as Shop Prices).
  router.get('/timers', (req, res) => {
    const rows = [];
    for (const table of Object.keys(TIMER_TABLES)) {
      const items = db.prepare(`SELECT * FROM ${table}`).all();
      for (const item of items) {
        // Same displayCategory idea as /shop-prices — fruit trees
        // (Mango/Apple/Avocado) get split out of decoration_types'
        // generic bucket so they're not buried among fences/lamps/
        // bonfires, which don't have growth/production/lifespan timers
        // that mean anything anyway.
        const displayCategory = table === 'decoration_types' && item.produces_item_id ? 'decoration_types:fruit_tree' : table;
        for (const field of TIMER_TABLES[table]) {
          rows.push({
            kind: 'item', table, displayCategory, id: item.id, name: item.name, field,
            label: TIMER_FIELD_LABELS[field] || field, valueSeconds: item[field],
          });
        }
      }
    }
    for (const key of Object.keys(GLOBAL_TIMERS)) {
      const def = GLOBAL_TIMERS[key];
      rows.push({
        kind: 'global', table: def.category, displayCategory: def.category, id: key, name: def.label,
        field: key, label: def.label, valueSeconds: getTimerSetting(db, key),
      });
    }
    res.json(rows);
  });

  // POST /api/admin/set-timer { table, id, field, valueSeconds } — edits
  // a PER-ITEM timer column (crop growth time, animal production time).
  router.post('/set-timer', (req, res) => {
    const { table, id, field, valueSeconds } = req.body || {};
    const allowedFields = TIMER_TABLES[table];
    if (!allowedFields || !allowedFields.includes(field)) {
      return res.status(400).json({ error: 'Unknown table or field' });
    }
    const seconds = parseInt(valueSeconds, 10);
    if (!Number.isFinite(seconds) || seconds < 1) return res.status(400).json({ error: 'Enter a duration of at least 1 second' });
    const info = db.prepare(`UPDATE ${table} SET ${field} = ? WHERE id = ?`).run(seconds, id);
    if (info.changes === 0) return res.status(404).json({ error: 'Item not found' });
    res.json({ ok: true });
  });

  // POST /api/admin/set-global-timer { key, valueSeconds } — edits a
  // GLOBAL rule (the animal starve window, crop death/wither windows).
  // Upserts into game_settings; takes effect immediately, no restart
  // needed, since gameLogic.js reads this table live on every farm load.
  router.post('/set-global-timer', (req, res) => {
    const { key, valueSeconds } = req.body || {};
    if (!GLOBAL_TIMERS[key]) return res.status(400).json({ error: 'Unknown timer' });
    const seconds = parseInt(valueSeconds, 10);
    if (!Number.isFinite(seconds) || seconds < 1) return res.status(400).json({ error: 'Enter a duration of at least 1 second' });
    db.prepare('INSERT INTO game_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, seconds);
    res.json({ ok: true });
  });

  // ---- Casino Odds (Admin Panel > 🎰 Casino Odds) ----
  // Every individually-editable win-chance/weight knob across the 3
  // casino machines (see server/lib/casinoConfig.js's listOddsFields for
  // the flattened list) — edits here take effect immediately for every
  // player, since /api/casino/config and /api/casino/bet both read the
  // SAME live-with-overrides config on every request.
  router.get('/casino-odds', (req, res) => {
    const rows = listOddsFields().map((f) => {
      const bp = getOverrideBp(db, oddsKey(f.machine, f.tierId, f.field));
      const value = bp === null ? f.defaultValue : bp / 100;
      return {
        machine: f.machine, tierId: f.tierId, field: f.field, unit: f.unit,
        label: f.label, value, defaultValue: f.defaultValue, isOverridden: bp !== null,
      };
    });
    res.json(rows);
  });

  // POST /api/admin/set-casino-odds { machine, tierId, field, value } —
  // edits one knob. `value` is the real number shown in the admin table
  // (a percent like 0.07, or a slot_777 weight like 1.2) — stored
  // internally as basis points (value*100) since game_settings only
  // holds integers, converted back on every read.
  router.post('/set-casino-odds', (req, res) => {
    const { machine, tierId, field, value } = req.body || {};
    const match = listOddsFields().find((f) => f.machine === machine && f.tierId === tierId && f.field === field);
    if (!match) return res.status(400).json({ error: 'Unknown odds field' });
    const num = parseFloat(value);
    if (!Number.isFinite(num) || num < 0) return res.status(400).json({ error: 'Enter a number 0 or greater' });
    setOverrideBp(db, oddsKey(machine, tierId, field), Math.round(num * 100));
    res.json({ ok: true });
  });

  // POST /api/admin/reset-casino-odds { machine, tierId, field } — clears
  // ONE knob's override, snapping it back to the hardcoded default. Omit
  // all three to reset EVERY casino odds override at once.
  router.post('/reset-casino-odds', (req, res) => {
    const { machine, tierId, field } = req.body || {};
    if (machine && tierId && field) {
      clearOverride(db, oddsKey(machine, tierId, field));
    } else {
      db.prepare("DELETE FROM game_settings WHERE key LIKE 'casino:%'").run();
    }
    res.json({ ok: true });
  });

  // ---- Shop Stock (Admin Panel > 📦 Shop Stock) ----
  // GET /api/admin/shop-stock — every seed/building/decoration/animal/
  // interior in the game, each flagged with its current cap if an admin
  // has set one — items with no cap show as unlimited, exactly like they
  // behave in the actual shop right now.
  router.get('/shop-stock', (req, res) => {
    const stock = getAllStock(db);
    const categoryTables = [
      { category: 'crop', table: 'crop_types' },
      { category: 'building', table: 'building_types' },
      { category: 'decoration', table: 'decoration_types' },
      { category: 'animal', table: 'animal_types' },
      { category: 'interior', table: 'interior_types' },
    ];
    const rows = [];
    for (const { category, table } of categoryTables) {
      // decoration_types is the only one of these with fruit trees mixed
      // in (Mango/Apple/Avocado) — same displayCategory split as
      // /shop-prices and /timers, so Shop Stock can filter them into
      // their own group too instead of burying them among fences/lamps/
      // bonfires. The actual `category` stays the plain 'decoration'
      // throughout (still what set/renew/remove-shop-stock act on) —
      // this is purely an extra filtering hint.
      const selectCols = table === 'decoration_types' ? 'id, name, produces_item_id' : 'id, name';
      const items = db.prepare(`SELECT ${selectCols} FROM ${table}`).all();
      for (const item of items) {
        const s = stock.get(`${category}:${item.id}`);
        const displayCategory = table === 'decoration_types' && item.produces_item_id ? 'decoration:fruit_tree' : category;
        rows.push({
          category, displayCategory, itemId: item.id, name: item.name,
          maxStock: s ? s.maxStock : null,
          currentStock: s ? s.currentStock : null,
          unlimited: !s,
        });
      }
    }
    res.json(rows);
  });

  // POST /api/admin/set-shop-stock { category, itemId, amount } — defines
  // (or redefines) an item's cap AND tops it up to that same number right
  // now, e.g. "set stock to 50" means 50 are available starting now.
  router.post('/set-shop-stock', (req, res) => {
    const { category, itemId, amount } = req.body || {};
    if (!['crop', 'building', 'decoration', 'animal', 'interior'].includes(category)) {
      return res.status(400).json({ error: 'Invalid category' });
    }
    const qty = parseInt(amount, 10);
    if (!Number.isFinite(qty) || qty < 0) return res.status(400).json({ error: 'Enter a stock amount of 0 or more' });
    setStock(db, category, itemId, qty);
    res.json({ ok: true });
  });

  // POST /api/admin/renew-shop-stock { category, itemId } — tops the item
  // back up to its existing cap (e.g. it sold out) without needing to
  // remember or retype the cap number.
  router.post('/renew-shop-stock', (req, res) => {
    const { category, itemId } = req.body || {};
    const ok = renewStock(db, category, itemId);
    if (!ok) return res.status(400).json({ error: 'That item has no stock cap set yet' });
    res.json({ ok: true });
  });

  // POST /api/admin/remove-shop-stock { category, itemId } — lifts the
  // cap entirely; the item goes back to being unlimited.
  router.post('/remove-shop-stock', (req, res) => {
    const { category, itemId } = req.body || {};
    removeStock(db, category, itemId);
    res.json({ ok: true });
  });

  // GET /api/admin/backup — downloads a full, consistent snapshot of the
  // live database as a .db file. Uses better-sqlite3's built-in backup()
  // (not just copying the raw file), which is safe to run while the
  // server keeps reading/writing — it won't hand back a half-written or
  // corrupted copy the way a naive file copy could.
  router.get('/backup', async (req, res) => {
    const tmpPath = path.join(os.tmpdir(), `farmyarn-backup-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    try {
      await db.backup(tmpPath);
      const dateStamp = new Date().toISOString().slice(0, 10);
      res.download(tmpPath, `farmyarn-backup-${dateStamp}.db`, (err) => {
        fs.unlink(tmpPath, () => {}); // clean up the temp copy either way
      });
    } catch (err) {
      fs.unlink(tmpPath, () => {});
      res.status(500).json({ error: 'Backup failed: ' + err.message });
    }
  });

  const restoreUpload = multer({ dest: os.tmpdir(), limits: { fileSize: 200 * 1024 * 1024 } });

  // POST /api/admin/restore — upload a .db backup file to restore from.
  // Doesn't touch the live database immediately (a connection is open on
  // it right now, and swapping the file out from under that is how you
  // get corruption) — instead it's staged as a "pending restore" that
  // getDb() picks up and swaps in the next time the server starts, which
  // is the only moment it's fully safe to do. You still need to restart
  // the service (e.g. via Railway's dashboard) afterward for it to apply.
  router.post('/restore', (req, res) => {
    restoreUpload.single('backup')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      // Quick sanity check: every real SQLite file starts with this exact
      // 16-byte header — catches "wrong file" mistakes before they ever
      // reach the pending-restore slot.
      const header = Buffer.alloc(16);
      const fd = fs.openSync(req.file.path, 'r');
      fs.readSync(fd, header, 0, 16, 0);
      fs.closeSync(fd);
      if (header.toString('utf8', 0, 15) !== 'SQLite format 3') {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: "That doesn't look like a valid SQLite backup file." });
      }

      const pendingPath = DB_PATH + '.restore-pending';
      fs.copyFileSync(req.file.path, pendingPath);
      fs.unlink(req.file.path, () => {});
      res.json({ ok: true, message: 'Backup staged — restart the server for it to take effect.' });
    });
  });

  router.get('/players', (req, res) => {
    const q = (req.query.q || '').toString().trim();
    const cols = 'id, username, display_name, level, xp, energy, coins, premium_currency, gm_points, is_admin, is_banned, suspended_until, created_at, last_login';
    const rows = q
      ? db.prepare(`SELECT ${cols} FROM users WHERE username LIKE ? OR display_name LIKE ? ORDER BY id DESC LIMIT 100`).all(`%${q}%`, `%${q}%`)
      : db.prepare(`SELECT ${cols} FROM users ORDER BY id DESC LIMIT 100`).all();
    // onlineUsers is a live userId -> Set(socketId) map kept by the
    // Socket.IO connection handling in index.js — a user is "online" here
    // exactly when they have at least one open connection.
    rows.forEach((r) => { r.online = onlineUsers.has(r.id); });
    res.json(rows);
  });

  // GET /api/admin/players/export — every player, no 100-row cap (unlike
  // the paginated table above), as a downloadable CSV — so pulling the
  // full username list (or anything else here) into a spreadsheet doesn't
  // require scrolling/searching the in-app table page by page.
  router.get('/players/export', (req, res) => {
    const cols = 'id, username, display_name, level, coins, premium_currency, gm_points, is_admin, is_banned, created_at, last_login';
    const rows = db.prepare(`SELECT ${cols} FROM users ORDER BY id ASC`).all();
    const header = ['id', 'username', 'display_name', 'level', 'coins', 'premium_points', 'gm_points', 'is_admin', 'is_banned', 'created_at', 'last_login'];
    const csvEscape = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const isoOrBlank = (unixSeconds) => (unixSeconds ? new Date(unixSeconds * 1000).toISOString() : '');
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push([
        r.id, r.username, r.display_name || '', r.level, r.coins, r.premium_currency, r.gm_points,
        r.is_admin ? 1 : 0, r.is_banned ? 1 : 0, isoOrBlank(r.created_at), isoOrBlank(r.last_login),
      ].map(csvEscape).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="farmyarn-players.csv"');
    res.send(lines.join('\n'));
  });

  router.get('/players/:id/farm', (req, res) => {
    const farm = db.prepare('SELECT * FROM farms WHERE owner_id = ?').get(req.params.id);
    if (!farm) return res.status(404).json({ error: 'Farm not found' });
    const crops = db.prepare('SELECT * FROM crops WHERE farm_id = ?').all(farm.id);
    const objects = db.prepare('SELECT * FROM farm_objects WHERE farm_id = ?').all(farm.id);
    res.json({ farm, crops, objects });
  });

  router.post('/players/:id/adjust', (req, res) => {
    const { coins = 0, xp = 0 } = req.body || {};
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const result = grantRewards(db, user.id, { coins, xp });
    res.json({ ok: true, result });
  });

  // POST /api/admin/players/:id/set-coins { coins } — sets the EXACT coin
  // balance (unlike /adjust, which only adds/subtracts a delta).
  router.post('/players/:id/set-coins', (req, res) => {
    const coins = parseInt(req.body && req.body.coins, 10);
    if (!Number.isFinite(coins) || coins < 0) return res.status(400).json({ error: 'coins must be a non-negative number' });
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    db.prepare('UPDATE users SET coins = ? WHERE id = ?').run(coins, user.id);
    res.json({ ok: true, coins });
  });

  // POST /api/admin/players/:id/set-energy { energy } — sets the EXACT
  // energy value, capped at MAX_ENERGY.
  router.post('/players/:id/set-energy', (req, res) => {
    const energy = parseInt(req.body && req.body.energy, 10);
    if (!Number.isFinite(energy) || energy < 0) return res.status(400).json({ error: 'energy must be a non-negative number' });
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const capped = Math.min(MAX_ENERGY, energy);
    db.prepare('UPDATE users SET energy = ?, energy_updated_at = ? WHERE id = ?').run(capped, nowSec(), user.id);
    res.json({ ok: true, energy: capped });
  });

  // POST /api/admin/players/:id/set-level { level } — level IS also a
  // stored column (kept in sync with xp by grantRewards() during normal
  // play — see gameLogic.js), so setting it here has to update both: XP to
  // that level's floor, and the level column itself, or the two would
  // disagree until the player's next XP-earning action re-synced it.
  router.post('/players/:id/set-level', (req, res) => {
    const level = parseInt(req.body && req.body.level, 10);
    if (!Number.isFinite(level) || level < 1) return res.status(400).json({ error: 'level must be 1 or higher' });
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const xp = xpForLevel(level);
    db.prepare('UPDATE users SET xp = ?, level = ? WHERE id = ?').run(xp, level, user.id);
    res.json({ ok: true, level, xp });
  });

  // POST /api/admin/players/:id/give-premium { amount } — top up a
  // player's Premium Points, the currency costumes are bought with.
  router.post('/players/:id/give-premium', (req, res) => {
    const amount = parseInt(req.body && req.body.amount, 10);
    if (!Number.isFinite(amount) || amount === 0) return res.status(400).json({ error: 'amount must be a non-zero number' });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const newBalance = Math.max(0, (user.premium_currency || 0) + amount);
    db.prepare('UPDATE users SET premium_currency = ? WHERE id = ?').run(newBalance, user.id);
    res.json({ ok: true, premiumCurrency: newBalance });
  });

  // POST /api/admin/players/:id/give-gm-points { amount } — top up a
  // player's GM Points, the ADMIN-ONLY currency Special Outfits (see
  // outfit_types where currency='gm_points') are bought with. There's no
  // other way for a player to earn these — this is the only route that
  // can grant them, by design.
  router.post('/players/:id/give-gm-points', (req, res) => {
    const amount = parseInt(req.body && req.body.amount, 10);
    if (!Number.isFinite(amount) || amount === 0) return res.status(400).json({ error: 'amount must be a non-zero number' });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const newBalance = Math.max(0, (user.gm_points || 0) + amount);
    db.prepare('UPDATE users SET gm_points = ? WHERE id = ?').run(newBalance, user.id);
    res.json({ ok: true, gmPoints: newBalance });
  });

  router.post('/players/:id/give-item', (req, res) => {
    const { itemId, quantity } = req.body || {};
    if (!itemId || !quantity) return res.status(400).json({ error: 'itemId and quantity required' });
    addInventory(db, req.params.id, itemId, quantity);
    res.json({ ok: true });
  });

  // POST /api/admin/give-item-all { itemId, quantity } — same as give-item
  // above, but to EVERY user in one go (a Best Farm contest bonus, a
  // sitewide apology gift, etc.) instead of needing to repeat the
  // single-player action once per person.
  router.post('/give-item-all', (req, res) => {
    const { itemId, quantity } = req.body || {};
    const qty = parseInt(quantity, 10);
    if (!itemId || !Number.isFinite(qty) || qty < 1) return res.status(400).json({ error: 'itemId and a positive quantity required' });
    const userIds = db.prepare('SELECT id FROM users').all().map((u) => u.id);
    const tx = db.transaction(() => {
      for (const id of userIds) addInventory(db, id, itemId, qty);
    });
    tx();
    res.json({ ok: true, itemId, quantity: qty, playersAffected: userIds.length });
  });

  router.post('/players/:id/ban', (req, res) => {
    const { banned } = req.body || {};
    db.prepare('UPDATE users SET is_banned = ? WHERE id = ?').run(banned ? 1 : 0, req.params.id);
    res.json({ ok: true });
  });

  // POST /api/admin/players/:id/suspend { days } — temporary block, unlike
  // ban which is permanent. days=0 (or omitted) lifts an existing suspension.
  router.post('/players/:id/suspend', (req, res) => {
    const days = parseFloat(req.body && req.body.days);
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!days || days <= 0) {
      db.prepare('UPDATE users SET suspended_until = NULL WHERE id = ?').run(user.id);
      return res.json({ ok: true, suspendedUntil: null });
    }
    const until = Math.floor(Date.now() / 1000) + Math.round(days * 86400);
    db.prepare('UPDATE users SET suspended_until = ? WHERE id = ?').run(until, user.id);
    res.json({ ok: true, suspendedUntil: until });
  });

  // DELETE /api/admin/players/:id — permanently removes the account.
  // Foreign keys are declared ON DELETE CASCADE (and PRAGMA foreign_keys
  // is ON — see db/migrate.js), so this alone cleans up the farm, crops,
  // farm_objects, inventory, owned_outfits, friends, notifications, and
  // chat messages tied to this account. A rented marketplace stall just
  // goes vacant again (ON DELETE SET NULL) instead of being deleted.
  router.delete('/players/:id', (req, res) => {
    const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (req.userId === user.id) return res.status(400).json({ error: "You can't delete your own account from here" });
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    res.json({ ok: true, deleted: user.username });
  });

  router.get('/stats', (req, res) => {
    const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    const totalFarms = db.prepare('SELECT COUNT(*) as c FROM farms').get().c;
    const totalCrops = db.prepare('SELECT COUNT(*) as c FROM crops').get().c;
    const activeToday = db.prepare(`SELECT COUNT(*) as c FROM users WHERE last_login > strftime('%s','now') - 86400`).get().c;
    const onlineNow = onlineUsers.size;
    const pendingPasswordRequests = db.prepare(`SELECT COUNT(*) as c FROM password_reset_requests WHERE status = 'pending'`).get().c;
    res.json({ totalUsers, totalFarms, totalCrops, activeToday, onlineNow, pendingPasswordRequests });
  });

  // GET /api/admin/password-requests — the "mailbox": pending (and a few
  // recent resolved) password-reset requests, newest first.
  router.get('/password-requests', (req, res) => {
    const rows = db.prepare(`
      SELECT prr.id, prr.message, prr.status, prr.created_at, prr.resolved_at,
             u.id AS userId, u.username
      FROM password_reset_requests prr
      JOIN users u ON u.id = prr.user_id
      ORDER BY (prr.status = 'pending') DESC, prr.created_at DESC
      LIMIT 100
    `).all();
    res.json(rows);
  });

  // POST /api/admin/password-requests/:id/resolve { newPassword } — sets
  // the requesting player's password and marks the request handled.
  router.post('/password-requests/:id/resolve', async (req, res) => {
    const request = db.prepare('SELECT * FROM password_reset_requests WHERE id = ?').get(req.params.id);
    if (!request) return res.status(404).json({ error: 'Request not found' });
    const newPassword = (req.body && req.body.newPassword || '').toString();
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

    const newHash = await bcrypt.hash(newPassword, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, request.user_id);
    db.prepare(`UPDATE password_reset_requests SET status = 'resolved', resolved_at = ? WHERE id = ?`)
      .run(nowSec(), request.id);
    res.json({ ok: true });
  });

  // POST /api/admin/password-requests/:id/dismiss — mark handled without
  // changing the password (e.g. it was spam, or handled another way).
  router.post('/password-requests/:id/dismiss', (req, res) => {
    const info = db.prepare(`UPDATE password_reset_requests SET status = 'resolved', resolved_at = ? WHERE id = ?`)
      .run(nowSec(), req.params.id);
    if (info.changes === 0) return res.status(404).json({ error: 'Request not found' });
    res.json({ ok: true });
  });

  return router;
};
