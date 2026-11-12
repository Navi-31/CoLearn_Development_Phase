'use strict';
/**
 * authController.js – All authentication + suite endpoints
 * ─────────────────────────────────────────────────────────────────
 *  POST /api/auth/register          – Create new account
 *  POST /api/auth/login             – Authenticate user
 *  POST /api/auth/send-reset-otp    – Send password-reset OTP
 *  POST /api/auth/verify-reset-otp  – Verify password-reset OTP
 *  POST /api/auth/reset-password    – Update password via Admin SDK
 *  POST /api/send-otp               – Send signup OTP (email verify)
 *  POST /api/verify-otp             – Verify signup OTP
 *  GET  /api/health                 – Health check
 *  GET  /api/suites                 – Get user's suites from Firestore
 *  POST /api/suites                 – Create a suite in Firestore
 *  DELETE /api/suites/:id           – Delete a suite from Firestore
 */

const { validationResult } = require('express-validator');
const { auth, db, firestoreWithRetry } = require('../config/firebase');
const store                = require('../models/store');
const emailService         = require('../services/emailService');
const crypto               = require('crypto');
const { createSessionToken } = require('../middleware/requireAuth');

/* ── Mask email for safe logging ─────────────────────────────── */
/** Returns t***@gmail.com — safe to log in all environments. */
function maskEmail(email) {
  const e = (email || '');
  return e.replace(/^(.)(.+)(@.+)$/, (_, a, b, c) => a + '*'.repeat(Math.min(b.length, 4)) + c);
}

/* ── Helpers ─────────────────────────────────────────────────── */

/**
 * Convert Firebase Auth error codes to user-facing messages.
 */
function firebaseAuthError(code) {
  switch (code) {
    case 'auth/email-already-exists':
      return { status: 409, msg: 'Account already exists. Please login.' };
    case 'auth/invalid-email':
      return { status: 400, msg: 'Invalid email address.' };
    case 'auth/weak-password':
      return { status: 400, msg: 'Password is too weak.' };
    case 'auth/user-not-found':
      return { status: 404, msg: 'No account found with this email. Please create an account.' };
    default:
      return { status: 500, msg: 'An unexpected error occurred. Please try again.' };
  }
}

/**
 * Validate password strength:
 * ≥ 8 chars, uppercase, lowercase, digit, special character.
 */
function validatePasswordStrength(password) {
  if (!password || password.length < 8)
    return 'Password must be at least 8 characters.';
  if (!/[A-Z]/.test(password))
    return 'Password must contain at least one uppercase letter.';
  if (!/[a-z]/.test(password))
    return 'Password must contain at least one lowercase letter.';
  if (!/[0-9]/.test(password))
    return 'Password must contain at least one number.';
  if (!/[^A-Za-z0-9]/.test(password))
    return 'Password must contain at least one special character (e.g. @, #, $).';
  return null; // null = valid
}

/* ══════════════════════════════════════════════════════════════
   REGISTER
   ══════════════════════════════════════════════════════════════ */
