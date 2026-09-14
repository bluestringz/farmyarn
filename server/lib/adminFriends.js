// server/lib/adminFriends.js
// Admin accounts are kept auto-friended with every player, both ways, so
// an admin's Friends list (see public/js/ui.js renderFriends) always has
// a "Visit" button for literally every farm in the game — no manual
// friend requests needed to go look at (or screenshot) anyone's farm.

// Friends one specific admin with every other user. Safe to call
// repeatedly (only touches pairs that aren't already 'accepted').
function friendAdminWithAllUsers(db, adminId) {
  const users = db.prepare('SELECT id FROM users WHERE id != ?').all(adminId);
  const existing = db.prepare('SELECT id, requester_id, receiver_id, status FROM friends WHERE requester_id = ? OR receiver_id = ?').all(adminId, adminId);
  const existingByOther = new Map();
  for (const row of existing) {
    const otherId = row.requester_id === adminId ? row.receiver_id : row.requester_id;
    existingByOther.set(otherId, row);
  }
  const insert = db.prepare(`INSERT INTO friends (requester_id, receiver_id, status) VALUES (?, ?, 'accepted')`);
  const accept = db.prepare(`UPDATE friends SET status = 'accepted' WHERE id = ?`);
  const tx = db.transaction(() => {
    for (const u of users) {
      const row = existingByOther.get(u.id);
      if (!row) {
        insert.run(adminId, u.id);
      } else if (row.status !== 'accepted') {
        accept.run(row.id);
      }
    }
  });
  tx();
}

// Friends a brand-new user with every existing admin — called right after
// registration so a fresh account is immediately visitable by admins
// without needing the boot-time sweep below.
function friendNewUserWithAllAdmins(db, newUserId) {
  const admins = db.prepare('SELECT id FROM users WHERE is_admin = 1 AND id != ?').all(newUserId);
  const insert = db.prepare(`INSERT OR IGNORE INTO friends (requester_id, receiver_id, status) VALUES (?, ?, 'accepted')`);
  for (const admin of admins) insert.run(admin.id, newUserId);
}

// Boot-time safety net: makes sure EVERY current admin is friended with
// EVERY current user, in case an account was promoted to admin directly
// in the database, or existing data predates this feature.
function ensureAllAdminsFriendedWithEveryone(db) {
  const admins = db.prepare('SELECT id FROM users WHERE is_admin = 1').all();
  for (const admin of admins) friendAdminWithAllUsers(db, admin.id);
}

module.exports = { friendAdminWithAllUsers, friendNewUserWithAllAdmins, ensureAllAdminsFriendedWithEveryone };
