const express     = require('express');
const crypto      = require('crypto');
const requireAuth = require('../middleware/auth');
const db          = require('../db');
const { sendSigningEmail, sendCompletionEmail } = require('../email');

const router = express.Router();

const PRO_TIERS  = new Set(['pro', 'premium', 'unlimited']);
const TIER_LIMITS = { free: 3, pro: 50, premium: -1, unlimited: -1 };
const APP_URL    = process.env.APP_URL || 'https://signease.veloxio.cloud';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parsePlacements(raw) {
  if (!raw) return [];
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

// ─── POST /api/requests ───────────────────────────────────────────────────────
// Create multi-signer request (Pro/Premium only)

router.post('/', requireAuth, async (req, res) => {
  const client = await db.pool.connect();
  try {
    const userRow = await client.query('SELECT tier FROM users WHERE id = $1', [req.user.id]);
    if (!userRow.rows[0]) return res.status(404).json({ error: 'User not found' });
    if (!PRO_TIERS.has(userRow.rows[0].tier)) {
      return res.status(403).json({ error: 'Pro or Premium plan required' });
    }

    const { documentName, documentData, documentType = 'pdf', message, placements = [], signers = [] } = req.body;
    if (!documentName || !documentData) return res.status(400).json({ error: 'documentName and documentData are required' });
    if (!signers.length) return res.status(400).json({ error: 'At least one signer is required' });

    const sorted = [...signers].sort((a, b) => a.slot - b.slot);

    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO signing_requests
         (owner_id, document_name, document_data, document_type, message, placements, token,
          signers, current_slot, total_slots)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [req.user.id, documentName, documentData, documentType, message || null,
       JSON.stringify(placements), crypto.randomBytes(32).toString('hex'),
       JSON.stringify(sorted), 1, sorted.length]
    );
    const requestId = result.rows[0].id;

    // Create per-signer slot rows with unique tokens
    const slotRows = [];
    for (const s of sorted) {
      const token = crypto.randomBytes(32).toString('hex');
      const label = s.label || `Person ${s.slot}`;
      await client.query(
        `INSERT INTO signing_slots (request_id, slot, email, label, token) VALUES ($1,$2,$3,$4,$5)`,
        [requestId, s.slot, s.email, label, token]
      );
      slotRows.push({ slot: s.slot, email: s.email, label, token });
    }

    await client.query('COMMIT');

    // Send email to first signer (slot 1)
    const first = slotRows.find(s => s.slot === 1);
    if (first) {
      sendSigningEmail({
        to: first.email,
        documentName,
        signingUrl: `${APP_URL}/sign/${first.token}`,
        message,
        slotLabel: first.label,
        slotIndex: 1,
        totalSlots: sorted.length,
      }).catch(e => console.error('[Email]', e.message));
    }

    res.json({ id: requestId });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(e);
    res.status(500).json({ error: 'Failed to create signing request' });
  } finally {
    client.release();
  }
});

// ─── GET /api/requests ────────────────────────────────────────────────────────
// List owner's requests