async function register(req, res) {
  // 1. Express-validator errors
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, error: errors.array()[0].msg });
  }

  const name     = (req.body.name     || '').trim();
  const username = (req.body.username || '').trim().toLowerCase();
  const email    = (req.body.email    || '').trim().toLowerCase();
  const password = req.body.password  || '';
  const confirm  = req.body.confirm   || '';

  // 2. Presence checks
  if (!name)     return res.status(400).json({ success: false, error: 'Name is required.' });
  if (!username) return res.status(400).json({ success: false, error: 'Username is required.' });
  if (!email)    return res.status(400).json({ success: false, error: 'Email is required.' });
  if (!password) return res.status(400).json({ success: false, error: 'Password is required.' });

  // 3. Email format
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, error: 'Please provide a valid email address.' });
  }

  // 4. Password strength
  const pwErr = validatePasswordStrength(password);
  if (pwErr) return res.status(400).json({ success: false, error: pwErr });

  // 5. Confirm password
  if (password !== confirm) {
    return res.status(400).json({ success: false, error: 'Passwords do not match.' });
  }

  // 6. Username uniqueness (Firestore)
  try {
    const usernameSnap = await firestoreWithRetry(() => db.collection('users')
      .where('username', '==', username)
      .limit(1)
      .get());

    if (!usernameSnap.empty) {
      return res.status(409).json({ success: false, message: 'Username already taken.' });
    }
  } catch (e) {
    console.error('[register] Firestore username check failed. Message:', e.message, 'Code:', e.code, 'Details:', e.details);
    return res.status(500).json({ success: false, error: 'Server error. Please try again.' });
  }

  // 7. Email uniqueness (Firebase Auth — createUser will also enforce this,
  //    but checking first gives a cleaner error message)
  try {
    await auth.getUserByEmail(email);
    // If we reach here the email already exists
    return res.status(409).json({
      success: false,
      message: 'Account already exists with this email.',
    });
  } catch (e) {
    if (e.code !== 'auth/user-not-found') {
      // Unexpected error
      console.error('[register] Auth getUserByEmail failed:', e.message);
      return res.status(500).json({ success: false, error: 'Server error. Please try again.' });
    }
    // auth/user-not-found → email is free, continue
  }

  // 8. Create Firebase Auth user (password stored & managed by Firebase)
  let firebaseUser;
  try {
    firebaseUser = await auth.createUser({
      email,
      password,
      displayName: name,
      emailVerified: false,
    });
  } catch (e) {
    const { status, msg } = firebaseAuthError(e.code);
    console.error('[register] createUser failed:', e.code, e.message);
    return res.status(status).json({ success: false, error: msg });
  }

  // 9. Create Firestore document (NO password field)
  const now = new Date().toISOString();
  try {
    await firestoreWithRetry(() => db.collection('users').doc(firebaseUser.uid).set({
      uid:           firebaseUser.uid,
      username,
      name,
      email,
      createdAt:     now,
      lastLogin:     now,
      emailVerified: false,
    }));
  } catch (e) {
    // Firestore write failed – roll back the Auth user to keep them in sync
    console.error('[register] Firestore write failed. Message:', e.message, 'Code:', e.code, 'Details:', e.details);
    try { await auth.deleteUser(firebaseUser.uid); } catch (_) {}
    return res.status(500).json({ success: false, error: 'Account setup failed. Please try again.' });
  }

  console.log(`✅  New user registered: ${email} (uid: ${firebaseUser.uid})`);
  const userPayload = { uid: firebaseUser.uid, name, username, email };
  const sessionToken = createSessionToken(userPayload);
  let customToken = null;
  try { customToken = await auth.createCustomToken(firebaseUser.uid); } catch (_) {}

  return res.status(201).json({
    success: true,
    message: 'Account created successfully.',
    token: sessionToken,
    customToken: customToken,
    user: userPayload,
  });
}

/* ══════════════════════════════════════════════════════════════
   LOGIN
   ══════════════════════════════════════════════════════════════ */
