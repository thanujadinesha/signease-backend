const jwt = require('jsonwebtoken');
const db  = require('../db');

// Verifies JWT AND checks is_admin flag in DB
module.exports = async function requireAdmin(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  let payload;
  try {
    payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  try {
    const result = await db.query(
      'SELECT id, email, is_admin FROM users WHERE id = $1',
      [payload.id]
    );
    const user = result.rows[0];
    if (!user || !user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    req.user = { id: user.id, email: user.email, isAdmin: true };
    next();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Auth check failed' });
  }
};
