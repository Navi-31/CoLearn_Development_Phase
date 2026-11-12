'use strict';
/**
 * emailService.js – All outbound email logic for CoLearn
 * ─────────────────────────────────────────────────────────────────
 * Single source of truth for:
 *   • Signup OTP emails
 *   • Password-reset OTP emails
 *   • Suite invitation emails
 *
 * Security rules:
 *  - The subject line NEVER contains the OTP.
 *  - Production logs NEVER contain the OTP or SMTP password.
 *  - In development (SMTP unconfigured), OTP IS printed to console
 *    so the developer can test the full flow without real email.
 *
 * Error contract:
 *  - sendOTPEmail() and sendResetOTPEmail() THROW on SMTP failure.
 *    Callers MUST handle the error and return a meaningful HTTP response.
 *    (Previously they swallowed errors and returned success:true — fixed.)
 */

const emailConfig = require('../config/email');

/* ══════════════════════════════════════════════════════════════
   HTML HELPERS
   ══════════════════════════════════════════════════════════════ */

/** Wraps any body content in the CoLearn branded email shell. */
function emailWrapper(bodyContent) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
</head>
<body style="margin:0;padding:20px;background:#e9f7fe;font-family:Inter,Arial,sans-serif;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #dee2e6;box-shadow:0 8px 40px rgba(0,123,255,0.1);">

    <!-- Header -->
    <div style="background:#212529;padding:20px 24px;">
      <span style="color:#fff;font-size:20px;font-weight:800;letter-spacing:0.04em;">🔗 CoLearn</span>
      <span style="color:#6c757d;font-size:12px;margin-left:8px;">Collaborative Learning</span>
    </div>

    <!-- Body -->
    <div style="padding:32px 24px;">
      ${bodyContent}
    </div>

    <!-- Footer -->
    <div style="background:#f8f9fa;padding:14px 24px;border-top:1px solid #dee2e6;text-align:center;">
      <span style="color:#adb5bd;font-size:12px;">
        CoLearn · Collaborative Study Platform<br>
        <span style="font-size:11px;">This is an automated message — please do not reply.</span>
      </span>
    </div>
  </div>