async function login(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, error: errors.array()[0].msg });
  }

  const email    = (req.body.email    || '').trim().toLowerCase();
  const password = (req.body.password || '');

  if (!email || !password) {
    return res.status(400).json({ success: false, error: 'Email and password are required.' });
  }

  // We use the Firebase Auth REST API to verify credentials
  // (Admin SDK doesn't expose signInWithEmailAndPassword)
  const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
  if (!FIREBASE_API_KEY) {
    console.error('[login] FIREBASE_API_KEY not set in .env');
    return res.status(500).json({ success: false, error: 'Server configuration error.' });
  }

  let signInResult;
  try {
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email, password, returnSecureToken: false }),
      }
    );
    signInResult = await response.json();
  } catch (e) {
    console.error('[login] Firebase REST call failed:', e.message);
    return res.status(500).json({ success: false, error: 'Login service unavailable. Try again.' });
  }

  // Handle Firebase REST API errors
  if (signInResult.error) {
    const code = signInResult.error.message || '';
    if (code.includes('EMAIL_NOT_FOUND') || code.includes('INVALID_EMAIL')) {
      return res.status(404).json({
        success: false,
        error: 'No account found with this email. Please create an account.',
      });
    }
    if (code.includes('INVALID_PASSWORD') || code.includes('INVALID_LOGIN_CREDENTIALS')) {
      return res.status(401).json({ success: false, error: 'Incorrect password.' });
    }
    if (code.includes('TOO_MANY_ATTEMPTS_TRY_LATER') || code.includes('USER_DISABLED')) {
      return res.status(429).json({
        success: false,
        error: 'Account temporarily locked due to multiple failed attempts. Try again later.',
      });
    }
    console.error('[login] Firebase error:', code);
    return res.status(401).json({ success: false, error: 'Login failed. Please try again.' });
  }

  // Fetch user profile from Firestore — with retry on UNAUTHENTICATED cold-start
  let userDoc;
  try {
    const snap = await firestoreWithRetry(() =>
      db.collection('users').doc(signInResult.localId).get()
    );
    if (!snap.exists) {
      return res.status(404).json({
        success: false,
        error: 'No account found with this email. Please create an account.',
      });
    }
    userDoc = snap.data();
  } catch (e) {
    console.error('[login] Firestore fetch failed (after retries):', e.message);
    return res.status(500).json({ success: false, error: 'Server error. Please try again.' });
  }

  // Update lastLogin — fire-and-forget (never blocks the login response)
  firestoreWithRetry(() =>
    db.collection('users').doc(signInResult.localId).update({
      lastLogin: new Date().toISOString(),
    })
  ).catch(e => console.warn('[login] Could not update lastLogin:', e.message));

  console.log(`🔑  Login successful: ${email}`);
  const userPayload = {
    uid:      userDoc.uid,
    name:     userDoc.name,
    username: userDoc.username,
    email:    userDoc.email,
  };
  const sessionToken = createSessionToken(userPayload);
  let customToken = null;
  try { customToken = await auth.createCustomToken(userDoc.uid); } catch (_) {}

  return res.json({
    success: true,
    message: 'Login successful.',
    token: sessionToken,
    customToken: customToken,
    user: userPayload,
  });
}

/* ══════════════════════════════════════════════════════════════
   SEND RESET OTP  (forgot password – step 1)
   ══════════════════════════════════════════════════════════════ */
async function sendResetOTP(req, res) {
  const requestId = crypto.randomUUID();
  const email     = store.normalizeEmail(req.body.email || '');

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({
      success: false,
      code:    'INVALID_EMAIL',
      message: 'Please provide a valid email address.',
    });
  }

  // ── Cooldown check (60s) ────────────────────────────────────────
  const cooldown = store.checkCooldown(email);
  if (!cooldown.allowed) {
    return res.status(429).json({
      success:    false,
      code:       'OTP_COOLDOWN',
      message:    `Please wait ${cooldown.retryAfter} seconds before requesting another OTP.`,
      retryAfter: cooldown.retryAfter,
    });
  }

  // ── In-flight send lock ──────────────────────────────────────────
  if (!store.acquireSendLock(email)) {
    return res.status(429).json({
      success: false,
      code:    'OTP_SEND_IN_PROGRESS',
      message: 'An OTP is already being sent. Please wait a moment.',
    });
  }

  // Check email is registered in Firestore
  try {
    const snap = await firestoreWithRetry(() => db.collection('users')
      .where('email', '==', email)
      .limit(1)
      .get());

    if (snap.empty) {
      store.releaseSendLock(email);
      return res.status(404).json({
        success: false,
        code:    'USER_NOT_FOUND',
        message: 'No account found. Please register first.',
      });
    }
  } catch (e) {
    store.releaseSendLock(email);
    console.error(`[sendResetOTP] [${requestId}] Firestore check failed:`, e.message);
    return res.status(500).json({
      success: false,
      code:    'SERVER_ERROR',
      message: 'Server error. Please try again.',
    });
  }

  // Generate + store OTP
  const otp = store.generateOTP();
  store.storeOTP(email, otp);
  console.log(`[OTP] [${requestId}] Password-reset OTP generated for ${maskEmail(email)}`);

  try {
    await emailService.sendResetOTPEmail(email, otp, requestId);
    store.setCooldown(email);
    store.recordSent();
    console.log(`[OTP] [${requestId}] Reset OTP email delivered to ${maskEmail(email)}`);
  } catch (e) {
    store.recordFailed();
    console.error(`[sendResetOTP] [${requestId}] Email delivery failed:`, e.message);
    store.releaseSendLock(email);
    return res.status(503).json({
      success: false,
      code:    'SMTP_FAILED',
      message: 'Email delivery failed. Please try again.',
    });
  } finally {
    store.releaseSendLock(email);
  }

  return res.json({ success: true, message: 'Reset OTP sent to your email.' });
}

