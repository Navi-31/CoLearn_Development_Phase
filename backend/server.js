'use strict';
/**
 * CoLearn – Express Backend
 * ─────────────────────────────────────────────────────────────────
 * Serves the frontend (../frontend) as static files AND provides
 * the REST API. Binds on 0.0.0.0 so ANY device on the same LAN
 * can reach it via http://<your-ip>:PORT
 *
 * Usage:
 *   node server.js           (production)
 *   npm run dev              (development, with nodemon)
 */

require('dotenv').config();

/* ── Auto-derive GOOGLE_REDIRECT_URI from APP_URL / BACKEND_URL ────
   Production: set BACKEND_URL=https://api.yourdomain.com or APP_URL
   Local dev: defaults to http://localhost:PORT/api/drive/callback
   ────────────────────────────────────────────────────────────────── */
(function deriveRedirectUri() {
  if (!process.env.GOOGLE_REDIRECT_URI) {
    const appUrl = (process.env.BACKEND_URL || process.env.APP_URL || '').trim().replace(/\/$/, '');
    if (appUrl) {
      process.env.GOOGLE_REDIRECT_URI = appUrl + '/api/drive/callback';
      console.log('[Drive] GOOGLE_REDIRECT_URI auto-derived:', process.env.GOOGLE_REDIRECT_URI);
    } else {
      // Fallback for local dev with no APP_URL
      process.env.GOOGLE_REDIRECT_URI = 'http://localhost:' + (process.env.PORT || '3000') + '/api/drive/callback';
      console.log('[Drive] GOOGLE_REDIRECT_URI defaulted to:', process.env.GOOGLE_REDIRECT_URI);
    }
  }
})();

/* ── Google OAuth startup guard ──────────────────────────────────
   Catches missing / placeholder credentials BEFORE the server binds.
   401 invalid_client at Google means these values are wrong/placeholder.
   ────────────────────────────────────────────────────────────── */
(function checkGoogleOAuthConfig() {
  const id     = process.env.GOOGLE_CLIENT_ID     || '';
  const secret = process.env.GOOGLE_CLIENT_SECRET || '';
  const redir  = process.env.GOOGLE_REDIRECT_URI  || '';
  const env    = process.env.NODE_ENV || 'development';
  const isProd = env === 'production';

  const PLACEHOLDER_RE = /your_google|placeholder|_id_here|_secret_here|xxx|<.*>|CHANGE_ME/i;

  const missing  = [];
  const problems = [];

  if (!id)                            missing.push('GOOGLE_CLIENT_ID');
  else if (PLACEHOLDER_RE.test(id))   problems.push('GOOGLE_CLIENT_ID is still a placeholder — paste the real value from Google Cloud Console');
  else if (!id.endsWith('.apps.googleusercontent.com'))
    problems.push('GOOGLE_CLIENT_ID does not end with .apps.googleusercontent.com — check for copy/paste errors');

  if (!secret)                          missing.push('GOOGLE_CLIENT_SECRET');
  else if (PLACEHOLDER_RE.test(secret)) problems.push('GOOGLE_CLIENT_SECRET is still a placeholder — paste the real value from Google Cloud Console');

  if (!redir) missing.push('GOOGLE_REDIRECT_URI');

  if (isProd && redir && redir.startsWith('http://')) {
    problems.push('GOOGLE_REDIRECT_URI uses http:// in production — must be https://');
  }

  if (missing.length || problems.length) {
    console.error('');
    console.error('╔══════════════════════════════════════════════════════════════════╗');
    console.error('║        ⚠️  GOOGLE DRIVE NOT CONFIGURED  ⚠️                       ║');
    console.error('║        Environment: ' + env.padEnd(45) + '║');
    console.error('╠══════════════════════════════════════════════════════════════════╣');
    if (missing.length)
      console.error('║  MISSING : ' + missing.join(', ').padEnd(54) + '║');
    if (problems.length)
      problems.forEach(p => {
        // word-wrap at 54 chars
        const chunks = p.match(/.{1,54}/g) || [p];
        chunks.forEach((c, i) =>
          console.error('║  ' + (i === 0 ? 'PROBLEM : ' : '          ') + c.padEnd(54) + '║')
        );
      });
    console.error('╠══════════════════════════════════════════════════════════════════╣');
    console.error('║  HOW TO FIX (one-time admin setup):                              ║');
    console.error('║  1. https://console.cloud.google.com/                            ║');
    console.error('║  2. APIs & Services → Credentials                                ║');
    console.error('║  3. Create OAuth 2.0 Client ID → Web application                 ║');
    console.error('║  4. Add Authorized Redirect URI:                                  ║');
    if (isProd) {
      console.error('║     https://YOUR_DOMAIN/api/drive/callback                        ║');
    } else {
      console.error('║     http://localhost:' + (process.env.PORT || '3000') + '/api/drive/callback                    ║');
    }
    console.error('║  5. Paste Client ID + Secret into backend/.env                    ║');
    console.error('║  6. Restart server                                                ║');
    console.error('║                                                                   ║');
    console.error('║  Google Drive upload DISABLED. All other features work normally.  ║');
    console.error('╚══════════════════════════════════════════════════════════════════╝');
    console.error('');
    process.env._DRIVE_MISCONFIGURED = '1';
  } else {
    // Mask sensitive values for safe logging
    const maskId  = id.substring(0, 12) + '...' + id.slice(-28);
    const maskSec = secret.substring(0, 8) + '...' + secret.slice(-4);
    const envTag  = isProd ? '🟢 production' : '🟡 development';
    console.log('🔑  Google Drive OAuth [' + envTag + ']');
    console.log('    Client ID  : ' + maskId);
    console.log('    Redirect   : ' + redir);
  }
})();

