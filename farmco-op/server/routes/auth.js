const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { signToken } = require('../middleware/auth');
const { initFarmTiles, nowSec, MAX_ENERGY } = require('../lib/gameLogic');

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later.' },
});

module.exports = function authRoutes(db) {
  const router = express.Router();
  router.use(authLimiter);

  router.post('/register', async (req, res) => {
    try {
      const { username, password, gender } = req.body || {};
      if (typeof username !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ error: 'Username and password are required' });
      }
      if (!USERNAME_RE.test(username)) {
        return res.status(400).json({ error: 'Username must be 3-20 characters: letters, numbers, underscore' });
      }
      if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }
      const genderValue = gender === 'female' ? 'female' : 'male';
      const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
      if (existing) {
        return res.status(409).json({ error: 'Username already taken' });
      }

      const passwordHash = await bcrypt.hash(password, 12);
      const insertUser = db.prepare(`
        INSERT INTO users (username, password_hash, gender, equipped_outfit, created_at, last_login)
        VALUES (?, ?, ?, 'classic_overalls', ?, ?)
      `);
      const info = insertUser.run(username, passwordHash, genderValue, nowSec(), nowSec());
      const userId = info.lastInsertRowid;

      db.prepare('INSERT OR IGNORE INTO owned_outfits (user_id, outfit_id) VALUES (?, ?)')
        .run(userId, 'classic_overalls');

      const insertFarm = db.prepare(`
        INSERT INTO farms (owner_id, farm_name, width, height, expansion_level)
        VALUES (?, ?, 12, 12, 0)
      `);
      const farmInfo = insertFarm.run(userId, `${username}'s Farm`);
      initFarmTiles(db, farmInfo.lastInsertRowid, 12, 12);

      // Place a starter farmhouse so the farm isn't empty on first login.
      db.prepare(`
        INSERT INTO farm_objects (farm_id, object_type, item_id, grid_x, grid_y, rotation)
        VALUES (?, 'building', 'farmhouse', 0, 0, 0)
      `).run(farmInfo.lastInsertRowid);

      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      const token = signToken(user);
      return res.status(201).json({
        token,
        user: publicUser(user),
      });
    } catch (err) {
      console.error('register error', err);
      return res.status(500).json({ error: 'Registration failed' });
    }
  });

  router.post('/login', async (req, res) => {
    try {
      const { username, password } = req.body || {};
      if (typeof username !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ error: 'Username and password are required' });
      }
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
      if (!user) return res.status(401).json({ error: 'Invalid username or password' });
      if (user.is_banned) return res.status(403).json({ error: 'This account has been banned' });

      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) return res.status(401).json({ error: 'Invalid username or password' });

      db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(nowSec(), user.id);
      const token = signToken(user);
      return res.json({ token, user: publicUser(user) });
    } catch (err) {
      console.error('login error', err);
      return res.status(500).json({ error: 'Login failed' });
    }
  });

  return router;
};

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name || null,
    avatar: user.avatar,
    gender: user.gender,
    equippedOutfit: user.equipped_outfit,
    dyeColor: user.dye_color,
    level: user.level,
    xp: user.xp,
    coins: user.coins,
    premiumCurrency: user.premium_currency,
    energy: user.energy,
    maxEnergy: MAX_ENERGY,
    isAdmin: !!user.is_admin,
  };
}

module.exports.publicUser = publicUser;