/* ══════════════════════════════════════════════════════════════
   VERIFY RESET OTP  (forgot password – step 2)
   ══════════════════════════════════════════════════════════════ */
function verifyResetOTP(req, res) {
  const email = store.normalizeEmail(req.body.email || '');
  const otp   = (req.body.otp || '').trim();

  if (!email || !otp) {
    return res.status(400).json({
      success: false,
      code:    'MISSING_FIELDS',
      message: 'Email and OTP are required.',
    });
  }

  const result = store.verifyOTP(email, otp);

  switch (result) {
    case 'ok':
      return res.json({ success: true, message: 'OTP verified successfully.' });
    case 'not_found':
      return res.status(400).json({ success: false, code: 'OTP_NOT_FOUND',    message: 'No OTP found. Please request a new one.' });
    case 'expired':
      return res.status(400).json({ success: false, code: 'OTP_EXPIRED',      message: 'OTP expired. Please request a new one.' });
    case 'max_attempts':
      return res.status(429).json({ success: false, code: 'OTP_MAX_ATTEMPTS', message: 'Too many incorrect attempts. Please request a new OTP.' });
    case 'invalid':
    default:
      return res.status(400).json({ success: false, code: 'OTP_INVALID',      message: 'Invalid OTP. Please try again.' });
  }
}

/* ══════════════════════════════════════════════════════════════
   RESET PASSWORD  (forgot password – step 3)
   ══════════════════════════════════════════════════════════════ */
async function resetPassword(req, res) {
  const email      = (req.body.email       || '').trim().toLowerCase();
  const newPassword = req.body.newPassword || '';
  const confirm    = req.body.confirm      || '';

  if (!email || !newPassword) {
    return res.status(400).json({ success: false, error: 'Email and new password are required.' });
  }

  // Password strength
  const pwErr = validatePasswordStrength(newPassword);
  if (pwErr) return res.status(400).json({ success: false, error: pwErr });

  if (newPassword !== confirm) {
    return res.status(400).json({ success: false, error: 'Passwords do not match.' });
  }

  // Fetch uid from Firestore
  let uid;
  try {
    const snap = await firestoreWithRetry(() => db.collection('users')
      .where('email', '==', email)
      .limit(1)
      .get());

    if (snap.empty) {
      return res.status(404).json({ success: false, error: 'Account not found.' });
    }
    uid = snap.docs[0].data().uid;
  } catch (e) {
    console.error('[resetPassword] Firestore lookup failed. Message:', e.message, 'Code:', e.code, 'Details:', e.details);
    return res.status(500).json({ success: false, error: 'Server error. Please try again.' });
  }

  // Update password via Firebase Admin SDK (never touches Firestore)
  try {
    await auth.updateUser(uid, { password: newPassword });
  } catch (e) {
    console.error('[resetPassword] updateUser failed:', e.code, e.message);
    return res.status(500).json({ success: false, error: 'Failed to update password. Please try again.' });
  }

  // Update lastLogin timestamp
  try {
    await firestoreWithRetry(() => db.collection('users').doc(uid).update({ lastLogin: new Date().toISOString() }));
  } catch (e) {
    console.error('[resetPassword] Last login update failed. Message:', e.message, 'Code:', e.code, 'Details:', e.details);
  }

  console.log(`🔒  Password reset successful: ${email}`);
  return res.json({ success: true, message: 'Password updated successfully.' });
}

/* ══════════════════════════════════════════════════════════════
   SEND SIGNUP OTP  (existing /api/send-otp endpoint)
   ══════════════════════════════════════════════════════════════ */
