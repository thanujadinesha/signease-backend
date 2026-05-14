const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_APP_PASSWORD;
  if (!user || !pass) {
    console.warn('[Email] EMAIL_USER / EMAIL_APP_PASSWORD not set — emails will be logged only');
    return null;
  }
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
  return transporter;
}

async function sendSigningEmail({ to, documentName, signingUrl, message, slotLabel, totalSlots, slotIndex }) {
  const t = getTransporter();
  if (!t) {
    console.log(`[Email] SMTP not configured — would send to ${to}:\n  ${signingUrl}`);
    return;
  }

  const stepText = totalSlots > 1
    ? `You are signer ${slotIndex} of ${totalSlots}.`
    : '';

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0E0E14; margin: 0; padding: 32px 16px; }
  .card { background: #16161F; border: 1px solid #2a2a3d; border-radius: 16px; max-width: 520px; margin: 0 auto; padding: 32px; }
  .logo { font-size: 18px; font-weight: 800; color: #A78BFA; margin-bottom: 24px; }
  h1 { color: #F0EEFF; font-size: 20px; margin: 0 0 8px; }
  p { color: #9D9DB5; font-size: 14px; line-height: 1.6; margin: 0 0 16px; }
  .doc { background: #1C1C28; border: 1px solid #2a2a3d; border-radius: 12px; padding: 14px 16px; margin: 20px 0; display: flex; align-items: center; gap: 12px; }
  .doc-icon { color: #A78BFA; font-size: 20px; }
  .doc-name { color: #F0EEFF; font-weight: 600; font-size: 14px; }
  .msg-box { background: #1C1C28; border-left: 3px solid #8B5CF6; border-radius: 8px; padding: 12px 16px; margin: 16px 0; }
  .btn { display: inline-block; background: #8B5CF6; color: #fff; text-decoration: none; padding: 14px 28px; border-radius: 12px; font-weight: 700; font-size: 15px; margin: 8px 0 20px; }
  .footer { color: #4a4a6a; font-size: 12px; margin-top: 24px; border-top: 1px solid #2a2a3d; padding-top: 16px; }
  .url { color: #8B5CF6; word-break: break-all; font-size: 12px; }
</style></head>
<body>
<div class="card">
  <div class="logo">iSigner</div>
  <h1>You have a document to sign</h1>
  <p>Someone has requested your signature on the following document. ${stepText}</p>
  <div class="doc">
    <span class="doc-icon">📄</span>
    <span class="doc-name">${documentName}</span>
  </div>
  ${message ? `<div class="msg-box"><p style="margin:0;color:#c4c4e0">${message}</p></div>` : ''}
  <a href="${signingUrl}" class="btn">Sign document →</a>
  <p>Or copy this link into your browser:</p>
  <p class="url">${signingUrl}</p>
  <div class="footer">
    <p>This link is unique to you (${to}). Do not share it.<br>Powered by iSigner.</p>
  </div>
</div>
</body>
</html>`;

  await t.sendMail({
    from:    `"iSigner" <${process.env.FROM_EMAIL || process.env.EMAIL_USER}>`,
    to,
    subject: `Action required: Please sign "${documentName}"`,
    html,
  });
}

async function sendCompletionEmail({ to, documentName }) {
  const t = getTransporter();
  if (!t) {
    console.log(`[Email] SMTP not configured — completion notice to ${to}`);
    return;
  }

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0E0E14; margin: 0; padding: 32px 16px; }
  .card { background: #16161F; border: 1px solid #2a2a3d; border-radius: 16px; max-width: 520px; margin: 0 auto; padding: 32px; }
  .logo { font-size: 18px; font-weight: 800; color: #A78BFA; margin-bottom: 24px; }
  h1 { color: #F0EEFF; font-size: 20px; margin: 0 0 8px; }
  p { color: #9D9DB5; font-size: 14px; line-height: 1.6; margin: 0 0 16px; }
  .badge { display: inline-block; background: #34D39920; border: 1px solid #34D39940; color: #34D399; border-radius: 100px; padding: 4px 12px; font-size: 12px; font-weight: 700; margin-bottom: 16px; }
  .footer { color: #4a4a6a; font-size: 12px; margin-top: 24px; border-top: 1px solid #2a2a3d; padding-top: 16px; }
</style></head>
<body>
<div class="card">
  <div class="logo">iSigner</div>
  <div class="badge">All signatures complete</div>
  <h1>Your document is fully signed</h1>
  <p><strong style="color:#F0EEFF">${documentName}</strong> has been signed by all parties. Log in to your iSigner account to download the final signed document.</p>
  <div class="footer"><p>Powered by iSigner.</p></div>
</div>
</body>
</html>`;

  await t.sendMail({
    from:    `"iSigner" <${process.env.FROM_EMAIL || process.env.EMAIL_USER}>`,
    to,
    subject: `All signatures complete: "${documentName}"`,
    html,
  });
}

async function sendReminderEmail({ to, documentName, signingUrl, slotLabel, totalSlots, slotIndex }) {
  const t = getTransporter();
  if (!t) {
    console.log(`[Email] SMTP not configured — reminder to ${to}:\n  ${signingUrl}`);
    return;
  }

  const stepText = totalSlots > 1
    ? `You are signer ${slotIndex} of ${totalSlots}.`
    : '';

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0E0E14; margin: 0; padding: 32px 16px; }
  .card { background: #16161F; border: 1px solid #2a2a3d; border-radius: 16px; max-width: 520px; margin: 0 auto; padding: 32px; }
  .logo { font-size: 18px; font-weight: 800; color: #A78BFA; margin-bottom: 24px; }
  .badge { display: inline-block; background: #F59E0B20; border: 1px solid #F59E0B40; color: #F59E0B; border-radius: 100px; padding: 4px 12px; font-size: 12px; font-weight: 700; margin-bottom: 16px; }
  h1 { color: #F0EEFF; font-size: 20px; margin: 0 0 8px; }
  p { color: #9D9DB5; font-size: 14px; line-height: 1.6; margin: 0 0 16px; }
  .doc { background: #1C1C28; border: 1px solid #2a2a3d; border-radius: 12px; padding: 14px 16px; margin: 20px 0; }
  .doc-name { color: #F0EEFF; font-weight: 600; font-size: 14px; }
  .btn { display: inline-block; background: #F59E0B; color: #fff; text-decoration: none; padding: 14px 28px; border-radius: 12px; font-weight: 700; font-size: 15px; margin: 8px 0 20px; }
  .footer { color: #4a4a6a; font-size: 12px; margin-top: 24px; border-top: 1px solid #2a2a3d; padding-top: 16px; }
  .url { color: #8B5CF6; word-break: break-all; font-size: 12px; }
</style></head>
<body>
<div class="card">
  <div class="logo">iSigner</div>
  <div class="badge">Reminder</div>
  <h1>Your signature is still needed</h1>
  <p>This is a friendly reminder that your signature is awaited on the following document. ${stepText}</p>
  <div class="doc">
    <span class="doc-name">📄 ${documentName}</span>
  </div>
  <a href="${signingUrl}" class="btn">Sign document →</a>
  <p>Or copy this link into your browser:</p>
  <p class="url">${signingUrl}</p>
  <div class="footer">
    <p>This link is unique to you (${to}). Do not share it.<br>Powered by iSigner.</p>
  </div>
</div>
</body>
</html>`;

  await t.sendMail({
    from:    `"iSigner" <${process.env.FROM_EMAIL || process.env.EMAIL_USER}>`,
    to,
    subject: `Reminder: Please sign "${documentName}"`,
    html,
  });
}

async function sendExpiredEmail({ to, documentName }) {
  const t = getTransporter();
  if (!t) {
    console.log(`[Email] SMTP not configured — expired notice to ${to}`);
    return;
  }

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0E0E14; margin: 0; padding: 32px 16px; }
  .card { background: #16161F; border: 1px solid #2a2a3d; border-radius: 16px; max-width: 520px; margin: 0 auto; padding: 32px; }
  .logo { font-size: 18px; font-weight: 800; color: #A78BFA; margin-bottom: 24px; }
  .badge { display: inline-block; background: #F8717120; border: 1px solid #F8717140; color: #F87171; border-radius: 100px; padding: 4px 12px; font-size: 12px; font-weight: 700; margin-bottom: 16px; }
  h1 { color: #F0EEFF; font-size: 20px; margin: 0 0 8px; }
  p { color: #9D9DB5; font-size: 14px; line-height: 1.6; margin: 0 0 16px; }
  .footer { color: #4a4a6a; font-size: 12px; margin-top: 24px; border-top: 1px solid #2a2a3d; padding-top: 16px; }
</style></head>
<body>
<div class="card">
  <div class="logo">iSigner</div>
  <div class="badge">Expired</div>
  <h1>Signing request has expired</h1>
  <p>Your signing request for <strong style="color:#F0EEFF">${documentName}</strong> has expired without being fully signed. You can create a new request from your iSigner dashboard.</p>
  <div class="footer"><p>Powered by iSigner.</p></div>
</div>
</body>
</html>`;

  await t.sendMail({
    from:    `"iSigner" <${process.env.FROM_EMAIL || process.env.EMAIL_USER}>`,
    to,
    subject: `Signing request expired: "${documentName}"`,
    html,
  });
}

module.exports = { sendSigningEmail, sendCompletionEmail, sendReminderEmail, sendExpiredEmail };
