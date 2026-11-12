'use strict';
/**
 * requireAuth.js – Server-side Authentication & Session Middleware
 * ─────────────────────────────────────────────────────────────────
 * Validates caller identity using cryptographic proof:
 *   1. Signed CoLearn Session Tokens (HMAC-SHA256)
 *   2. Firebase Auth ID Tokens (Bearer <jwt>)
 *   3. In development only: fallback UID validation with security warning
 *
 * This prevents:
 *   • Unauthenticated API calls
 *   • Spoofed UID / IDOR attacks
 *   • Token tampering and replay of expired sessions
 */

const crypto   = require('crypto');
const { auth } = require('../config/firebase');

const SESSION_SECRET = process.env.APP_SECRET || process.env.SESSION_SECRET || process.env.GOOGLE_CLIENT_SECRET || 'colearn-session-secret-key-32chars';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Creates a cryptographically signed session token for a user.
 */
function createSessionToken(user) {
  if (!user || !user.uid) throw new Error('Valid user object with uid required.');
  const payload = {
    uid: user.uid,
    email: user.email || '',
    username: user.username || '',
    exp: Date.now() + SESSION_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

/**
 * Verifies a signed session token. Returns the payload or null if invalid/expired.
 */
function verifySessionToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  if (!encoded || !sig) return null;

  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(encoded).digest('base64url');
  const bufSig = Buffer.from(sig);
  const bufExp = Buffer.from(expectedSig);
  if (bufSig.length !== bufExp.length || !crypto.timingSafeEqual(bufSig, bufExp)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!payload.uid || !payload.exp || Date.now() > payload.exp) {
      return null;
    }
    return payload;
  } catch (_) {
    return null;
  }
}

/**
 * Extract uid parameter from request body, query, or custom header.
 */
function extractUid(req) {
  return (
    (req.body  && req.body.uid)  ||
    (req.query && req.query.uid) ||
    (req.headers && (req.headers['x-fs-uid'] || req.headers['X-FS-UID'])) ||
    ''
  ).trim();
}

/**
 * Middleware: Verify caller authentication.
 */
async function requireAuth(req, res, next) {
  const authHeader = req.headers && (req.headers['authorization'] || req.headers['Authorization']);
  let bearerToken = '';
  if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    bearerToken = authHeader.substring(7).trim();
  }

  // 1. If a Bearer token is provided, verify signed session token or Firebase ID token
  if (bearerToken) {
    // Check CoLearn signed session token first (fast, in-memory)
    const session = verifySessionToken(bearerToken);
    if (session) {
      req.verifiedUid = session.uid;
      req.user = session;
      return next();
    }

    // Next check Firebase ID token
    try {
      const decoded = await auth.verifyIdToken(bearerToken);
      req.verifiedUid = decoded.uid;
      req.user = decoded;
      return next();
    } catch (e) {
      console.warn('[requireAuth] Token verification failed:', e.message);
      return res.status(401).json({
        success: false,
        error: 'Invalid or expired authorization token.',
      });
    }
  }

  // 2. In production, unauthenticated requests without a cryptographic token are strictly denied
  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required. Missing Bearer token.',
    });
  }

  // 3. Development / LAN fallback with security warning
  const uid = extractUid(req);
  if (!uid) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required. Please log in.',
    });
  }

  try {
    const userRecord = await auth.getUser(uid);
    if (userRecord.disabled) {
      return res.status(403).json({
        success: false,
        error: 'Your account has been disabled. Please contact support.',
      });
    }
    req.verifiedUid = userRecord.uid;
    req.user = userRecord;
    return next();
  } catch (e) {
    if (e.code === 'auth/user-not-found') {
      return res.status(401).json({
        success: false,
        error: 'Invalid session. Please log in again.',
      });
    }
    console.error('[requireAuth] Auth lookup error:', e.message);
    return res.status(500).json({
      success: false,
      error: 'Authentication service unavailable. Please try again.',
    });
  }
}

requireAuth.createSessionToken = createSessionToken;
requireAuth.verifySessionToken = verifySessionToken;

module.exports = requireAuth;
