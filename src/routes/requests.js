const express     = require('express');
const crypto      = require('crypto');
const requireAuth = require('../middleware/auth');
const db          = require('../db');

const router = express.Router();

// Only Pro/Premium users can create signing requests
const PRO_TIERS = new Set(['pro', 'premium', 'unlimited']);

// POST /api/requests — create a new signing request
router.post('/', requireAuth, async (req, res) => {
  try {
    const user = await db.query(
      'SELECT tier FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!user.rows[0]) return res.status(404).json({ error: 'User not found' });
    if (!PRO_TIERS.has(user.rows[0].tier)) {
      return res.status(403).json({ error: 'Pro or Premium plan required' });
    }

    const { documentName, documentData, documentType = 'pdf', recipientEmail, message, placements = [] } = req.body;
    if (!documentName || !documentData) {
      return res.status(400).json({ error: 'documentName and documentData are required' });
    }

    const token = crypto.randomBytes(32).toString('hex');

    const result = await db.query(
      `INSERT INTO signing_requests
         (owner_id, document_name, document_data, document_type, recipient_email, message, placements, token)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, token, created_at`,
      [req.user.id, documentName, documentData, documentType, recipientEmail || null, message || null, JSON.stringify(placements), token]
    );

    const row = result.rows[0];
    res.json({ id: row.id, token: row.token, createdAt: row.created_at });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to create signing request' });
  }
});

// GET /api/requests — list owner's signing requests
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, document_name, recipient_email, status, token, created_at, signed_at
       FROM signing_requests
       WHERE owner_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.user.id]
    );
    res.json({
      requests: result.rows.map(r => ({
        id: r.id,
        documentName: r.document_name,
        recipientEmail: r.recipient_email,
        status: r.status,
        token: r.token,
        createdAt: r.created_at,
        signedAt: r.signed_at,
      }))
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to list requests' });
  }
});

// GET /api/requests/:token — get request by token (public)
router.get('/:token', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, document_name, document_data, document_type, recipient_email, message, placements, status, created_at
       FROM signing_requests
       WHERE token = $1`,
      [req.params.token]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Signing request not found' });
    const r = result.rows[0];
    if (r.status === 'signed') return res.status(410).json({ error: 'Already signed' });

    res.json({
      id: r.id,
      documentName: r.document_name,
      documentData: r.document_data,
      documentType: r.document_type,
      recipientEmail: r.recipient_email,
      message: r.message,
      placements: r.placements,
      createdAt: r.created_at,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to get signing request' });
  }
});

// POST /api/requests/:token/sign — recipient signs (public endpoint)
// Records usage against the owner, stores signed PDF
router.post('/:token/sign', async (req, res) => {
  const { signedPdf } = req.body;
  if (!signedPdf) return res.status(400).json({ error: 'signedPdf is required' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the request row
    const reqRow = await client.query(
      `SELECT id, owner_id, document_name, status FROM signing_requests WHERE token = $1 FOR UPDATE`,
      [req.params.token]
    );
    if (!reqRow.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Signing request not found' });
    }
    if (reqRow.rows[0].status === 'signed') {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: 'Already signed' });
    }

    const { owner_id, document_name } = reqRow.rows[0];

    // Check owner's limit
    const TIER_LIMITS = { free: 3, pro: 50, premium: -1, unlimited: -1 };
    const userRow = await client.query(
      'SELECT tier, signatures_used FROM users WHERE id = $1 FOR UPDATE',
      [owner_id]
    );
    const user = userRow.rows[0];
    if (!user) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Owner not found' });
    }
    const limit = TIER_LIMITS[user.tier] ?? 3;
    if (limit >= 0 && user.signatures_used >= limit) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Owner signing limit reached' });
    }

    // Mark request as signed
    await client.query(
      `UPDATE signing_requests SET status = 'signed', signed_at = NOW(), signed_pdf = $1 WHERE token = $2`,
      [signedPdf, req.params.token]
    );

    // Increment owner usage
    await client.query(
      'UPDATE users SET signatures_used = signatures_used + 1 WHERE id = $1',
      [owner_id]
    );

    // Record in signed_documents
    await client.query(
      'INSERT INTO signed_documents (user_id, document_name) VALUES ($1, $2)',
      [owner_id, document_name]
    );

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Failed to sign document' });
  } finally {
    client.release();
  }
});

// GET /api/requests/:token/signed — download signed PDF (owner only, or public link)
router.get('/:token/signed', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT signed_pdf, document_name, status FROM signing_requests WHERE token = $1`,
      [req.params.token]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    const r = result.rows[0];
    if (r.status !== 'signed' || !r.signed_pdf) {
      return res.status(404).json({ error: 'Not signed yet' });
    }
    res.json({ signedPdf: r.signed_pdf, documentName: r.document_name });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to get signed document' });
  }
});

module.exports = router;