const express      = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const cors         = require('cors');
const helmet       = require('helmet');
const path         = require('path');
const os           = require('os');

// Initialise Firebase Admin before any routes import it
const { warmUpFirebase } = require('./config/firebase');

const emailConfig  = require('./config/email');
const store        = require('./models/store');
const authRoutes   = require('./routes/auth');
const inviteRoutes = require('./routes/invite');
const suiteRoutes  = require('./routes/suite');
const driveRoutes  = require('./routes/drive');
const aiRoutes     = require('./routes/ai');
const errorHandler = require('./middleware/errorHandler');

/* ── Initialise email transporter (async — runs verify()) ───── */
// emailConfig.init() is async because it calls transporter.verify().
// We call it here so SMTP status is known before first request.
// The server still starts even if SMTP fails — email is non-critical.
emailConfig.init().catch(err => {
  // init() handles its own logging — this catch is a last-resort safety net
  console.error('[server] emailConfig.init() rejected unexpectedly:', err.message);
});

/* ── App setup ───────────────────────────────────────────────── */
const app  = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';   // ← Bind on ALL interfaces (LAN + localhost)
const httpServer = http.createServer(app);

// Enable trust proxy for accurate rate limiting behind Nginx / Cloudflare
app.set('trust proxy', 1);

/* ── Security headers (Helmet) ───────────────────────────────── */
app.use(helmet({
  // Allow inline scripts/styles needed by the vanilla-JS frontend SPA
  contentSecurityPolicy: false,
  // Allow cross-origin resources for LAN access
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginOpenerPolicy: false,
  frameguard: { action: 'sameorigin' },
  noSniff: true,
  xssFilter: true,
  hidePoweredBy: true,
  hsts: process.env.NODE_ENV === 'production' ? {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  } : false,
}));

/* ── CORS – Centralized Environment-Aware Configuration ───────── */
const rawAllowed = [
  process.env.ALLOWED_ORIGINS || '',
  process.env.ALLOWED_ORIGIN || '',
  process.env.FRONTEND_URL || '',
  process.env.APP_URL || '',
]
  .join(',')
  .split(',')
  .map(s => s.trim().replace(/\/$/, ''))
  .filter(Boolean);

const configuredOrigins = [...new Set(rawAllowed)];
const isWildcardConfigured = configuredOrigins.includes('*');

if (process.env.NODE_ENV === 'production' && isWildcardConfigured) {
  console.warn('⚠️  [Security Warning] ALLOWED_ORIGINS is set to wildcard (*) in production. Consider restricting to your specific domain.');
}

