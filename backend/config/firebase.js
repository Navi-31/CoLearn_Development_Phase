'use strict';
/**
 * Firebase Admin SDK – initialisation
 * ─────────────────────────────────────────────────────────────────
 * Reads the service-account key from the path specified in .env and
 * exports ready-to-use `auth` and `db` (Firestore) references.
 *
 * Compatible with firebase-admin v12+ (modular-style top-level exports).
 */

const {
  initializeApp,
  getApps,
  cert,
} = require('firebase-admin/app');

const { getAuth }      = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { getDatabase }  = require('firebase-admin/database');
const path             = require('path');
const fs               = require('fs');
const admin            = require('firebase-admin');

/* ── Load service-account key ──────────────────────────────────
 * Supports two secure loading mechanisms:
 *  1. FIREBASE_SERVICE_ACCOUNT_JSON: Service account JSON string or
 *     base64 string stored directly in cloud environment secrets.
 *  2. FIREBASE_KEY_PATH: File path on disk (default: ./config/serviceAccountKey.json)
 *     used for local development.
 * ────────────────────────────────────────────────────────────── */
function loadServiceAccountCredentials() {
  // Option 1: FIREBASE_SERVICE_ACCOUNT_JSON environment variable (Production Cloud Host / Secret Manager)
  const rawEnvJson = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (rawEnvJson) {
    try {
      let parsed = null;
      if (rawEnvJson.startsWith('{')) {
        parsed = JSON.parse(rawEnvJson);
      } else {
        // Handle base64 encoded JSON string
        try {
          const decoded = Buffer.from(rawEnvJson, 'base64').toString('utf8');
          parsed = JSON.parse(decoded);
        } catch (_) {
          parsed = JSON.parse(rawEnvJson);
        }
      }

      if (parsed && typeof parsed === 'object') {
        // Normalize escaped newlines in PEM private key if present
        if (parsed.private_key && typeof parsed.private_key === 'string') {
          parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
        }
        if (parsed.project_id && parsed.client_email && parsed.private_key) {
          console.log('[Firebase] Loaded service account credentials from environment secret (FIREBASE_SERVICE_ACCOUNT_JSON).');
          return parsed;
        }
        throw new Error('Service account JSON in environment secret is missing project_id, client_email, or private_key.');
      }
    } catch (parseErr) {
      console.error(`\n❌  Firebase: Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON environment variable.`);
      console.error(`   → Details: ${parseErr.message}`);
      console.error('   → Ensure the value is valid raw JSON or base64-encoded JSON downloaded from Firebase Console.\n');
      process.exit(1);
    }
  }

  // Option 2: File on disk (Local Development)
  const keyPath = process.env.FIREBASE_KEY_PATH || './config/serviceAccountKey.json';
  const resolvedPath = path.resolve(__dirname, '..', keyPath.replace(/^\.\//, ''));

  if (fs.existsSync(resolvedPath)) {
    try {
      const fileContent = fs.readFileSync(resolvedPath, 'utf8');
      const parsed = JSON.parse(fileContent);
      if (parsed && typeof parsed === 'object') {
        if (parsed.private_key && typeof parsed.private_key === 'string') {
          parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
        }
        if (parsed.project_id && parsed.client_email && parsed.private_key) {
          console.log(`[Firebase] Loaded service account credentials from file: ${resolvedPath}`);
          return parsed;
        }
        throw new Error('File is missing project_id, client_email, or private_key.');
      }
    } catch (fileErr) {
      console.error(`\n❌  Firebase: Cannot parse service-account key at: ${resolvedPath}`);
      console.error(`   → Details: ${fileErr.message}`);
      process.exit(1);
    }
  }

  // Neither credential source is available — report clear, actionable startup error
  console.error('\n❌  Firebase: Cannot load service-account key.');
  console.error('   Missing credentials for Firebase Admin SDK.');
  console.error('   Please configure one of the following:\n');
  console.error('   • LOCAL DEVELOPMENT:');
  console.error('     1. Go to Firebase Console → Project Settings → Service Accounts');
  console.error('     2. Click "Generate new private key" to download your service account JSON');
  console.error(`     3. Place the file at: ${resolvedPath}`);
  console.error('        (or specify its path via FIREBASE_KEY_PATH in backend/.env)\n');
  console.error('   • PRODUCTION DEPLOYMENT (Render, Railway, Fly.io, etc.):');
  console.error('     1. Copy the entire contents of your service account JSON file');
  console.error('     2. Add an environment variable in your hosting dashboard:');
  console.error('        FIREBASE_SERVICE_ACCOUNT_JSON=<paste-json-or-base64-here>\n');
  process.exit(1);
}

const serviceAccount = loadServiceAccountCredentials();
const credentialInstance = cert(serviceAccount);
const databaseURL = process.env.FIREBASE_DATABASE_URL || (serviceAccount && serviceAccount.project_id ? `https://${serviceAccount.project_id}-default-rtdb.firebaseio.com` : 'https://your-project-id-default-rtdb.firebaseio.com');

/* ── Initialise only once (safe for nodemon hot-reloads) ─────── */
if (getApps().length === 0) {
  initializeApp({
    credential: credentialInstance,
    databaseURL,
  });
  console.log(`🔥  Firebase Admin initialised (project: ${serviceAccount.project_id})`);
}

const auth = getAuth();
const db   = getFirestore();
let rtdb   = null;
try {
  rtdb = getDatabase();
} catch (e) {
  console.warn('[firebase] RTDB initialization warning:', e.message);
}

async function warmUpFirebase() {
  console.log('🔄  Firebase: Warming up Auth token...');
  try {
    const token = await credentialInstance.getAccessToken();
    console.log('✅  Firebase: Auth token warmed up successfully.');
    return token;
  } catch (err) {
    console.error('❌  Firebase: Failed to fetch access token during warm-up.');
    console.error('Full Error:', {
      message: err.message,
      code: err.code,
      stack: err.stack,
      ...err
    });
    throw err;
  }
}

async function firestoreWithRetry(operation, maxRetries = 2, retryDelayMs = 300) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastErr = err;
      const isUnauthenticated =
        err.code === 16 ||
        err.code === 'UNAUTHENTICATED' ||
        (err.message || '').includes('UNAUTHENTICATED') ||
        (err.message || '').includes('invalid authentication credentials');

      if (isUnauthenticated && attempt < maxRetries) {
        const wait = retryDelayMs * (attempt + 1);
        console.warn(
          `[Firestore] UNAUTHENTICATED on attempt ${attempt + 1} — retrying in ${wait}ms…`
        );
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      // Non-auth error or retries exhausted
      throw err;
    }
  }
}

module.exports = { admin, auth, db, rtdb, warmUpFirebase, firestoreWithRetry };
