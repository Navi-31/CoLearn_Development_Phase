'use strict';
/**
 * store.js – Lightweight in-memory stores for CoLearn
 * ─────────────────────────────────────────────────────────────────
 * Manages ephemeral OTP state for:
 *  • Signup email verification
 *  • Password-reset flow
 *
 * OTP Security guarantees:
 *  • 6-digit code generated with crypto.randomInt (CSPRNG)
 *  • Only a SHA-256 hash of the code is stored — plaintext never persisted
 *  • OTP valid for 5 minutes max; consumed on first correct use (one-time)
 *  • Maximum 5 incorrect verification attempts before entry is wiped
 *  • 60-second per-email resend cooldown (enforced in checkCooldown)
 *  • In-flight send lock prevents duplicate sends on rapid click
 *  • Periodic cleanup removes expired entries (memory leak prevention)
 *  • Email always normalized: lowercase + trim before any store operation
 *
 * Stats:
 *  • sentToday / failedToday counters (reset at midnight UTC)
 *  • lastSentAt timestamp
 *  • getStats() for /api/debug/email
 */

const crypto = require('crypto');

/* ── Constants ─────────────────────────────────────────────────── */
const OTP_TTL_MS        = 5 * 60 * 1000;   // 5 minutes
const OTP_MAX_ATTEMPTS  = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;       // 60 seconds

/* ── Normalize email ────────────────────────────────────────────── */
/** Always lowercase + trim. Call before any store operation. */
function normalizeEmail(email) {
  return (email || '').toLowerCase().trim();
}

/* ── OTP store ─────────────────────────────────────────────────── */
// Map<normalizedEmail → { hash, expiresAt, attempts }>
const otpStore = new Map();

/* ── Cooldown store ─────────────────────────────────────────────── */
// Map<normalizedEmail → { lastSentAt: number }>
const cooldownStore = new Map();

/* ── In-flight send lock ─────────────────────────────────────────── */
// Set<normalizedEmail> — prevents duplicate sends from rapid button clicks
const sendLocks = new Set();

/* ── Email stats ─────────────────────────────────────────────────── */
let _sentToday   = 0;
let _failedToday = 0;
let _lastSentAt  = null;
let _statsDayStr = _todayDateStr();   // 'YYYY-MM-DD'