function isOriginAllowed(origin) {
  // Allow requests with no origin (mobile apps, server-to-server, curl)
  if (!origin) return true;

  const normalized = origin.trim().replace(/\/$/, '');

  // 1. Explicitly configured origins
  if (configuredOrigins.some(c => c.toLowerCase() === normalized.toLowerCase())) {
    return true;
  }

  // 2. Cloudflare Pages support: allow preview / branch domains if base domain is configured
  try {
    const originUrl = new URL(normalized);
    const originHost = originUrl.hostname.toLowerCase();

    for (const allowed of configuredOrigins) {
      if (allowed === '*') continue;
      try {
        const allowedHost = new URL(allowed).hostname.toLowerCase();
        if (allowedHost.endsWith('.pages.dev') && originHost.endsWith('.pages.dev')) {
          return true;
        }
        if (originHost === allowedHost || originHost.endsWith('.' + allowedHost)) {
          return true;
        }
      } catch (_) {}
    }
  } catch (_) {}

  // 3. Localhost & development environments (only when not strictly production)
  const isProduction = process.env.NODE_ENV === 'production';
  if (!isProduction) {
    if (isWildcardConfigured || configuredOrigins.length === 0) return true;
    try {
      const { hostname } = new URL(normalized);
      if (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '::1' ||
        hostname.endsWith('.localhost') ||
        /^192\.168\./.test(hostname) ||
        /^10\./.test(hostname) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
      ) {
        return true;
      }
    } catch (_) {}
  }

  return false;
}

const corsOptions = {
  origin: (origin, callback) => {
    if (isOriginAllowed(origin)) {
      return callback(null, true);
    }
    const err = new Error(`CORS blocked: Origin ${origin} not permitted.`);
    err.status = 403;
    return callback(err);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'Accept',
    'Origin',
    'X-FS-UID',
    'X-Suite-ID',
  ],
  exposedHeaders: ['Content-Length', 'X-Request-Id'],
  credentials: true,
  optionsSuccessStatus: 200,
};

// Handle pre-flight OPTIONS for all routes
app.options('*', cors(corsOptions));
app.use(cors(corsOptions));

/* ── Body parsing ────────────────────────────────────────────── */
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

/* ── Static frontend ─────────────────────────────────────────── */
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
app.use(express.static(FRONTEND_DIR, {
  // Allow LAN clients to get fresh assets
  setHeaders: (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
  },
}));

/* ── API routes ──────────────────────────────────────────────────────────── */
app.use('/api', authRoutes);
app.use('/api', inviteRoutes);
app.use('/api', suiteRoutes);
app.use('/api', driveRoutes);
app.use('/api', aiRoutes);

/* ── Diagnostic endpoint: GET /api/debug/email ───────────────────── */
/**
 * Returns the live SMTP / Firebase / env status.
 * Useful for diagnosing email delivery problems without restarting.
 * Restricted in production.
 */
app.get('/api/debug/email', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ success: false, error: 'Debug endpoints are disabled in production.' });
  }
  const { auth: fbAuth } = require('./config/firebase');

  // Check Firebase connectivity
  let firebaseOk = false;
  let firebaseError = null;
  try {
    // Lightweight call — list 1 user to confirm Admin SDK is live
    await fbAuth.listUsers(1);
    firebaseOk = true;
  } catch (e) {
    firebaseError = e.code || e.message || 'unknown';
  }

  // Check live SMTP by calling verify() again
  let smtpLive = false;
  let smtpError = null;
  if (emailConfig.configured && emailConfig.transporter) {
    try {
      await emailConfig.transporter.verify();
      smtpLive = true;
    } catch (e) {
      smtpError = e.code || e.message || 'unknown';
    }
  }

  const storeStats = store.getStats();

  const result = {
    emailStats: storeStats,
    smtp: {
      configured:  emailConfig.configured,
      verified:    smtpLive,
      account:     emailConfig.SMTP_USER
        ? emailConfig.SMTP_USER.replace(/^(.)(.+)(@.+)$/, (_, a, b, c) => a + '*'.repeat(b.length) + c)
        : null,
      error:       smtpError,
    },
    firebase: {
      ok:    firebaseOk,
      error: firebaseError,
    },
    env: {
      smtpUserSet:  Boolean(process.env.SMTP_USER),
      smtpPassSet:  Boolean(process.env.SMTP_PASS),
      firebaseKeySet: Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_KEY_PATH),
      nodeEnv:      process.env.NODE_ENV || 'development',
    },
    timestamp: new Date().toISOString(),
  };

  const allOk = emailConfig.configured && smtpLive && firebaseOk;
  return res.status(allOk ? 200 : 503).json(result);
});

/* ── GET /api/debug/documents ─────────────────────────────────────── */
/**
 * Returns a complete snapshot of the document subsystem for a user + suite.
 *
 * Query params:
 *   uid     – user UID to inspect Drive connection + folder IDs
 *   suiteId – (optional) suite ID to inspect folder + membership
 *
 * Returns no secrets (tokens, credentials, emails only masked).
 * Safe to call in development; no authentication required (debug only).
 */
