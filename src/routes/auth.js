const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const db      = require('../db');
const requireAuth = require('../middleware/auth');

const router = express.Router();

const TIER_LIMITS = { free: 3, pro: 50, unlimited: -1 };

function makeToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function formatUser(row) {
  const limit = TIER_LIMITS[row.tier] ?? 3;
  const used  = row.signatures_used ?? 0;
  return {
    id:             row.id,
    email:          row.email,
    tier:           row.tier,
    signaturesUsed: used,
    limit,
    remaining:      limit < 0 ? null : Math.max(0, limit - used),
    isUnlimited:    limit < 0,
    createdAt:      row.created_at,
  };
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password)      return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 6)      return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (!email.includes('@'))     return res.status(400).json({ error: 'Enter a valid email address' });

  try {
    const hash   = await bcrypt.hash(password, 12);
    const result = await db.query(
      `INSERT INTO users (email, password_hash)
       VALUES ($1, $2)
       RETURNING id, email, tier, signatures_used, created_at`,
      [email.toLowerCase().trim(), hash]
    );
    const user  = result.rows[0];
    const token = makeToken(user);
    res.status(201).json({ token, user: formatUser(user) });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }
    console.error(e);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    const result = await db.query(
      'SELECT * FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const token = makeToken(user);
    res.json({ token, user: formatUser(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// GET /api/auth/me  (requires token)
router.get('/me', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, email, tier, signatures_used, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json({ user: formatUser(result.rows[0]) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

module.exports = router;
