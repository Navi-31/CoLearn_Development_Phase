'use strict';
/**
 * otp.test.js – Automated tests for the CoLearn OTP subsystem
 * ─────────────────────────────────────────────────────────────────
 * Uses Node built-in test runner — zero extra dependencies.
 * Run with:  node --test tests/otp.test.js
 *
 * What is tested:
 *  Suite 1: OTP Core          – generate, store, verify, one-time use
 *  Suite 2: Email Normalization
 *  Suite 3: Cooldown          – 60s per-email resend block
 *  Suite 4: Send Lock         – in-flight duplicate prevention
 *  Suite 5: Stats             – sentToday, failedToday counters
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const store = require('../models/store');

/* ══════════════════════════════════════════════════════════════
   Suite 1 — OTP Core
   ══════════════════════════════════════════════════════════════ */
describe('OTP Core', () => {

  test('generateOTP returns a 6-digit numeric string', () => {
    const otp = store.generateOTP();
    assert.equal(typeof otp, 'string');
    assert.equal(otp.length, 6);
    assert.match(otp, /^\d{6}$/);
  });

  test('correct OTP → verifyOTP returns "ok"', () => {
    const email = 'core-correct@example.com';
    const otp   = store.generateOTP();
    store.storeOTP(email, otp);
    assert.equal(store.verifyOTP(email, otp), 'ok');
  });

  test('wrong OTP → verifyOTP returns "invalid"', () => {
    const email = 'core-wrong@example.com';
    const otp   = store.generateOTP();
    store.storeOTP(email, otp);
    assert.equal(store.verifyOTP(email, '000000'), 'invalid');
  });

  test('OTP is one-time use — second verify returns "not_found"', () => {
    const email = 'core-onetime@example.com';
    const otp   = store.generateOTP();
    store.storeOTP(email, otp);
    store.verifyOTP(email, otp);          // first — consumes it
    assert.equal(store.verifyOTP(email, otp), 'not_found');
  });

  test('unknown email → verifyOTP returns "not_found"', () => {
    assert.equal(store.verifyOTP('nobody@example.com', '123456'), 'not_found');
  });

  test('5 wrong attempts → 6th call returns "max_attempts", 7th returns "not_found"', () => {
    const email = 'core-max@example.com';
    const otp   = store.generateOTP();
    store.storeOTP(email, otp);

    // Attempts 1-5: each returns 'invalid' and increments counter
    for (let i = 0; i < 5; i++) {
      const r = store.verifyOTP(email, '000000');
      assert.equal(r, 'invalid', `attempt ${i + 1} should return invalid`);
    }

    // 6th call: attempts === OTP_MAX_ATTEMPTS → store deletes entry and returns 'max_attempts'
    assert.equal(store.verifyOTP(email, '000000'), 'max_attempts');

    // 7th call: entry was deleted → 'not_found'
    assert.equal(store.verifyOTP(email, otp), 'not_found');
  });

  test('re-storing an OTP invalidates the previous one', () => {
    const email = 'core-replace@example.com';
    const otp1  = store.generateOTP();
    store.storeOTP(email, otp1);

    const otp2  = store.generateOTP();
    store.storeOTP(email, otp2);       // replaces otp1

    // otp1 must not work
    assert.equal(store.verifyOTP(email, otp1), 'invalid');
    // clean up
    store.deleteOTP(email);
  });

  test('deleteOTP removes the entry', () => {
    const email = 'core-delete@example.com';
    const otp   = store.generateOTP();
    store.storeOTP(email, otp);
    store.deleteOTP(email);
    assert.equal(store.verifyOTP(email, otp), 'not_found');
  });

});

/* ══════════════════════════════════════════════════════════════
   Suite 2 — Email Normalization
   ══════════════════════════════════════════════════════════════ */