</body>
</html>`;
}

/** Renders the large OTP display box. */
function otpBox(otp) {
  return `
    <div style="background:#e9f7fe;border:2px dashed #007bff;border-radius:12px;padding:28px;text-align:center;margin:20px 0;">
      <div style="font-size:11px;font-weight:700;color:#6c757d;text-transform:uppercase;letter-spacing:0.12em;margin-bottom:12px;">
        Your One-Time Code
      </div>
      <span style="font-size:40px;font-weight:800;letter-spacing:0.3em;color:#004085;font-family:'Courier New',Courier,monospace;">
        ${otp}
      </span>
      <div style="margin-top:14px;font-size:12px;color:#6c757d;">
        ⏱ Valid for <strong>5 minutes</strong> · One-time use only
      </div>
    </div>
    <p style="color:#adb5bd;font-size:12px;margin:0;line-height:1.6;">
      🔒 If you didn't request this code, you can safely ignore this email.<br>
      Never share this code with anyone — CoLearn will never ask for it.
    </p>`;
}

/** Escapes HTML special chars to safely embed user-supplied strings. */
function escapeHtmlEmail(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ══════════════════════════════════════════════════════════════
   CORE SEND HELPER
   ══════════════════════════════════════════════════════════════ */

/**
 * Internal mailer — sends one email via the SMTP transporter.
 *
 * THROWS on failure. Callers must catch and return appropriate HTTP errors.
 *
 * @param {string} toEmail  - Recipient address (always from req.body, never hardcoded)
 * @param {string} subject  - Non-sensitive subject (no OTP)
 * @param {string} html     - Full HTML body
 * @param {string} text     - Plain-text fallback
 * @param {string} purpose  - Human label for logs: 'Signup OTP' | 'Password Reset OTP'
 */
async function sendEmailCore(toEmail, subject, html, text, purpose) {
  const recipient = toEmail.toLowerCase().trim();

  const mailOptions = {
    from:    `"${emailConfig.FROM_NAME}" <${emailConfig.SMTP_USER}>`,
    to:      recipient,
    subject,             // ← never contains OTP
    html,
    text,
  };

  let info;
  try {
    info = await emailConfig.transporter.sendMail(mailOptions);
  } catch (err) {
    // Differentiated log — no secrets exposed
    const msg  = (err.message || '').toLowerCase();
    const code = err.responseCode || err.code || '';

    if (String(code) === '535' || msg.includes('535') || msg.includes('username and password')) {
      console.error(`[Email] ✗ SMTP AUTH FAILURE — check SMTP_PASS in .env | purpose=${purpose}`);
    } else if (msg.includes('econnrefused') || msg.includes('enotfound') || msg.includes('etimedout')) {
      console.error(`[Email] ✗ SMTP CONNECT FAILURE — cannot reach smtp.gmail.com | purpose=${purpose}`);
    } else if (msg.includes('550') || msg.includes('invalid recipient')) {
      console.error(`[Email] ✗ INVALID RECIPIENT — ${recipient} | purpose=${purpose}`);
    } else if (msg.includes('421') || msg.includes('451') || msg.includes('rate') || msg.includes('quota')) {
      console.error(`[Email] ✗ GMAIL RATE LIMIT EXCEEDED — wait 24h | purpose=${purpose}`);
    } else {
      console.error(`[Email] ✗ SEND FAILED — ${err.code || err.message || 'unknown'} | purpose=${purpose}`);
    }

    // Re-throw so the route handler can return a meaningful error to the client
    throw err;
  }

  // Safe success log — no OTP, no subject content
  const div = '─'.repeat(52);
  console.log(`\n${div}`);
  console.log(`  ✅ OTP Email Sent`);
  console.log(`  Recipient  : ${recipient}`);
  console.log(`  Purpose    : ${purpose}`);
  console.log(`  Message-ID : ${info.messageId}`);
  console.log(`${div}\n`);
}

/* ══════════════════════════════════════════════════════════════
   DEV CONSOLE FALLBACK  (SMTP not configured)
   ══════════════════════════════════════════════════════════════ */

/**
 * Prints the OTP to the server console when SMTP is not configured.
 *
 * NOTE: The OTP IS intentionally printed here — this function only
 * runs in development (when SMTP is unconfigured). In production,
 * SMTP must be configured; if it isn't, the caller returns an error.
 *
 * @param {string} purpose   - 'Signup OTP' | 'Password Reset OTP'
 * @param {string} toEmail   - Recipient email
 * @param {string} otp       - Plaintext OTP (safe to log in dev only)
 */
function consoleFallback(purpose, toEmail, otp, requestId) {
  const div = '═'.repeat(56);
  console.log('\n' + div);
  console.log(`  📧 OTP EMAIL (SMTP not configured — DEV mode)`);
  console.log(`  ${div.slice(2)}`);
  if (requestId) console.log(`  Request ID : ${requestId}`);
  console.log(`  Recipient  : ${toEmail}`);
  console.log(`  Purpose    : ${purpose}`);
  console.log(`  OTP Code   : ${otp}`);
  console.log(`  Expires in : 5 minutes`);
  console.log(`  ${div.slice(2)}`);
  console.log(`  To enable real email delivery:`);
  console.log(`  1. Set SMTP_USER=your-gmail@gmail.com in backend/.env`);
  console.log(`  2. Set SMTP_PASS=xxxx-xxxx-xxxx-xxxx (Gmail App Password)`);
  console.log(`  3. Restart the server`);
  console.log(div + '\n');
}

/* ══════════════════════════════════════════════════════════════
   PUBLIC API
   ══════════════════════════════════════════════════════════════ */

/**
 * Send a signup verification OTP email.
 *
 * THROWS if SMTP is configured but send fails.
 * Falls back to console in dev if SMTP is unconfigured (dev only).
 *
 * @param {string} toEmail - The registering user's email (from req.body.email)
 * @param {string} otp     - Plaintext OTP (in body only, never logged in prod)
 */
async function sendOTPEmail(toEmail, otp, requestId) {
  if (!emailConfig.configured) {
    consoleFallback('Signup OTP', toEmail, otp, requestId);
    return;   // dev mode — success without real send
  }

  const html = emailWrapper(`
    <h2 style="margin:0 0 8px;color:#212529;font-size:22px;font-weight:700;">
      Verify Your Email Address
    </h2>
    <p style="color:#6c757d;font-size:14px;margin:0 0 4px;line-height:1.6;">
      Welcome to CoLearn! Use the code below to verify your email address
      and complete your account registration.
    </p>
    ${otpBox(otp)}
    <p style="color:#6c757d;font-size:13px;margin-top:16px;line-height:1.6;">
      Enter this code on the signup page to continue creating your account.
    </p>
  `);

  const text = [
    'Welcome to CoLearn!',
    '',
    'Your email verification code is shown in the email body.',
    'It is valid for 5 minutes and can only be used once.',
    '',
    'Do not share this code with anyone.',
    'If you did not attempt to create a CoLearn account, ignore this email.',
  ].join('\n');

  await sendEmailCore(toEmail, 'CoLearn — Verify Your Email', html, text, 'Signup OTP');
}

/**
 * Send a password-reset OTP email.
 *
 * THROWS if SMTP is configured but send fails.
 * Falls back to console in dev if SMTP is unconfigured.
 *
 * @param {string} toEmail - The account owner's registered email (from Firestore)
 * @param {string} otp     - Plaintext OTP (in body only, never logged in prod)
 */
async function sendResetOTPEmail(toEmail, otp, requestId) {
  if (!emailConfig.configured) {
    consoleFallback('Password Reset OTP', toEmail, otp, requestId);
    return;   // dev mode — success without real send
  }

  const html = emailWrapper(`
    <h2 style="margin:0 0 8px;color:#212529;font-size:22px;font-weight:700;">
      Password Reset Request
    </h2>
    <p style="color:#6c757d;font-size:14px;margin:0 0 4px;line-height:1.6;">
      We received a request to reset the password for your CoLearn account.<br>
      Use the code below to proceed. If you did not request this, ignore this email —
      your password will not change.
    </p>
    ${otpBox(otp)}
    <p style="color:#6c757d;font-size:13px;margin-top:16px;line-height:1.6;">
      Enter this code on the password reset page to set a new password.
    </p>
  `);

  const text = [
    'CoLearn Password Reset',
    '',
    'Your password reset code is shown in the email body.',
    'It is valid for 5 minutes and can only be used once.',
    '',
    'Do not share this code with anyone.',
    'If you did not request a password reset, ignore this email — your password will not change.',
  ].join('\n');

  await sendEmailCore(toEmail, 'CoLearn — Password Reset Code', html, text, 'Password Reset OTP');
}

/**
 * Send a suite invitation email.
 *
 * Does NOT throw on failure — invites are best-effort.
 * The invite code/link is still returned to the host even if email fails.
 *
 * @param {string} toEmail    - Invitee's email address
 * @param {string} suiteName  - Name of the suite
 * @param {string} inviteCode - 5-digit code
 * @param {string} inviteUrl  - Full invite link URL
 */
async function sendInviteEmail(toEmail, suiteName, inviteCode, inviteUrl) {
  if (!emailConfig.configured) {
    const div = '═'.repeat(56);
    console.log('\n' + div);
    console.log(`  📧 Suite Invitation (SMTP not configured — DEV mode)`);
    console.log(`  Recipient  : ${toEmail}`);
    console.log(`  Suite      : ${suiteName}`);
    console.log(`  Code       : ${inviteCode}`);
    console.log(`  Link       : ${inviteUrl}`);
    console.log(div + '\n');
    return;
  }

  const html = emailWrapper(`
    <h2 style="margin:0 0 8px;color:#212529;font-size:22px;font-weight:700;">
      🎉 You're Invited!
    </h2>
    <p style="color:#6c757d;font-size:14px;margin:0 0 16px;line-height:1.6;">
      You've been invited to join a collaborative study suite on
      <strong style="color:#007bff;">CoLearn</strong>.
    </p>

    <!-- Suite name badge -->
    <div style="background:#e9f7fe;border-radius:10px;padding:14px 18px;margin-bottom:20px;border-left:4px solid #007bff;">
      <div style="font-size:11px;font-weight:600;color:#6c757d;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;">Suite Name</div>
      <div style="font-size:18px;font-weight:800;color:#004085;">${escapeHtmlEmail(suiteName)}</div>
    </div>

    <!-- Invite code -->
    <div style="margin-bottom:20px;">
      <div style="font-size:13px;font-weight:600;color:#495057;margin-bottom:8px;">📋 Your 5-Digit Invite Code</div>
      <div style="background:#212529;border-radius:12px;padding:20px;text-align:center;">
        <span style="font-size:40px;font-weight:800;letter-spacing:0.35em;color:#ffffff;font-family:'Courier New',Courier,monospace;">
          ${escapeHtmlEmail(inviteCode)}
        </span>
      </div>
      <p style="color:#adb5bd;font-size:11px;margin:8px 0 0;text-align:center;">
        Enter this code on CoLearn → Home → Join Suite
      </p>
    </div>

    <!-- Divider -->
    <div style="display:flex;align-items:center;gap:12px;margin:20px 0;">
      <div style="flex:1;height:1px;background:#dee2e6;"></div>
      <span style="color:#adb5bd;font-size:12px;font-weight:600;">OR</span>
      <div style="flex:1;height:1px;background:#dee2e6;"></div>
    </div>

    <!-- Invite link button -->
    <div style="text-align:center;margin-bottom:20px;">
      <a href="${inviteUrl}"
         style="display:inline-block;background:linear-gradient(135deg,#007bff,#0056b3);color:#ffffff;
                text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:700;
                font-size:15px;letter-spacing:0.02em;">
        🔗 Click to Join Suite
      </a>
    </div>

    <!-- Link fallback -->
    <div style="background:#f8f9fa;border-radius:8px;padding:12px 14px;margin-bottom:16px;">
      <div style="font-size:11px;color:#6c757d;margin-bottom:4px;">Or copy this link:</div>
      <div style="font-size:11px;color:#007bff;word-break:break-all;font-family:monospace;">${escapeHtmlEmail(inviteUrl)}</div>
    </div>

    <p style="color:#adb5bd;font-size:11px;margin:0;line-height:1.6;">
      ⚠️ This invitation is valid only while the Suite Host is online.<br>
      If the host is offline, request a new invitation.
    </p>
  `);

  const text = [
    `You're invited to join a CoLearn Suite!`,
    ``,
    `Suite: ${suiteName}`,
    ``,
    `5-Digit Invite Code: ${inviteCode}`,
    `(Enter on CoLearn → Home → Join Suite)`,
    ``,
    `Or click the invite link:`,
    inviteUrl,
    ``,
    `This invitation is valid only while the Suite Host is online.`,
  ].join('\n');

  await sendEmailCore(
    toEmail,
    `You're invited to join a CoLearn Suite`,
    html,
    text,
    'Suite Invitation'
  );
}

module.exports = { sendOTPEmail, sendResetOTPEmail, sendInviteEmail };