app.get('/api/debug/documents', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ success: false, error: 'Debug endpoints are disabled in production.' });
  }
  const driveAuthService = require('./services/driveAuthService');
  const driveService     = require('./services/driveService');
  const { db: fsDb }     = require('./config/firebase');

  const uid     = (req.query.uid     || '').trim();
  const suiteId = (req.query.suiteId || '').trim();

  // ── User / Drive connection info ─────────────────────────────
  let driveConnected  = false;
  let driveEmail      = null;
  let coLearnFolderId = null;
  let suiteFolderId   = null;
  let driveError      = null;

  if (uid) {
    try {
      const info     = await driveAuthService.getConnectionInfo(uid);
      driveConnected = info.connected    || false;
      driveEmail     = info.googleEmail  || null;
    } catch (e) {
      driveError = e.message;
    }

    // CoLearn root folder ID
    try {
      const snap = await fsDb.collection('users').doc(uid)
        .collection('privateData').doc('driveAuth').get();
      if (snap.exists) coLearnFolderId = snap.data().coLearnFolderId || null;
    } catch (_) { /* non-fatal */ }

    // Suite subfolder ID for this user (cached in Firestore)
    if (suiteId) {
      try {
        const suiteSnap = await fsDb.collection('suites').doc(suiteId).get();
        if (suiteSnap.exists) {
          const sd = suiteSnap.data();
          // New per-user folder cache (driveFolderIdByUser.{uid})
          if (sd.driveFolderIdByUser && sd.driveFolderIdByUser[uid]) {
            suiteFolderId = sd.driveFolderIdByUser[uid];
          } else {
            // Fallback: legacy shared folder (pre-2-level hierarchy)
            suiteFolderId = sd.driveFolderId || null;
          }
        }
      } catch (_) { /* non-fatal */ }
    }
  }

  // ── Suite info + membership ───────────────────────────────────
  let suiteInfo = null;
  if (suiteId) {
    try {
      const suiteSnap = await fsDb.collection('suites').doc(suiteId).get();
      if (suiteSnap.exists) {
        const sd         = suiteSnap.data();
        const memberUids = sd.memberUids || [];
        const isMember   = uid ? (memberUids.includes(uid) || sd.ownerUid === uid) : null;
        const isHost     = uid ? sd.ownerUid === uid : null;

        // Count actual uploaded files in this suite
        let fileCount = 0;
        try {
          const filesSnap = await fsDb.collection('suites').doc(suiteId)
            .collection('files').get();
          fileCount = filesSnap.size;
        } catch (_) {}

        suiteInfo = {
          id:           suiteId,
          name:         sd.name         || null,
          ownerUid:     sd.ownerUid     || null,
          isPrivate:    sd.isPrivate    || false,
          memberCount:  memberUids.length,
          fileCount,
          isMember,
          isHost,
          suiteFolderId, // per-user Drive folder for this suite
        };
      } else {
        suiteInfo = { id: suiteId, exists: false };
      }
    } catch (e) {
      suiteInfo = { id: suiteId, error: e.message };
    }
  }

  // ── SSE listener count (backend perspective) ──────────────────
  // The backend SSE registry tracks how many clients are subscribed per suite.
  let sseClients = null;
  try {
    const { getSuiteClientCount } = require('./controllers/driveController');
    if (typeof getSuiteClientCount === 'function') {
      sseClients = suiteId ? getSuiteClientCount(suiteId) : 'pass ?suiteId= to query';
    }
  } catch (_) { /* controller may not export this */ }

  return res.json({
    user: {
      uid:            uid     || null,
      driveConnected,
      driveEmail:     driveEmail ? driveEmail.replace(/(?<=.).(?=.*@)/g, '*') : null, // mask middle chars
      coLearnFolderId,
      driveError,
    },
    suite:       suiteInfo,
    otpStore:    store.getStats(),
    sse: {
      note:        'Client-side listener count is reported by CoLearnDebug.getListeners() in the browser console.',
      backendClients: sseClients,
    },
    // Frontend-side status: readable via CoLearnDebug.getDocumentStatus() in browser DevTools
    frontendDebug: 'Run CoLearnDebug.getDocumentStatus() in the browser console for queue, cache, and listener status.',
    timestamp:   new Date().toISOString(),
  });
});


/* ── POST /api/debug/send-test-email ─────────────────────────────── */
/**
 * Send a test email without generating an OTP.
 * Body: { to: "someone@example.com" }
 * DISABLED in production (NODE_ENV=production).
 */