describe('Email Normalization', () => {

  test('normalizeEmail lowercases and trims whitespace', () => {
    assert.equal(store.normalizeEmail('  TEST@Gmail.COM  '), 'test@gmail.com');
    assert.equal(store.normalizeEmail('User@Example.com'),   'user@example.com');
    assert.equal(store.normalizeEmail(''),                    '');
  });

  test('case-insensitive store + verify round-trip', () => {
    const otp = store.generateOTP();
    store.storeOTP('CASE@Test.COM', otp);
    assert.equal(store.verifyOTP('case@test.com', otp), 'ok');
  });

  test('whitespace in email is trimmed before lookup', () => {
    const otp = store.generateOTP();
    store.storeOTP('  trim@test.com  ', otp);
    assert.equal(store.verifyOTP('trim@test.com', otp), 'ok');
  });

});

/* ══════════════════════════════════════════════════════════════
   Suite 3 — Resend Cooldown
   ══════════════════════════════════════════════════════════════ */
describe('Cooldown', () => {

  test('checkCooldown allows send when no cooldown set', () => {
    const result = store.checkCooldown('fresh@example.com');
    assert.equal(result.allowed, true);
    assert.equal(result.retryAfter, 0);
  });

  test('checkCooldown blocks immediately after setCooldown', () => {
    const email = `cd-${Date.now()}@example.com`;
    store.setCooldown(email);
    const result = store.checkCooldown(email);
    assert.equal(result.allowed, false);
    assert.ok(result.retryAfter > 0, 'retryAfter should be positive');
    assert.ok(result.retryAfter <= 60, 'retryAfter should be ≤ 60s');
  });

  test('RESEND_COOLDOWN_MS constant is 60000 ms', () => {
    assert.equal(store.RESEND_COOLDOWN_MS, 60000);
  });

});

/* ══════════════════════════════════════════════════════════════
   Suite 4 — In-flight Send Lock
   ══════════════════════════════════════════════════════════════ */
describe('Send Lock', () => {

  test('acquireSendLock returns true on first call', () => {
    const email = `lock-first-${Date.now()}@example.com`;
    assert.equal(store.acquireSendLock(email), true);
    store.releaseSendLock(email);
  });

  test('acquireSendLock returns false when lock already held', () => {
    const email = `lock-dup-${Date.now()}@example.com`;
    store.acquireSendLock(email);
    assert.equal(store.acquireSendLock(email), false);
    store.releaseSendLock(email);
  });

  test('releaseSendLock allows re-acquisition', () => {
    const email = `lock-reacq-${Date.now()}@example.com`;
    store.acquireSendLock(email);
    store.releaseSendLock(email);
    assert.equal(store.acquireSendLock(email), true);
    store.releaseSendLock(email);
  });

  test('send lock is email-scoped — different emails are independent', () => {
    const a = `lock-a-${Date.now()}@example.com`;
    const b = `lock-b-${Date.now()}@example.com`;
    store.acquireSendLock(a);
    assert.equal(store.acquireSendLock(b), true, 'lock on "a" must not affect "b"');
    store.releaseSendLock(a);
    store.releaseSendLock(b);
  });

});

/* ══════════════════════════════════════════════════════════════
   Suite 5 — Email Stats
   ══════════════════════════════════════════════════════════════ */
describe('Stats', () => {

  test('getStats() returns all required fields', () => {
    const stats = store.getStats();
    assert.ok('sentToday'    in stats, 'missing sentToday');
    assert.ok('failedToday'  in stats, 'missing failedToday');
    assert.ok('lastSentAt'   in stats, 'missing lastSentAt');
    assert.ok('otpStoreSize' in stats, 'missing otpStoreSize');
    assert.ok('cooldownSize' in stats, 'missing cooldownSize');
    assert.ok('locksActive'  in stats, 'missing locksActive');
  });

  test('recordSent() increments sentToday', () => {
    const before = store.getStats().sentToday;
    store.recordSent();
    assert.equal(store.getStats().sentToday, before + 1);
  });

  test('recordFailed() increments failedToday', () => {
    const before = store.getStats().failedToday;
    store.recordFailed();
    assert.equal(store.getStats().failedToday, before + 1);
  });

  test('recordSent() updates lastSentAt timestamp', () => {
    store.recordSent();
    const stats = store.getStats();
    assert.ok(stats.lastSentAt !== null, 'lastSentAt should not be null after send');
    assert.doesNotThrow(() => new Date(stats.lastSentAt));
  });

});
