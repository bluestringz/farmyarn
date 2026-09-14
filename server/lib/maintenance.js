// server/lib/maintenance.js
// Site-wide maintenance flag, stored as just another row in the existing
// game_settings key/value table (same one Timers/Prices use — see
// gameLogic.js's getTimerSetting) rather than a dedicated column, so no
// schema migration is needed for this. Single indexed PK lookup, so
// reading it fresh on every request (see the middleware in server/index.js)
// is cheap enough not to need an in-memory cache.

const KEY = 'maintenance_mode';

function isMaintenanceMode(db) {
  const row = db.prepare('SELECT value FROM game_settings WHERE key = ?').get(KEY);
  return !!(row && row.value === 1);
}

function setMaintenanceMode(db, enabled) {
  db.prepare('INSERT INTO game_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(KEY, enabled ? 1 : 0);
}

module.exports = { isMaintenanceMode, setMaintenanceMode };
