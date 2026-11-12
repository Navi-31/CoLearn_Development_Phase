'use strict';
/**
 * email.js – Nodemailer SMTP transporter configuration
 * ─────────────────────────────────────────────────────────────────
 * PRODUCTION-GRADE requirements:
 *  • transporter.verify() called on startup — SMTP auth failures are
 *    logged immediately, not silently at first send
 *  • Connection/socket timeouts prevent hung requests
 *  • Clear differentiated error messages for every Gmail failure mode
 *  • emailConfig.verified tracks the live verified state
 *  • consoleFallback in dev mode DOES print the OTP (dev-only)
 *    because a developer with no SMTP must be able to test the flow
 */

const nodemailer = require('nodemailer');

const SMTP_USER = (process.env.SMTP_USER || '').trim();
const SMTP_PASS = (process.env.SMTP_PASS || '').trim();
const FROM_NAME = (process.env.EMAIL_FROM_NAME || 'CoLearn').trim();
const IS_PROD   = process.env.NODE_ENV === 'production';

let transporter = null;
let configured   = false;
let verified     = false;   // true only after transporter.verify() succeeds

/* ── Human-readable diagnostics for common Gmail SMTP errors ──── */
function diagnoseSmtpError(err) {
  const msg = (err.message || '').toLowerCase();
  const code = (err.responseCode || err.code || 0);

  if (code === 535 || msg.includes('535') || msg.includes('username and password not accepted')) {
    return [
      '  ✗ SMTP AUTH FAILED — Gmail rejected the credentials.',
      '  ',
      '  Most common causes:',
      '  1. You used your normal Gmail password instead of an App Password.',
      '     → Go to https://myaccount.google.com/apppasswords',
      '     → Create a new App Password for "Mail"',
      '     → Paste the 16-char code (no spaces) into SMTP_PASS in backend/.env',
      '  2. 2-Step Verification is not enabled on the Gmail account.',
      '     → https://myaccount.google.com/security → "2-Step Verification" → Turn On',
      '  3. The App Password was revoked or the account is locked.',
      '     → Sign in to https://mail.google.com and check for security alerts.',
    ];
  }

  if (msg.includes('econnrefused') || msg.includes('enotfound') || msg.includes('etimedout')) {
    return [
      '  ✗ SMTP CONNECTION FAILED — Cannot reach smtp.gmail.com.',
      '  ',
      '  Most common causes:',
      '  1. No internet connection or a firewall is blocking port 587.',
      '  2. Corporate/campus network blocking outbound SMTP.',
      '     → Try on a mobile hotspot to confirm.',
      '  3. VPN interfering with the connection.',
    ];
  }

  if (code === 421 || code === 451 || msg.includes('rate') || msg.includes('quota')) {
    return [
      '  ✗ GMAIL RATE LIMIT / QUOTA EXCEEDED.',
      '  → Wait 24 hours before retrying.',
      '  → Consider using a dedicated transactional email service (SendGrid, Mailgun) for production.',
    ];
  }

  if (msg.includes('invalid login') || msg.includes('5.7.8')) {
    return [
      '  ✗ GMAIL SECURITY BLOCK — Google blocked the sign-in attempt.',
      '  → Sign in to https://mail.google.com and approve the sign-in.',
      '  → Check https://myaccount.google.com/security for security alerts.',
      '  → Ensure the Gmail account has 2-Step Verification enabled.',
    ];
  }

  return [`  ✗ SMTP ERROR: ${err.message || 'Unknown'}  (code: ${code || 'N/A'})`];
}

/* ── Initialise and verify the transporter ───────────────────── */
async function init() {
  if (!SMTP_USER || !SMTP_PASS) {
    console.warn('');
    console.warn('  ⚠️  SMTP NOT CONFIGURED');
    console.warn('  ─────────────────────────────────────────────────');
    console.warn('  SMTP_USER and/or SMTP_PASS missing in backend/.env');
    console.warn('  OTPs will be printed to the server console (dev mode).');
    console.warn('  Set SMTP_USER and SMTP_PASS to enable real email delivery.');
    console.warn('  ─────────────────────────────────────────────────');
    console.warn('');
    return;
  }

  transporter = nodemailer.createTransport({
    host:   'smtp.gmail.com',
    port:   587,
    secure: false,              // STARTTLS (upgrade after connect)
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
    tls: {
      // Enforce strict TLS certificate verification unless explicitly overridden
      rejectUnauthorized: process.env.SMTP_IGNORE_TLS !== 'true',
    },
    connectionTimeout: 10000,   // 10 s – fail fast if Gmail unreachable
    socketTimeout:     15000,   // 15 s – fail fast if send stalls
    greetingTimeout:   10000,   // 10 s – fail fast on bad handshake
  });

  configured = true;
  console.log(`📧  SMTP configured → ${SMTP_USER}`);

  // ── Live verification ────────────────────────────────────────
  // transporter.verify() opens a real TCP connection to Gmail and
  // checks AUTH. Failures are logged with actionable diagnostics.
  // The server still starts normally — email is non-critical.
  try {
    await transporter.verify();
    verified = true;
    console.log(`  ✅ SMTP Connected — Gmail authentication successful`);
  } catch (err) {
    verified    = false;
    configured  = false;   // treat as unconfigured so fallback kicks in
    transporter = null;

    const lines = [
      '',
      '  ╔══════════════════════════════════════════════════════╗',
      '  ║         ✗  SMTP AUTHENTICATION FAILED               ║',
      '  ╠══════════════════════════════════════════════════════╣',
      ...diagnoseSmtpError(err).map(l => `  ║ ${l.padEnd(52)} ║`),
      '  ╚══════════════════════════════════════════════════════╝',
      '',
    ];
    lines.forEach(l => console.error(l));
  }
}

module.exports = {
  init,
  get transporter() { return transporter; },
  get configured()  { return configured; },
  get verified()    { return verified; },
  SMTP_USER,
  FROM_NAME,
  IS_PROD,
};
