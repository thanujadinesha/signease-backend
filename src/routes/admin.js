const express      = require('express');
const requireAdmin = require('../middleware/admin');
const db           = require('../db');

const router = express.Router();
router.use(requireAdmin);

function parsePlacements(raw) {
  if (!raw) return [];
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return []; }
}

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
    const [usersRes, sigsRes, docsRes, tiersRes, recentRes, reqRes, slotsRes, placementsRes] = await Promise.all([
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
      db.query('SELECT COUNT(*) AS total FROM signing_requests'),
      db.query('SELECT COUNT(*) AS total FROM signing_slots WHERE signed_at IS NOT NULL'),
      db.query(`SELECT COALESCE(SUM(json_array_length(placements::json)), 0) AS total
                FROM signing_requests WHERE status = 'completed'`),
    ]);

    res.json({
      totalUsers:           parseInt(usersRes.rows[0].total, 10),
      totalSignatures:      parseInt(sigsRes.rows[0].total, 10),
      totalDocuments:       parseInt(docsRes.rows[0].total, 10),
      signaturesThisWeek:   parseInt(recentRes.rows[0].count, 10),
      tierBreakdown:        tiersRes.rows.map(r => ({ tier: r.tier, count: parseInt(r.count, 10) })),
      totalRequests:        parseInt(reqRes.rows[0].total, 10),
      totalSlotsCompleted:  parseInt(slotsRes.rows[0].total, 10),
      totalPlacementsApplied: parseInt(placementsRes.rows[0].total, 10),
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

// ── GET /api/admin/requests ──────────────────────────────────────────────────
// All signing requests across all users
router.get('/requests', async (req, res) => {
  const limit  = Math.min(200, parseInt(req.query.limit || '100', 10));
  const search = req.query.search?.trim() || '';
  const status = req.query.status || '';

  const conditions = [];
  const params = [];

  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(r.document_name ILIKE $${params.length} OR u.email ILIKE $${params.length})`);
  }
  if (status) {
    params.push(status);
    conditions.push(`r.status = $${params.length}`);
  }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  try {
    const result = await db.query(`
      SELECT r.id, r.document_name, r.status, r.created_at, r.total_slots, r.placements,
             u.id AS owner_id, u.email AS owner_email, u.tier AS owner_tier,
             COUNT(s.id) FILTER (WHERE s.signed_at IS NOT NULL) AS signed_slots,
             COALESCE(json_agg(
               json_build_object('slot', s.slot, 'label', s.label, 'email', s.email, 'signed_at', s.signed_at)
               ORDER BY s.slot
             ) FILTER (WHERE s.id IS NOT NULL), '[]') AS slots
      FROM signing_requests r
      JOIN users u ON u.id = r.owner_id
      LEFT JOIN signing_slots s ON s.request_id = r.id
      ${where}
      GROUP BY r.id, u.id
      ORDER BY r.created_at DESC
      LIMIT $${params.length + 1}
    `, [...params, limit]);

    res.json({
      requests: result.rows.map(r => ({
        id:               r.id,
        documentName:     r.document_name,
        status:           r.status,
        createdAt:        r.created_at,
        totalSlots:       r.total_slots,
        signedSlots:      parseInt(r.signed_slots || '0', 10),
        totalPlacements:  parsePlacements(r.placements).length,
        ownerId:          r.owner_id,
        ownerEmail:       r.owner_email,
        ownerTier:        r.owner_tier,
        slots:            r.slots || [],
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load requests' });
  }
});

// ── GET /api/admin/activity ──────────────────────────────────────────────────
// All activity: quick-sign events + multi-signer slot events
router.get('/activity', async (req, res) => {
  const limit = Math.min(200, parseInt(req.query.limit || '100', 10));
  try {
    const result = await db.query(`
      SELECT type, id, document_name, signed_at, user_id, email, tier,
             signer_email, request_id, slot_info
      FROM (
        SELECT 'quick_sign'  AS type, sd.id::text, sd.document_name, sd.signed_at,
               u.id::text AS user_id, u.email, u.tier,
               NULL::text AS signer_email, NULL::text AS request_id, NULL::text AS slot_info
        FROM signed_documents sd
        JOIN users u ON u.id = sd.user_id

        UNION ALL

        SELECT 'slot_signed' AS type, ss.id::text, r.document_name, ss.signed_at,
               u.id::text AS user_id, u.email, u.tier,
               ss.email AS signer_email, r.id::text AS request_id,
               json_build_object('slot', ss.slot, 'label', ss.label, 'totalSlots', r.total_slots)::text AS slot_info
        FROM signing_slots ss
        JOIN signing_requests r ON r.id = ss.request_id
        JOIN users u ON u.id = r.owner_id
        WHERE ss.signed_at IS NOT NULL
      ) combined
      ORDER BY signed_at DESC
      LIMIT $1
    `, [limit]);

    res.json({
      activity: result.rows.map(r => ({
        ...r,
        slotInfo: r.slot_info ? JSON.parse(r.slot_info) : null,
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load activity' });
  }
});

module.exports = router;