async function sendOTP(req, res) {
  const requestId = crypto.randomUUID();
  const email     = store.normalizeEmail(req.body.email || '');

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({
      success: false,
      code:    'INVALID_EMAIL',
      message: 'Please provide a valid email address.',
    });
  }

  // ── Cooldown check ────────────────────────────────────────────
  const cooldown = store.checkCooldown(email);
  if (!cooldown.allowed) {
    return res.status(429).json({
      success:    false,
      code:       'OTP_COOLDOWN',
      message:    `Please wait ${cooldown.retryAfter} seconds before requesting another OTP.`,
      retryAfter: cooldown.retryAfter,
    });
  }

  // ── In-flight send lock ───────────────────────────────────────
  if (!store.acquireSendLock(email)) {
    return res.status(429).json({
      success: false,
      code:    'OTP_SEND_IN_PROGRESS',
      message: 'An OTP is already being sent. Please wait a moment.',
    });
  }

  // Block if email is already registered
  try {
    await auth.getUserByEmail(email);
    store.releaseSendLock(email);
    return res.status(409).json({
      success: false,
      code:    'EMAIL_EXISTS',
      message: 'Account already exists. Please login.',
    });
  } catch (e) {
    if (e.code !== 'auth/user-not-found') {
      console.warn(`[sendOTP] [${requestId}] Unexpected Auth error during pre-check:`, e.message);
      // Non-fatal: don't block signup over a pre-check error
    }
    // auth/user-not-found → email is free, proceed
  }

  const otp = store.generateOTP();
  store.storeOTP(email, otp);
  console.log(`[OTP] [${requestId}] Signup OTP generated for ${maskEmail(email)}`);

  try {
    await emailService.sendOTPEmail(email, otp, requestId);
    store.setCooldown(email);
    store.recordSent();
    console.log(`[OTP] [${requestId}] Signup OTP email delivered to ${maskEmail(email)}`);
  } catch (err) {
    store.recordFailed();
    console.error(`[sendOTP] [${requestId}] Email delivery failed:`, err.message);
    store.releaseSendLock(email);
    return res.status(503).json({
      success: false,
      code:    'SMTP_FAILED',
      message: 'Email delivery failed. Please try again.',
    });
  } finally {
    store.releaseSendLock(email);
  }

  return res.json({ success: true, message: 'OTP sent to your email.' });
}

/* ══════════════════════════════════════════════════════════════
   VERIFY SIGNUP OTP  (existing /api/verify-otp endpoint)
   ══════════════════════════════════════════════════════════════ */
function verifyOTP(req, res) {
  const email = store.normalizeEmail(req.body.email || '');
  const otp   = (req.body.otp || '').trim();

  if (!email || !otp) {
    return res.status(400).json({
      success: false,
      code:    'MISSING_FIELDS',
      message: 'Email and OTP are required.',
    });
  }

  const result = store.verifyOTP(email, otp);

  switch (result) {
    case 'ok':
      return res.json({ success: true, message: 'OTP verified successfully.' });
    case 'not_found':
      return res.status(400).json({ success: false, code: 'OTP_NOT_FOUND',    message: 'No OTP found. Please request a new one.' });
    case 'expired':
      return res.status(400).json({ success: false, code: 'OTP_EXPIRED',      message: 'OTP expired. Please request a new one.' });
    case 'max_attempts':
      return res.status(429).json({ success: false, code: 'OTP_MAX_ATTEMPTS', message: 'Too many incorrect attempts. Please request a new OTP.' });
    case 'invalid':
    default:
      return res.status(400).json({ success: false, code: 'OTP_INVALID',      message: 'Invalid OTP. Please try again.' });
  }
}

/* ══════════════════════════════════════════════════════════════
   HEALTH CHECK
   ══════════════════════════════════════════════════════════════ */
function health(req, res) {
  return res.json({
    status:    'ok',
    service:   'CoLearn API',
    timestamp: new Date().toISOString(),
    uptime:    Math.floor(process.uptime()) + 's',
  });
}

/* ══════════════════════════════════════════════════════════════
   SUITES  (Firestore collection: 'suites')
   ══════════════════════════════════════════════════════════════ */

/**
 * GET /api/suites?uid=<uid>
 * Returns all suites belonging to the requesting user:
 *   1. Suites owned by uid (ownerUid == uid)
 *   2. Suites where uid appears in the members array
 * Results are deduplicated and sorted by createdAt descending.
 */
