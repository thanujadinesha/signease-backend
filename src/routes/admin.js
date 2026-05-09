const express    = require('express');
const requireAdmin = require('../middleware/admin');
const db         = require('../db');

const router = express.Router();
router.use(requireAdmin);

const TIER_LIMITS = { free: 3, pro: 50, premium: -1, unlimited: -1 };

function formatUser(row) {
  const limit = TIER_LIMITS[row.tier] ?? 3;
  const used  = row.signatures_used ?? 0;
  return {
    id:             row.id,
    email:          row.email,
    tier:           row.tier,
    isAdmin:        row.is_admin ?? false,
    signaturesUsed: used,
    documentCount:  parseInt(row.document_count ?? '0', 10),
    limit,
    remaining:      limit < 0 ? null : Math.max(0, limit - used),
    isUnlimited:    limit < 0,
    planExpiresAt:  row.plan_expires_at ?? null,
    extraSeats:     row.extra_seats ?? 0,
    createdAt:      row.created_at,
    lastActivityAt: row.last_activity_at ?? null,
  };
}

// ── GET /api/admin/stats ─────────────────────────────────────────────────────
router.get('/stats', async (_req, res) => {
  try {
    const [usersRes, sigsRes, docsRes, tiersRes, recentRes] = await Promise.all([
      db.query('SELECT COUNT(*) AS total FROM users WHERE is_admin IS NOT TRUE'),
      db.query('SELECT COALESCE(SUM(signatures_used), 0) AS total FROM users'),
      db.query('SELECT COUNT(*) AS total FROM signed_documents'),
      db.query(`
        SELECT tier, COUNT(*) AS count
        FROM users WHERE is_admin IS NOT TRUE
        GROUP BY tier ORDER BY tier
      `),
      db.query(`
        SELECT COUNT(*) AS count
        FROM signed_documents
        WHERE signed_at >= NOW() - INTERVAL '7 days'
      `),
    ]);

    res.json({
      totalUsers:        parseInt(usersRes.rows[0].total, 10),
      totalSignatures:   parseInt(sigsRes.rows[0].total, 10),
      totalDocuments:    parseInt(docsRes.rows[0].total, 10),
      signaturesThisWeek: parseInt(recentRes.rows[0].count, 10),
      tierBreakdown:     tiersRes.rows.map(r => ({ tier: r.tier, count: parseInt(r.count, 10) })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// ── GET /api/admin/users ─────────────────────────────────────────────────────
// Query params: search, tier, page (1-based), limit (default 20)
router.get('/users', async (req, res) => {
  const search = req.query.search?.trim() || '';
  const tier   = req.query.tier  || '';
  const page   = Math.max(1, parseInt(req.query.page  || '1',  10));
  const limit  = Math.min(100, parseInt(req.query.limit || '20', 10));
  const offset = (page - 1) * limit;

  const conditions = ['u.is_admin IS NOT TRUE'];
  const params     = [];

  if (search) {
    params.push(`%${search}%`);
    conditions.push(`u.email ILIKE $${params.length}`);
  }
  if (tier) {
    params.push(tier);
    conditions.push(`u.tier = $${params.length}`);
  }

  const where = conditions.join(' AND ');

  try {
    const [rowsRes, countRes] = await Promise.all([
      db.query(`
        SELECT u.*,
               COUNT(sd.id) AS document_count,
               MAX(sd.signed_at) AS last_activity_at
        FROM users u
        LEFT JOIN signed_documents sd ON sd.user_id = u.id
        WHERE ${where}
        GROUP BY u.id
        ORDER BY u.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `, [...params, limit, offset]),
      db.query(`
        SELECT COUNT(*) AS total FROM users u WHERE ${where}
      `, params),
    ]);

    res.json({
      users: rowsRes.rows.map(formatUser),
      total: parseInt(countRes.rows[0].total, 10),
      page,
      pages: Math.ceil(parseInt(countRes.rows[0].total, 10) / limit),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

// ── GET /api/admin/users/:id ─────────────────────────────────────────────────
router.get('/users/:id', async (req, res) => {
  try {
    const userRes = await db.query(`
      SELECT u.*,
             COUNT(sd.id) AS document_count,
             MAX(sd.signed_at) AS last_activity_at
      FROM users u
      LEFT JOIN signed_documents sd ON sd.user_id = u.id
      WHERE u.id = $1
      GROUP BY u.id
    `, [req.params.id]);

    if (!userRes.rows[0]) return res.status(404).json({ error: 'User not found' });

    const docsRes = await db.query(`
      SELECT id, document_name, signed_at
      FROM signed_documents
      WHERE user_id = $1
      ORDER BY signed_at DESC
      LIMIT 50
    `, [req.params.id]);

    res.json({
      user:      formatUser(userRes.rows[0]),
      documents: docsRes.rows,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load user' });
  }
});

// ── PATCH /api/admin/users/:id ───────────────────────────────────────────────
// Updatable: tier, signatures_used, extra_seats, plan_expires_at
router.patch('/users/:id', async (req, res) => {
  const { tier, signaturesUsed, extraSeats, resetUsage } = req.body ?? {};
  const sets = [];
  const vals = [];

  if (tier !== undefined) {
    const valid = ['free', 'pro', 'premium', 'unlimited'];
    if (!valid.includes(tier)) return res.status(400).json({ error: 'Invalid tier' });
    vals.push(tier); sets.push(`tier = $${vals.length}`);
    if (tier !== 'free') {
      const exp = new Date(); exp.setFullYear(exp.getFullYear() + 1);
      vals.push(exp.toISOString()); sets.push(`plan_expires_at = $${vals.length}`);
    } else {
      sets.push('plan_expires_at = NULL');
    }
  }
  if (resetUsage) {
    sets.push('signatures_used = 0');
  } else if (signaturesUsed !== undefined) {
    vals.push(Math.max(0, parseInt(signaturesUsed, 10)));
    sets.push(`signatures_used = $${vals.length}`);
  }
  if (extraSeats !== undefined) {
    vals.push(Math.max(0, parseInt(extraSeats, 10)));
    sets.push(`extra_seats = $${vals.length}`);
  }

  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

  vals.push(req.params.id);
  try {
    const result = await db.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${vals.length}
       RETURNING id, email, tier, signatures_used, extra_seats, plan_expires_at, created_at, is_admin`,
      vals
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json({ user: formatUser(result.rows[0]) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// ── DELETE /api/admin/users/:id ──────────────────────────────────────────────
router.delete('/users/:id', async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM users WHERE id = $1 AND is_admin IS NOT TRUE RETURNING id',
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found or is an admin' });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// ── GET /api/admin/activity ──────────────────────────────────────────────────
// Recent signing activity across all users
router.get('/activity', async (req, res) => {
  const limit = Math.min(100, parseInt(req.query.limit || '50', 10));
  try {
    const result = await db.query(`
      SELECT sd.id, sd.document_name, sd.signed_at,
             u.id AS user_id, u.email, u.tier
      FROM signed_documents sd
      JOIN users u ON u.id = sd.user_id
      ORDER BY sd.signed_at DESC
      LIMIT $1
    `, [limit]);
    res.json({ activity: result.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load activity' });
  }
});

module.exports = router;