app.post('/api/debug/send-test-email', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({
      success: false,
      error:   'Debug endpoints are disabled in production.',
    });
  }

  const to = (req.body.to || '').trim();
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return res.status(400).json({
      success: false,
      error:   'Provide a valid "to" email address in the request body.',
    });
  }

  if (!emailConfig.configured || !emailConfig.transporter) {
    return res.json({
      success:        false,
      smtpConfigured: false,
      error:          'SMTP not configured. Set SMTP_USER and SMTP_PASS in backend/.env.',
    });
  }

  try {
    const info = await emailConfig.transporter.sendMail({
      from:    `"${emailConfig.FROM_NAME || 'CoLearn'}" <${emailConfig.SMTP_USER}>`,
      to,
      subject: 'CoLearn – Test Email ✅',
      html:    `<h2>✅ CoLearn SMTP Test</h2>
               <p>Your SMTP configuration is working correctly!</p>
               <p>Server: ${process.env.APP_URL || 'localhost'}</p>
               <p>Sent at: ${new Date().toISOString()}</p>`,
      text:    'CoLearn SMTP Test — Your email configuration is working correctly.',
    });
    return res.json({ success: true, messageId: info.messageId, to });
  } catch (e) {
    return res.status(503).json({ success: false, error: e.message });
  }
});

/* ── SPA fallback (serve index.html for all non-API routes) ─── */
// This includes /invite/:token paths so the frontend router handles them
app.get('*', (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

/* ── Global error handler ────────────────────────────────────── */
app.use(errorHandler);

/* ── Helpers ─────────────────────────────────────────────────── */
/**
 * Returns the first non-internal IPv4 address found.
 * Prefers Wi-Fi / Ethernet adapters over virtual adapters.
 */
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  const candidates = [];

  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        candidates.push({ name, address: iface.address });
      }
    }
  }

  // Prefer Wi-Fi / Ethernet over virtual/VMware adapters
  const preferred = candidates.find(c =>
    /wi[-\s]?fi|wlan|ethernet|en\d|eth\d/i.test(c.name)
  );
  if (preferred) return preferred.address;
  if (candidates.length > 0) return candidates[0].address;
  return 'localhost';
}

/* ── Start server ────────────────────────────────────────────── */
/* ── WebSocket signaling for WebRTC ─────────────────────────── */
const wss = new WebSocketServer({
  server: httpServer,
  path: '/ws/video',
});

const videoRooms = new Map();

wss.on('connection', (ws) => {
  console.log('[WS] Video signaling client connected');

  let roomId = null;
  let uid = null;

  ws.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString());

      if (message.type === 'join') {
        roomId = String(message.roomId || '');
        uid = String(message.uid || '');

        if (!roomId || !uid) {
          ws.close(1008, 'roomId and uid required');
          return;
        }

        if (!videoRooms.has(roomId)) {
          videoRooms.set(roomId, new Map());
        }

        const room = videoRooms.get(roomId);

        for (const [peerUid, peerWs] of room) {
          if (peerUid === uid) continue;

          if (peerWs.readyState === 1) {
            ws.send(JSON.stringify({
              type: 'peer-joined',
              uid: peerUid,
            }));

            peerWs.send(JSON.stringify({
              type: 'peer-joined',
              uid,
            }));
          }
        }

        room.set(uid, ws);

        console.log(`[WS] ${uid.slice(0, 8)} joined room ${roomId}`);
        return;
      }

      if (!roomId || !uid) return;

      const room = videoRooms.get(roomId);
      if (!room) return;

      const targetUid = message.targetUid;
      const targetWs = room.get(targetUid);

      if (!targetWs || targetWs.readyState !== 1) {
        console.warn(`[WS] Target unavailable: ${targetUid}`);
        return;
      }

      targetWs.send(JSON.stringify({
        ...message,
        fromUid: uid,
      }));

    } catch (err) {
      console.error('[WS] Invalid message:', err.message);
    }
  });

  ws.on('close', () => {
    if (!roomId || !uid) return;

    const room = videoRooms.get(roomId);

    if (room && room.get(uid) === ws) {
      room.delete(uid);

      for (const peerWs of room.values()) {
        if (peerWs.readyState === 1) {
          peerWs.send(JSON.stringify({
            type: 'peer-left',
            uid,
          }));
        }
      }

      if (room.size === 0) {
        videoRooms.delete(roomId);
      }
    }

    console.log(`[WS] ${uid.slice(0, 8)} disconnected`);
  });

  ws.on('error', (err) => {
    console.error('[WS] Client error:', err.message);
  });
});