async function getSuites(req, res) {
  const uid = (req.query.uid || '').trim();
  if (!uid) {
    return res.status(400).json({ success: false, error: 'uid is required.' });
  }

  try {
    // Query 1: suites owned by this user
    let ownedSnap;
    try {
      ownedSnap = await firestoreWithRetry(() => db.collection('suites')
        .where('ownerUid', '==', uid)
        .orderBy('createdAt', 'desc')
        .get());
    } catch (indexErr) {
      if (indexErr.code === 9 || (indexErr.message || '').includes('index')) {
        console.warn('[getSuites] Composite index not ready — using fallback query.');
        ownedSnap = await firestoreWithRetry(() => db.collection('suites').where('ownerUid', '==', uid).get());
      } else {
        throw indexErr;
      }
    }

    // Query 2: suites where this uid is in the members array
    // Firestore supports array-contains queries for this purpose
    let memberSnap;
    try {
      memberSnap = await firestoreWithRetry(() => db.collection('suites')
        .where('memberUids', 'array-contains', uid)
        .get());
    } catch (e) {
      // memberUids field may not exist on older suites — fall back gracefully
      memberSnap = { docs: [] };
    }

    // Combine and deduplicate by doc ID
    const seenIds = new Set();
    const suites  = [];

    for (const doc of ownedSnap.docs) {
      if (!seenIds.has(doc.id)) {
        seenIds.add(doc.id);
        suites.push({ id: doc.id, ...doc.data() });
      }
    }
    for (const doc of memberSnap.docs) {
      if (!seenIds.has(doc.id)) {
        seenIds.add(doc.id);
        suites.push({ id: doc.id, ...doc.data() });
      }
    }

    // Sort by createdAt descending
    suites.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

    return res.json({ success: true, suites });
  } catch (e) {
    console.error('[getSuites] Firestore error. Message:', e.message, 'Code:', e.code, 'Details:', e.details);
    return res.status(500).json({ success: false, error: 'Failed to fetch suites.' });
  }
}

/**
 * POST /api/suites
 * Body: { name, description?, isPrivate?, adminLimit? }
 * Creates a suite in Firestore and returns the created suite.
 */
async function createSuite(req, res) {
  const uid         = req.verifiedUid || (req.body.uid || '').trim();
  const name        = (req.body.name        || '').trim();
  const description = (req.body.description || '').trim();
  const isPrivate   = Boolean(req.body.isPrivate);

  if (!uid)  return res.status(401).json({ success: false, error: 'Authentication required.' });
  if (!name) return res.status(400).json({ success: false, error: 'Suite name is required.' });
  if (name.length > 100) return res.status(400).json({ success: false, error: 'Suite name is too long.' });

  // Validate admin limit: minimum 1, max 20, integer
  let adminLimit = 3; // default
  if (req.body.adminLimit !== undefined && req.body.adminLimit !== null && req.body.adminLimit !== '') {
    const parsedLimit = Number(req.body.adminLimit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 20) {
      return res.status(400).json({
        success: false,
        error: 'Admin limit must be an integer between 1 and 20.',
      });
    }
    adminLimit = parsedLimit;
  }

  const now = new Date().toISOString();

  // Fetch owner user profile so initial members list contains the host
  let ownerName = 'Host';
  let ownerUsername = '';
  try {
    const userDoc = await firestoreWithRetry(() => db.collection('users').doc(uid).get());
    if (userDoc.exists) {
      const u = userDoc.data();
      ownerName = u.name || 'Host';
      ownerUsername = u.username || '';
    }
  } catch (_) {}

  const ownerMember = {
    uid,
    name:     ownerName,
    username: ownerUsername,
    isHost:   true,
    role:     'HOST',
    joinedAt: now,
  };

  const suiteData = {
    ownerUid:   uid,
    hostUid:    uid,              // Alias for frontend consistency
    name,
    description,
    isPrivate,
    adminLimit,
    adminUids:  [],
    members:    [ownerMember],
    memberUids: [uid],       // Flat array for array-contains queries; owner always included
    createdAt:  now,
    updatedAt:  now,
  };

  try {
    const ref = await firestoreWithRetry(() => db.collection('suites').add(suiteData));
    console.log(`[Suite] Created: ${ref.id} by uid=${uid} (adminLimit=${adminLimit})`);
    return res.status(201).json({
      success: true,
      suite:   { id: ref.id, ...suiteData },
    });
  } catch (e) {
    console.error('[createSuite] Firestore error. Message:', e.message, 'Code:', e.code, 'Details:', e.details);
    return res.status(500).json({ success: false, error: 'Failed to create suite.' });
  }
}

