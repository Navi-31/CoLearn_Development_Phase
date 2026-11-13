'use strict';
/**
 * Firebase Admin SDK – initialisation
 * ─────────────────────────────────────────────────────────────────
 * Securely loads service-account credentials and exports ready-to-use
 * references for `admin`, `auth`, `db` (Firestore), and `rtdb`.
 *
 * Credential Loading Priority:
 *   1. FIREBASE_SERVICE_ACCOUNT_JSON: Protected deployment environment secret
 *      storing the raw or base64-encoded service-account JSON (Production).
 *   2. FIREBASE_KEY_PATH: File path on disk (resolved relative to backend
 *      project directory, not cwd), defaulting to ./config/serviceAccountKey.json (Local Dev).
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

/**
 * Validates required service-account fields and normalizes private_key newlines.
 * Never logs credentials or private keys.
 */
function validateServiceAccount(serviceAccount, sourceDescription) {
  if (!serviceAccount || typeof serviceAccount !== 'object') {
    throw new Error(`Invalid service-account credential format from ${sourceDescription}. Expected a JSON object.`);
  }

  const missingFields = [];
  if (!serviceAccount.project_id || typeof serviceAccount.project_id !== 'string') {
    missingFields.push('project_id');
  }
  if (!serviceAccount.client_email || typeof serviceAccount.client_email !== 'string') {
    missingFields.push('client_email');
  }
  if (!serviceAccount.private_key || typeof serviceAccount.private_key !== 'string') {
    missingFields.push('private_key');
  }

  if (missingFields.length > 0) {
    throw new Error(`Service-account credentials from ${sourceDescription} are missing required field(s): ${missingFields.join(', ')}.`);
  }

  // Normalize escaped newline characters in private_key (common when stored in environment secrets)
  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');

  return serviceAccount;
}

/**
 * Loads service account credentials with strict priority:
 *   1. FIREBASE_SERVICE_ACCOUNT_JSON (Production environment secret)
 *   2. FIREBASE_KEY_PATH (Local serviceAccountKey.json file)
 */
function loadServiceAccountCredentials() {
  const isProduction = process.env.NODE_ENV === 'production';
  const rawEnvJson = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();

  // 1. If FIREBASE_SERVICE_ACCOUNT_JSON is explicitly configured, use it (Highest Priority)
  if (rawEnvJson) {
    let parsed;
    try {
      if (rawEnvJson.startsWith('{')) {
        parsed = JSON.parse(rawEnvJson);
      } else {
        // Support base64-encoded JSON string
        try {
          const decoded = Buffer.from(rawEnvJson, 'base64').toString('utf8');
          parsed = JSON.parse(decoded);
        } catch (_) {
          parsed = JSON.parse(rawEnvJson);
        }
      }
    } catch (parseErr) {
      console.error('\n❌  Firebase Admin SDK: Invalid JSON in FIREBASE_SERVICE_ACCOUNT_JSON.');
      console.error(`   → Details: ${parseErr.message}`);
      console.error('   → Ensure the environment secret contains valid raw JSON or base64-encoded JSON.\n');
      process.exit(1);
    }

    try {
      const validated = validateServiceAccount(parsed, 'FIREBASE_SERVICE_ACCOUNT_JSON environment variable');
      console.log('[Firebase] Loaded service account credentials from environment secret (FIREBASE_SERVICE_ACCOUNT_JSON).');
      return validated;
    } catch (valErr) {
      console.error('\n❌  Firebase Admin SDK: Invalid service-account credentials in FIREBASE_SERVICE_ACCOUNT_JSON.');
      console.error(`   → Details: ${valErr.message}`);
      console.error('   → Ensure project_id, client_email, and private_key are present.\n');
      process.exit(1);
    }
  }

  // In production, never depend on a local service-account JSON file on disk
  if (isProduction && !process.env.FIREBASE_KEY_PATH) {
    console.error('\n❌  Firebase Admin SDK: Missing production credentials.');
    console.error('   In production (NODE_ENV=production), credentials must be supplied via the secure environment secret:');
    console.error('   FIREBASE_SERVICE_ACCOUNT_JSON=<service-account-json-content>');
    console.error('   → Never commit service-account JSON files to version control.\n');
    process.exit(1);
  }

  // 2. Otherwise use FIREBASE_KEY_PATH (Local Development)
  const keyPath = process.env.FIREBASE_KEY_PATH || './config/serviceAccountKey.json';
  const BACKEND_DIR = path.resolve(__dirname, '..');
  // Always resolve relative paths against the backend directory, not process.cwd()
  const resolvedPath = path.isAbsolute(keyPath) ? keyPath : path.resolve(BACKEND_DIR, keyPath);

  if (!fs.existsSync(resolvedPath)) {
    console.error('\n❌  Firebase Admin SDK: Service-account key file not found.');
    console.error(`   → Configured Path: ${keyPath}`);
    console.error(`   → Resolved Path:   ${resolvedPath}`);
    console.error('   → Actionable Steps for Local Development:');
    console.error('     1. Download your service account key from Firebase Console → Project Settings → Service Accounts');
    console.error(`     2. Place the file at: ${resolvedPath}`);
    console.error('        (or set FIREBASE_KEY_PATH in backend/.env)\n');
    console.error('   → Actionable Steps for Production Deployment:');
    console.error('     Configure FIREBASE_SERVICE_ACCOUNT_JSON in your host\'s environment secrets dashboard.\n');
    process.exit(1);
  }

  let fileContent;
  try {
    fileContent = fs.readFileSync(resolvedPath, 'utf8');
  } catch (readErr) {
    console.error(`\n❌  Firebase Admin SDK: Cannot read service-account file at ${resolvedPath}.`);
    console.error(`   → Details: ${readErr.message}\n`);
    process.exit(1);
  }

  let parsedFile;
  try {
    parsedFile = JSON.parse(fileContent);
  } catch (jsonErr) {
    console.error(`\n❌  Firebase Admin SDK: Invalid JSON in service-account file at ${resolvedPath}.`);
    console.error(`   → Details: ${jsonErr.message}\n`);
    process.exit(1);
  }

  try {
    const validated = validateServiceAccount(parsedFile, `file at ${resolvedPath}`);
    console.log(`[Firebase] Loaded service account credentials from file: ${resolvedPath}`);
    return validated;
  } catch (valErr) {
    console.error(`\n❌  Firebase Admin SDK: Invalid service-account credentials in ${resolvedPath}.`);
    console.error(`   → Details: ${valErr.message}\n`);
    process.exit(1);
  }
}

const serviceAccount = loadServiceAccountCredentials();
const credentialInstance = cert(serviceAccount);
const databaseURL = process.env.FIREBASE_DATABASE_URL || (serviceAccount && serviceAccount.project_id ? `https://${serviceAccount.project_id}-default-rtdb.firebaseio.com` : 'https://your-project-id-default-rtdb.firebaseio.com');

/* ── Initialise Firebase Admin only once ───────────────────────── */
let app;
try {
  if (getApps().length > 0) {
    app = getApps()[0];
  } else {
    app = initializeApp({
      credential: credentialInstance,
      databaseURL,
    });
    console.log(`🔥  Firebase Admin initialised (project: ${serviceAccount.project_id})`);
  }
} catch (initErr) {
  console.error('\n❌  Firebase Admin SDK: Initialization failure.');
  console.error(`   → Details: ${initErr.message}\n`);
  process.exit(1);
}

const auth = getAuth(app);
const db   = getFirestore(app);
let rtdb   = null;
try {
  rtdb = getDatabase(app);
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