console.log('[WS] WebRTC signaling available at /ws/video');

async function startServer() {
  let attempt = 0;
  const baseDelay = 500;
  const maxDelay = 16000;

  while (true) {
    try {
      await warmUpFirebase();
      break;
    } catch (err) {
      attempt++;
      const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
      console.error(`\n❌  Firebase Warm-up failed (attempt ${attempt}):`);
      console.error(`    Message: ${err.message || 'Unknown'}`);
      console.error(`    Code: ${err.code || 'N/A'}`);
      console.error(`    Stack: ${err.stack || 'N/A'}`);
      console.error(`\n💡  ACTIONABLE DIAGNOSIS:`);
      console.error(`    - Please verify your system clock is accurate (matches current real time).`);
      console.error(`    - Check if you are behind a corporate proxy, VPN, or firewall.`);
      console.error(`    - Verify network connectivity to oauth2.googleapis.com and firestore.googleapis.com.`);
      console.error(`    - Verify that your service account credentials key in backend/config/serviceAccountKey.json is still valid and has not been revoked.\n`);
      console.log(`🔄  Retrying Firebase warm-up in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  httpServer.listen(PORT, HOST, () => {
    const ip = getLocalIP();
    const line = '═'.repeat(58);
    const smtpStatus = emailConfig.configured
      ? (emailConfig.verified ? '  ✅ SMTP Connected           ' : '  ⚠️  SMTP configured (unverified)')
      : '  ⚠️  SMTP NOT configured (OTPs → console)';
    console.log('');
    console.log(`╔${line}╗`);
    console.log(`║             🔗  CoLearn Server  🔗                    ║`);
    console.log(`╠${line}╣`);
    console.log(`║  Local   →  http://localhost:${PORT}                         ║`);
    console.log(`║  Network →  http://${ip}:${PORT}                     ║`);
    console.log(`╠${line}╣`);
    console.log(`║  📧  Email Status:                                        ║`);
    console.log(`║  ${smtpStatus.padEnd(56)}║`);
    console.log(`╠${line}╣`);
    console.log(`║  📋  API endpoints:                                       ║`);
    console.log(`║    GET  /api/health                                       ║`);
    console.log(`║    GET  /api/debug/email       (SMTP + Firebase status)   ║`);
    console.log(`║    POST /api/send-otp          (signup OTP)               ║`);
    console.log(`║    POST /api/verify-otp        (verify signup OTP)        ║`);
    console.log(`║    POST /api/auth/register                                ║`);
    console.log(`║    POST /api/auth/login                                   ║`);
    console.log(`║    POST /api/auth/send-reset-otp                          ║`);
    console.log(`║    POST /api/auth/verify-reset-otp                        ║`);
    console.log(`║    POST /api/auth/reset-password                          ║`);
    console.log(`║    GET  /api/suites?uid=<uid>  (user's suites)            ║`);
    console.log(`║    POST /api/suites            (create suite)             ║`);
    console.log(`║    DELETE /api/suites/:id      (delete suite)             ║`);
    console.log(`║    POST /api/invite/send       (send invite email)        ║`);
    console.log(`║    POST /api/invite/generate   (get code+link only)       ║`);
    console.log(`║    POST /api/invite/code       (validate 5-digit code)    ║`);
    console.log(`║    POST /api/invite/link       (validate invite token)    ║`);
    console.log(`║    POST /api/suite/join        (join a suite)             ║`);
    console.log(`║    POST /api/invite/invalidate (host offline)             ║`);
    console.log(`║    GET  /api/suite/:id/members/stream  (SSE)              ║`);
    console.log(`╠${line}╣`);
    console.log(`║  🌐  LAN Access (other laptops / phones):                 ║`);
    console.log(`║    Open: http://${ip}:${PORT}                     ║`);
    console.log(`║                                                           ║`);
    console.log(`║  ⚠️  Windows Firewall: if other laptops can't connect,    ║`);
    console.log(`║     run this in PowerShell (as Administrator):            ║`);
    console.log(`║     netsh advfirewall firewall add rule name="CoLearn" ║`);
    console.log(`║       dir=in action=allow protocol=TCP localport=${PORT}       ║`);
    console.log(`╚${line}╝`);
    console.log('');
    console.log(`  ✅  Listening on http://0.0.0.0:${PORT}`);
    console.log(`  ✅  Share with LAN devices: http://${ip}:${PORT}`);
    console.log('');
  });

}

startServer();
