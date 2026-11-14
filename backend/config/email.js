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

const path = require('path');
require('dotenv').config();
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const nodemailer = require('nodemailer');

let transporter = null;
let configured   = false;
let verified     = false;   // true only after transporter.verify() succeeds

function getCredentials() {
  const user = (process.env.SMTP_USER || '').trim();
  const pass = (process.env.SMTP_PASS || '').trim().replace(/\s+/g, '');
  const fromName = (process.env.EMAIL_FROM_NAME || 'CoLearn').trim();
  const host = (process.env.SMTP_HOST || 'smtp.gmail.com').trim();
  const customPort = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : null;
  const isProd = process.env.NODE_ENV === 'production';
  return { user, pass, fromName, host, customPort, isProd };
}

function createTransportInstance(opts) {
  const { user, pass, host, port, secure } = opts;
  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user,
      pass,
    },
    tls: {
      // Enforce strict TLS certificate verification unless explicitly overridden
      rejectUnauthorized: process.env.SMTP_IGNORE_TLS !== 'true',
    },
    connectionTimeout: 10000,   // 10 s – fail fast if unreachable
    socketTimeout:     15000,   // 15 s – fail fast if send stalls
    greetingTimeout:   10000,   // 10 s – fail fast on bad handshake
  });
}

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
  const { user, pass, host, customPort, isProd } = getCredentials();

  if (!user || !pass) {
    configured  = false;
    verified    = false;
    transporter = null;
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

  // Determine initial port & secure settings
  let port = customPort || 587;
  let secure = process.env.SMTP_SECURE === 'true' || port === 465;

  let testTransporter = createTransportInstance({ user, pass, host, port, secure });

  // ── Live verification ────────────────────────────────────────
  // transporter.verify() opens a real TCP connection to SMTP host and
  // checks AUTH. Failures are logged with actionable diagnostics.
  // The server still starts normally — email is non-critical.
  try {
    await testTransporter.verify();
    transporter = testTransporter;
    configured  = true;
    verified    = true;
    console.log(`📧  SMTP configured → ${user} (${host}:${port})`);
    console.log(`  ✅ SMTP Connected — SMTP authentication successful`);
    return;
  } catch (err) {
    const msg = (err.message || '').toLowerCase();
    const isConnError = msg.includes('econnrefused') || msg.includes('enotfound') || msg.includes('etimedout') || msg.includes('greeting');

    // If port 587 connection timed out / failed on Gmail and no custom port was specified,
    // automatically attempt port 465 (SSL direct), which bypasses mobile carrier port blocks.
    if (!customPort && host === 'smtp.gmail.com' && port === 587 && isConnError) {
      console.warn(`[SMTP] Port 587 connection failed (${err.code || err.message}). Attempting port 465 (SSL direct)...`);
      try {
        const sslTransporter = createTransportInstance({ user, pass, host, port: 465, secure: true });
        await sslTransporter.verify();
        transporter = sslTransporter;
        configured  = true;
        verified    = true;
        console.log(`📧  SMTP configured → ${user} (smtp.gmail.com:465 SSL)`);
        console.log(`  ✅ SMTP Connected — Gmail authentication successful via port 465`);
        return;
      } catch (sslErr) {
        err = sslErr; // Use latest error for diagnosis
      }
    }

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
  get SMTP_USER()   { return (process.env.SMTP_USER || '').trim(); },
  get FROM_NAME()   { return (process.env.EMAIL_FROM_NAME || 'CoLearn').trim(); },
  get IS_PROD()     { return process.env.NODE_ENV === 'production'; },
};