/**
 * DELETE /api/suites/:id
 * Verified caller must match ownerUid for authorization
 */
async function deleteSuite(req, res) {
  const suiteId = (req.params.id || '').trim();
  const uid     = req.verifiedUid || (req.body.uid || '').trim();

  if (!suiteId) return res.status(400).json({ success: false, error: 'Suite ID is required.' });
  if (!uid)     return res.status(401).json({ success: false, error: 'Authentication required.' });

  try {
    const ref = db.collection('suites').doc(suiteId);
    const doc = await firestoreWithRetry(() => ref.get());

    if (!doc.exists) {
      return res.status(404).json({ success: false, error: 'Suite not found.' });
    }
    if (doc.data().ownerUid !== uid) {
      return res.status(403).json({ success: false, message: 'Only the suite host can delete this suite.' });
    }

    await firestoreWithRetry(() => ref.delete());
    console.log(`[Suite] Deleted: ${suiteId} by uid=${uid}`);
    return res.json({ success: true, message: 'Suite deleted.' });
  } catch (e) {
    console.error('[deleteSuite] Firestore error. Message:', e.message, 'Code:', e.code, 'Details:', e.details);
    return res.status(500).json({ success: false, error: 'Failed to delete suite.' });
  }
}

/**
 * GET /api/suites/:id
 * Fetches a suite by ID from Firestore.
 */
async function getSuiteById(req, res) {
  const suiteId = (req.params.id || '').trim();
  if (!suiteId) {
    return res.status(400).json({ success: false, error: 'Suite ID is required.' });
  }

  try {
    const doc = await firestoreWithRetry(() => db.collection('suites').doc(suiteId).get());
    if (!doc.exists) {
      return res.status(404).json({ success: false, error: 'Suite not found.' });
    }

    return res.json({
      success: true,
      suite: { id: doc.id, ...doc.data() },
    });
  } catch (e) {
    console.error('[getSuiteById] Firestore error. Message:', e.message, 'Code:', e.code, 'Details:', e.details);
    return res.status(500).json({ success: false, error: 'Failed to fetch suite.' });
  }
}

/* ══════════════════════════════════════════════════════════════
   FIREBASE CUSTOM TOKEN  (for Client SDK authentication)
   ══════════════════════════════════════════════════════════════ */
/**
 * POST /api/auth/token
 * Body: { uid }
 * Returns a Firebase custom token so the frontend Client SDK
 * can call firebase.auth().signInWithCustomToken(token) and
 * then use Firestore / Realtime Database with security rules.
 * The token is short-lived (1 hour) and scoped to the uid.
 */
async function createCustomToken(req, res) {
  const verifiedUid = req.verifiedUid;
  if (!verifiedUid) {
    return res.status(401).json({ success: false, error: 'Authentication required.' });
  }

  // Prevent IDOR: caller cannot mint a token for a different user
  if (req.body && req.body.uid && String(req.body.uid).trim() !== verifiedUid) {
    return res.status(403).json({ success: false, error: 'Forbidden: Cannot request token for another user.' });
  }

  try {
    const customToken = await auth.createCustomToken(verifiedUid);
    return res.json({ success: true, token: customToken });
  } catch (e) {
    console.error('[createCustomToken] Failed:', e.message);
    return res.status(500).json({ success: false, error: 'Could not generate auth token.' });
  }
}

module.exports = {
  register, login,
  sendResetOTP, verifyResetOTP, resetPassword,
  sendOTP, verifyOTP,
  health,
  getSuites, createSuite, deleteSuite, getSuiteById,
  createCustomToken,
};

