const cron = require('node-cron');
const db   = require('../db');
const { sendReminderEmail, sendExpiredEmail } = require('../email');

const APP_URL = process.env.APP_URL || 'https://signease.veloxio.cloud';

// Runs every 6 hours
cron.schedule('0 */6 * * *', async () => {
  console.log('[Reminders] Running scheduled check…');
  try {
    await expireOverdueRequests();
    await sendPendingReminders();
  } catch (e) {
    console.error('[Reminders] Error:', e.message);
  }
});

async function expireOverdueRequests() {
  // Mark pending requests past their expires_at as expired and notify owner
  const result = await db.query(
    `UPDATE signing_requests
     SET status = 'expired'
     WHERE status = 'pending'
       AND expires_at IS NOT NULL
       AND expires_at < NOW()
     RETURNING id, document_name, owner_id`,
  );
  for (const row of result.rows) {
    console.log(`[Reminders] Expired request ${row.id} (${row.document_name})`);
    const ownerRow = await db.query('SELECT email FROM users WHERE id = $1', [row.owner_id]);
    if (ownerRow.rows[0]) {
      sendExpiredEmail({ to: ownerRow.rows[0].email, documentName: row.document_name })
        .catch(e => console.error('[Reminders] sendExpiredEmail:', e.message));
    }
  }
}

async function sendPendingReminders() {
  // Find pending requests where:
  //   - reminder_interval IS NOT NULL
  //   - (reminder_sent_at IS NULL AND created_at + interval days < NOW())
  //     OR (reminder_sent_at + interval days < NOW())
  const result = await db.query(
    `SELECT r.id, r.document_name, r.current_slot, r.reminder_interval,
            s.email, s.label, s.slot, s.token,
            r.total_slots
     FROM signing_requests r
     JOIN signing_slots s ON s.request_id = r.id AND s.slot = r.current_slot
     WHERE r.status = 'pending'
       AND r.reminder_interval IS NOT NULL
       AND (
         (r.reminder_sent_at IS NULL AND r.created_at + (r.reminder_interval || ' days')::INTERVAL < NOW())
         OR
         (r.reminder_sent_at IS NOT NULL AND r.reminder_sent_at + (r.reminder_interval || ' days')::INTERVAL < NOW())
       )`,
  );

  for (const row of result.rows) {
    console.log(`[Reminders] Sending reminder for request ${row.id} to ${row.email}`);
    try {
      await sendReminderEmail({
        to:          row.email,
        documentName: row.document_name,
        signingUrl:  `${APP_URL}/sign/${row.token}`,
        slotLabel:   row.label,
        slotIndex:   row.slot,
        totalSlots:  row.total_slots,
      });
      // Update reminder_sent_at
      await db.query(
        `UPDATE signing_requests SET reminder_sent_at = NOW() WHERE id = $1`,
        [row.id],
      );
    } catch (e) {
      console.error(`[Reminders] Failed to send reminder for ${row.id}:`, e.message);
    }
  }
}

console.log('[Reminders] Scheduler registered (runs every 6h)');
