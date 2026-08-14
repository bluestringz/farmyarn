// Usage: node server/db/make-admin.js <username>
require('dotenv').config();
const { getDb } = require('./migrate');

const username = process.argv[2];
if (!username) {
  console.error('Usage: node server/db/make-admin.js <username>');
  process.exit(1);
}

const db = getDb();
const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
if (!user) {
  console.error(`No user found with username "${username}"`);
  process.exit(1);
}
db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(user.id);
console.log(`${username} is now an admin. Log in at /admin.html`);
db.close();