function _todayDateStr() {
  return new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

function _resetStatsIfNewDay() {
  const today = _todayDateStr();
  if (today !== _statsDayStr) {
    _sentToday   = 0;
    _failedToday = 0;
    _statsDayStr = today;
  }
}

/** Call after a successful send. */
function recordSent() {
  _resetStatsIfNewDay();
  _sentToday++;
  _lastSentAt = new Date().toISOString();
}

/** Call after a failed send. */
function recordFailed() {
  _resetStatsIfNewDay();
  _failedToday++;
}

/** Returns current stats (no secrets exposed). */
function getStats() {
  _resetStatsIfNewDay();
  return {
    sentToday:    _sentToday,
    failedToday:  _failedToday,
    lastSentAt:   _lastSentAt,
    otpStoreSize: otpStore.size,
    cooldownSize: cooldownStore.size,
    locksActive:  sendLocks.size,
  };
}

/* ── OTP generation ─────────────────────────────────────────────── */
/**
 * Generate a cryptographically secure 6-digit OTP.
 * Returns the plaintext string — caller must store via storeOTP().
 */
function generateOTP() {
  return String(crypto.randomInt(100000, 1000000)).padStart(6, '0');
}

/** SHA-256 hash of a plaintext OTP. Only the hash is ever persisted. */
function hashOTP(plaintext) {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

/* ── Resend cooldown ────────────────────────────────────────────── */
/**
 * Check whether an email is allowed to receive a new OTP.
 *
 * @param {string} email - Raw (un-normalized) email
 * @returns {{ allowed: boolean, retryAfter: number }}
 *   retryAfter is seconds remaining (0 when allowed)
 */
function checkCooldown(email) {
  const key   = normalizeEmail(email);
  const entry = cooldownStore.get(key);
  if (!entry) return { allowed: true, retryAfter: 0 };

  const elapsed   = Date.now() - entry.lastSentAt;
  const remaining = RESEND_COOLDOWN_MS - elapsed;

  if (remaining <= 0) {
    cooldownStore.delete(key);
    return { allowed: true, retryAfter: 0 };
  }

  return { allowed: false, retryAfter: Math.ceil(remaining / 1000) };
}

/** Record that an OTP email was just sent for this address. */
function setCooldown(email) {
  const key = normalizeEmail(email);
  cooldownStore.set(key, { lastSentAt: Date.now() });
}

/* ── In-flight send lock ─────────────────────────────────────────── */
/**
 * Attempt to acquire the send lock for an email.
 * Returns true if acquired (safe to send), false if another send is in flight.
 */
function acquireSendLock(email) {
  const key = normalizeEmail(email);
  if (sendLocks.has(key)) return false;
  sendLocks.add(key);
  return true;
}

/** Release the send lock after the email send attempt completes. */
function releaseSendLock(email) {
  sendLocks.delete(normalizeEmail(email));
}

/* ── OTP store operations ──────────────────────────────────────── */
/**
 * Store a hashed OTP for the given email.
 * Replaces any existing entry — previous OTP immediately invalidated.
 * Resets the attempt counter.
 */
function storeOTP(email, otp) {
  const key       = normalizeEmail(email);
  const expiresAt = Date.now() + OTP_TTL_MS;
  const hash      = hashOTP(otp);

  otpStore.set(key, { hash, expiresAt, attempts: 0 });
}

/** Retrieve the raw OTP entry (internal use only — hash not exposed). */
function getOTP(email) {
  return otpStore.get(normalizeEmail(email)) || null;
}

/**
 * Verify a submitted OTP string against the stored hash.
 *
 * Returns one of:
 *  'ok'           – correct and consumed (one-time use)
 *  'not_found'    – no OTP was generated for this email
 *  'expired'      – OTP TTL elapsed (entry deleted)
 *  'invalid'      – wrong code (attempts incremented)
 *  'max_attempts' – 5 failed attempts reached (entry deleted)
 */
function verifyOTP(email, submittedOtp) {
  const key   = normalizeEmail(email);
  const entry = otpStore.get(key);

  if (!entry)                             return 'not_found';
  if (Date.now() > entry.expiresAt)       { otpStore.delete(key); return 'expired'; }
  if (entry.attempts >= OTP_MAX_ATTEMPTS) { otpStore.delete(key); return 'max_attempts'; }

  const submittedHash = hashOTP((submittedOtp || '').trim());
  if (submittedHash !== entry.hash) {
    entry.attempts++;
    return 'invalid';
  }

  // ✅ Correct — consume the OTP (one-time use enforced)
  otpStore.delete(key);
  return 'ok';
}

/** Remove the OTP entry for an email (call after successful registration). */
function deleteOTP(email) {
  otpStore.delete(normalizeEmail(email));
}

/* ── Periodic cleanup ───────────────────────────────────────────── */
/**
 * Remove expired OTP and cooldown entries every 5 minutes.
 * Prevents unbounded memory growth in long-running processes.
 * Unref'd so this timer won't prevent Node from exiting in tests.
 */
function startCleanupTimer() {
  const timer = setInterval(() => {
    const now = Date.now();

    for (const [key, entry] of otpStore) {
      if (now > entry.expiresAt) {
        otpStore.delete(key);
      }
    }

    for (const [key, entry] of cooldownStore) {
      if (now - entry.lastSentAt > RESEND_COOLDOWN_MS) {
        cooldownStore.delete(key);
      }
    }
  }, 5 * 60 * 1000); // every 5 minutes

  // Don't prevent process exit
  if (timer.unref) timer.unref();
  return timer;
}

// Start the cleanup timer automatically on module load
startCleanupTimer();

/* ── Exports ─────────────────────────────────────────────────────── */
module.exports = {
  // Email normalization
  normalizeEmail,

  // OTP operations
  generateOTP,
  storeOTP,
  getOTP,
  verifyOTP,
  deleteOTP,

  // Cooldown
  checkCooldown,
  setCooldown,

  // Send lock (debounce)
  acquireSendLock,
  releaseSendLock,

  // Stats
  recordSent,
  recordFailed,
  getStats,

  // Constants (for tests + health endpoint)
  OTP_TTL_MS,
  OTP_MAX_ATTEMPTS,
  RESEND_COOLDOWN_MS,
};