router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT r.id, r.document_name, r.status, r.current_slot, r.total_slots, r.created_at,
              COALESCE(json_agg(
                json_build_object('slot', s.slot, 'label', s.label, 'email', s.email, 'signed_at', s.signed_at)
                ORDER BY s.slot
              ) FILTER (WHERE s.id IS NOT NULL), '[]') AS slots
       FROM signing_requests r
       LEFT JOIN signing_slots s ON s.request_id = r.id
       WHERE r.owner_id = $1
       GROUP BY r.id
       ORDER BY r.created_at DESC
       LIMIT 50`,
      [req.user.id]
    );
    res.json({
      requests: result.rows.map(r => ({
        id: r.id,
        documentName: r.document_name,
        status: r.status,
        currentSlot: r.current_slot,
        totalSlots: r.total_slots,
        createdAt: r.created_at,
        slots: r.slots,
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to list requests' });
  }
});

// ─── GET /api/requests/sign/:token ───────────────────────────────────────────
// Public: signer fetches their view (must be registered BEFORE /:id)

router.get('/sign/:token', async (req, res) => {
  try {
    const slotResult = await db.query(
      `SELECT s.id, s.slot, s.label, s.email, s.signed_at,
              r.id AS request_id, r.document_name, r.document_data, r.document_type,
              r.message, r.placements, r.current_slot, r.total_slots, r.status
       FROM signing_slots s
       JOIN signing_requests r ON r.id = s.request_id
       WHERE s.token = $1`,
      [req.params.token]
    );
    if (!slotResult.rows[0]) return res.status(404).json({ error: 'Signing link not found' });
    const row = slotResult.rows[0];

    if (row.signed_at)            return res.status(410).json({ error: 'Already signed' });
    if (row.status === 'completed') return res.status(410).json({ error: 'Document fully signed' });
    if (row.slot !== row.current_slot) {
      return res.status(403).json({
        error: 'not_your_turn',
        message: `It is not your turn yet. You will receive an email when it is your turn to sign.`,
      });
    }

    const allPlacements = parsePlacements(row.placements);

    // Completed slots — fetch signature data
    const completedResult = await db.query(
      `SELECT slot, label, signature_data, signed_at
       FROM signing_slots
       WHERE request_id = $1 AND signed_at IS NOT NULL
       ORDER BY slot`,
      [row.request_id]
    );

    const completedSlots = completedResult.rows.map(s => ({
      slot: s.slot,
      label: s.label,
      signatureData: s.signature_data,
      signedAt: s.signed_at,
      placements: allPlacements.filter(p => p.slot === s.slot),
    }));

    res.json({
      requestId:        row.request_id,
      documentName:     row.document_name,
      documentData:     row.document_data,
      documentType:     row.document_type,
      message:          row.message,
      mySlot:           row.slot,
      myLabel:          row.label,
      myPlacements:     allPlacements.filter(p => p.slot === row.slot),
      futurePlacements: allPlacements.filter(p => p.slot > row.slot),
      completedSlots,
      totalSlots:       row.total_slots,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load signing request' });
  }
});

// ─── POST /api/requests/sign/:token ──────────────────────────────────────────
// Public: signer submits their signature PNG

router.post('/sign/:token', async (req, res) => {
  const { signatureData } = req.body;
  if (!signatureData) return res.status(400).json({ error: 'signatureData is required' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const slotResult = await client.query(
      `SELECT s.id, s.slot, s.label, s.email, s.signed_at,
              r.id AS request_id, r.owner_id, r.document_name, r.current_slot, r.total_slots
       FROM signing_slots s
       JOIN signing_requests r ON r.id = s.request_id
       WHERE s.token = $1
       FOR UPDATE OF s`,
      [req.params.token]
    );
    if (!slotResult.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }

    const row = slotResult.rows[0];
    if (row.signed_at)            { await client.query('ROLLBACK'); return res.status(410).json({ error: 'Already signed' }); }
    if (row.slot !== row.current_slot) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Not your turn' }); }

    // Save signature for this slot
    await client.query(
      `UPDATE signing_slots SET signed_at = NOW(), signature_data = $1 WHERE id = $2`,
      [signatureData, row.id]
    );

    const nextSlot  = row.slot + 1;
    const allDone   = nextSlot > row.total_slots;

    if (allDone) {
      // Mark request complete — record usage against owner
      await client.query(
        `UPDATE signing_requests SET status = 'completed', signed_at = NOW(), current_slot = $1 WHERE id = $2`,
        [nextSlot, row.request_id]
      );

      const userRow = await client.query(
        'SELECT tier, signatures_used FROM users WHERE id = $1 FOR UPDATE',
        [row.owner_id]
      );
      const u = userRow.rows[0];
      if (u) {
        const limit = TIER_LIMITS[u.tier] ?? 3;
        if (limit < 0 || u.signatures_used < limit) {
          await client.query('UPDATE users SET signatures_used = signatures_used + 1 WHERE id = $1', [row.owner_id]);
          await client.query('INSERT INTO signed_documents (user_id, document_name) VALUES ($1,$2)', [row.owner_id, row.document_name]);
        }
      }
    } else {
      await client.query(
        `UPDATE signing_requests SET current_slot = $1 WHERE id = $2`,
        [nextSlot, row.request_id]
      );
    }

    await client.query('COMMIT');

    // Send email notifications after commit
    if (!allDone) {
      const nextRow = await db.query(
        `SELECT email, label, token FROM signing_slots WHERE request_id = $1 AND slot = $2`,
        [row.request_id, nextSlot]
      );
      if (nextRow.rows[0]) {
        const { email, label, token } = nextRow.rows[0];
        sendSigningEmail({
          to: email,
          documentName: row.document_name,
          signingUrl: `${APP_URL}/sign/${token}`,
          message: `${row.label} has signed. It's now your turn.`,
          slotLabel: label,
          slotIndex: nextSlot,
          totalSlots: row.total_slots,
        }).catch(e => console.error('[Email]', e.message));
      }
    } else {
      // Notify owner that all signatures are complete
      const ownerRow = await db.query('SELECT email FROM users WHERE id = $1', [row.owner_id]);
      if (ownerRow.rows[0]) {
        sendCompletionEmail({
          to: ownerRow.rows[0].email,
          documentName: row.document_name,
        }).catch(e => console.error('[Email]', e.message));
      }
    }

    res.json({ success: true, complete: allDone });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(e);
    res.status(500).json({ error: 'Failed to submit signature' });
  } finally {
    client.release();
  }
});

// ─── GET /api/requests/:id ────────────────────────────────────────────────────
// Owner: full detail including signature data for download

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT r.id, r.document_name, r.document_data, r.document_type, r.placements,
              r.status, r.current_slot, r.total_slots, r.created_at,
              COALESCE(json_agg(
                json_build_object(
                  'slot', s.slot, 'label', s.label, 'email', s.email,
                  'signed_at', s.signed_at, 'signature_data', s.signature_data
                ) ORDER BY s.slot
              ) FILTER (WHERE s.id IS NOT NULL), '[]') AS slots
       FROM signing_requests r
       LEFT JOIN signing_slots s ON s.request_id = r.id
       WHERE r.id = $1 AND r.owner_id = $2
       GROUP BY r.id`,
      [req.params.id, req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    const r = result.rows[0];
    res.json({
      id:           r.id,
      documentName: r.document_name,
      documentData: r.document_data,
      documentType: r.document_type,
      placements:   parsePlacements(r.placements),
      status:       r.status,
      currentSlot:  r.current_slot,
      totalSlots:   r.total_slots,
      createdAt:    r.created_at,
      slots:        r.slots,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to get request' });
  }
});

module.exports = router;
