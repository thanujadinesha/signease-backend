const express     = require('express');
const requireAuth = require('../middleware/auth');
const db          = require('../db');

const router = express.Router();

const TIER_LIMITS = { free: 3, pro: 50, premium: -1, unlimited: -1 };

// GET /api/profile
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, email, tier, signatures_used, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: 'User not found' });

    const limit = TIER_LIMITS[row.tier] ?? 3;
    const used  = row.signatures_used ?? 0;

    res.json({
      id:             row.id,
      email:          row.email,
      tier:           row.tier,
      signaturesUsed: used,
      limit,
      remaining:      limit < 0 ? null : Math.max(0, limit - used),
      isUnlimited:    limit < 0,
      createdAt:      row.created_at,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

module.exports = router;
