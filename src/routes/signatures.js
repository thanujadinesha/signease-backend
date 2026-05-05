const express     = require('express');
const requireAuth = require('../middleware/auth');
const db          = require('../db');

const router = express.Router();

const TIER_LIMITS = { free: 3, pro: 50, unlimited: -1 };

// GET /api/signatures/can-sign
router.get('/can-sign', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT tier, signatures_used FROM users WHERE id = $1',
      [req.user.id]
    );
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: 'User not found' });
    const limit   = TIER_LIMITS[row.tier] ?? 3;
    const allowed = limit < 0 || row.signatures_used < limit;
    res.json({ allowed });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to check limit' });
  }
});

// POST /api/signatures/record
router.post('/record', requireAuth, async (req, res) => {
  const { documentName } = req.body ?? {};
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the user row to prevent race conditions
    const check = await client.query(
      'SELECT tier, signatures_used FROM users WHERE id = $1 FOR UPDATE',
      [req.user.id]
    );
    const row = check.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found' });
    }

    const limit = TIER_LIMITS[row.tier] ?? 3;
    if (limit >= 0 && row.signatures_used >= limit) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'LIMIT_REACHED' });
    }

    await client.query(
      'UPDATE users SET signatures_used = signatures_used + 1 WHERE id = $1',
      [req.user.id]
    );
    await client.query(
      'INSERT INTO signed_documents (user_id, document_name) VALUES ($1, $2)',
      [req.user.id, documentName || 'document']
    );

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Failed to record signature' });
  } finally {
    client.release();
  }
});

module.exports = router;
