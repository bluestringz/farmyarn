const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  // Fail loudly at boot rather than silently signing tokens with an empty secret.
  throw new Error('JWT_SECRET is not set. Define it in your .env file before starting the server.');
}

function signToken(user, context = 'game') {
  const sv = context === 'admin' ? (user.admin_session_version || 0) : (user.session_version || 0);
  return jwt.sign({ sub: user.id, username: user.username, isAdmin: !!user.is_admin, sv, ctx: context }, JWT_SECRET, {
    expiresIn: '7d',
  });
}

// A JWT stays valid for 7 days regardless of what happens to the account
// afterward — without re-checking the database here, a player banned,
// suspended, or deleted mid-session could keep making API calls with
// their existing token until it naturally expires. requireAuth takes db
// so it can catch that immediately instead.
function requireAuth(db) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing auth token' });
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const user = db.prepare('SELECT is_banned, suspended_until, is_admin, session_version, admin_session_version FROM users WHERE id = ?').get(payload.sub);
      if (!user) return res.status(401).json({ error: 'Account no longer exists' });
      if (user.is_banned) return res.status(403).json({ error: 'This account has been banned' });
      if (user.suspended_until && user.suspended_until > Math.floor(Date.now() / 1000)) {
        const until = new Date(user.suspended_until * 1000).toLocaleString();
        return res.status(403).json({ error: `This account is suspended until ${until}` });
      }
      // Logging in on another device bumps session_version (see auth.js's
      // /login route) — an older token still carrying the previous
      // version means this session has been superseded by a newer login
      // elsewhere, so it's treated the same as an expired/invalid one
      // rather than allowed to keep working alongside the new session.
      // The GAME client and the admin PANEL each get their own separate
      // counter (session_version vs admin_session_version, chosen by
      // payload.ctx) — logging into the game doesn't kick out an open
      // admin panel session for the same account, and vice versa.
      const isAdminCtx = payload.ctx === 'admin';
      const currentSv = isAdminCtx ? (user.admin_session_version || 0) : (user.session_version || 0);
      if ((payload.sv || 0) !== currentSv) {
        return res.status(401).json({ error: 'Logged in from another device' });
      }
      req.userId = payload.sub;
      req.username = payload.username;
      req.isAdmin = !!user.is_admin; // fresh from DB, not the (possibly stale) token claim
      next();
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}

function requireAdmin(req, res, next) {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin access required' });
  next();
}

module.exports = { signToken, requireAuth, requireAdmin, JWT_SECRET };
