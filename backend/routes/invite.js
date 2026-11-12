'use strict';

const express    = require('express');
const rateLimit  = require('express-rate-limit');
const { body }   = require('express-validator');
const requireAuth = require('../middleware/requireAuth');

const {
  sendInvite,
  generateInvite,
  validateCode,
  validateToken,
  joinSuite,
  invalidateHostInvites,
} = require('../controllers/inviteController');

const inviteStore = require('../models/inviteStore');
const router      = express.Router();

/* ── Rate limiters ───────────────────────────────────────────────── */
const inviteSendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many invite requests. Please wait 15 minutes.' },
});

const inviteValidateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many validation requests. Please wait 5 minutes.' },
});

const joinLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many join requests. Please wait 5 minutes.' },
});

/* ── Invite endpoints ────────────────────────────────────────────── */

// Generate + send invite email (requires host auth)
router.post('/invite/send',       inviteSendLimiter,     requireAuth, sendInvite);

// Generate invite code/link only — no email (requires host auth)
router.post('/invite/generate',   inviteSendLimiter,     requireAuth, generateInvite);

// Validate 5-digit code (public — joining flow before login)
router.post('/invite/code',       inviteValidateLimiter, validateCode);

// Validate invite token from link (public — joining flow before login)
router.post('/invite/link',       inviteValidateLimiter, validateToken);

// Actually join the suite (requires uid)
router.post('/suite/join',        joinLimiter,           requireAuth, joinSuite);

// Host going offline — invalidate their invites (requires host auth)
router.post('/invite/invalidate', inviteSendLimiter,     requireAuth, invalidateHostInvites);

/* ── SSE: suite member presence stream ───────────────────────────── */
/**
 * GET /api/suite/:id/members/stream
 * Clients connect here to receive real-time member-list pushes.
 * On first connect, sends the current member list from Firestore.
 */
const { db } = require('../config/firebase');

router.get('/suite/:id/members/stream', async (req, res) => {
  const suiteId = (req.params.id || '').trim();
  if (!suiteId) { res.status(400).end(); return; }

  // Extract auth token / caller uid
  const authHeader = req.headers && (req.headers['authorization'] || req.headers['Authorization']);
  let token = (req.query.token || '').trim();
  if (!token && authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  }
  const session = token ? requireAuth.verifySessionToken(token) : null;
  const callerUid = session ? session.uid : (req.query.uid || req.headers['x-fs-uid'] || '').trim();

  // Validate suite exists and caller has access
  let suiteData = null;
  try {
    const doc = await db.collection('suites').doc(suiteId).get();
    if (!doc.exists) {
      return res.status(404).json({ success: false, error: 'Suite not found.' });
    }
    suiteData = doc.data();

    const memberUids = Array.isArray(suiteData.memberUids) ? suiteData.memberUids : [];
    const isOwner = suiteData.ownerUid === callerUid;
    const isMember = memberUids.includes(callerUid);

    // Enforce authorization
    if (callerUid && !isOwner && !isMember) {
      return res.status(403).json({ success: false, error: 'Forbidden: You are not a member of this suite.' });
    }
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to access suite.' });
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Nginx: disable buffering
  res.flushHeaders();

  // Register this client
  if (!inviteStore.sseClients.has(suiteId)) {
    inviteStore.sseClients.set(suiteId, new Set());
  }
  inviteStore.sseClients.get(suiteId).add(res);

  // Send current members immediately on connect
  try {
    if (suiteData) {
      let members = Array.isArray(suiteData.members) ? [...suiteData.members] : [];
      const memberUids = Array.isArray(suiteData.memberUids) ? suiteData.memberUids : [];
      const ownerUid = suiteData.ownerUid;

      // Ensure owner is included
      if (ownerUid && !members.some(m => m.uid === ownerUid)) {
        try {
          const ownerDoc = await db.collection('users').doc(ownerUid).get();
          const o = ownerDoc.exists ? ownerDoc.data() : {};
          members.unshift({
            uid: ownerUid,
            name: o.name || 'Host',
            username: o.username || '',
            isHost: true,
          });
        } catch (_) {}
      }

      // If members array was empty or incomplete, resolve from memberUids
      if (members.length < memberUids.length) {
        const existingUids = new Set(members.map(m => m.uid));
        for (const mUid of memberUids) {
          if (!existingUids.has(mUid)) {
            try {
              const uDoc = await db.collection('users').doc(mUid).get();
              const u = uDoc.exists ? uDoc.data() : {};
              members.push({
                uid: mUid,
                name: u.name || mUid,
                username: u.username || '',
                isHost: mUid === ownerUid,
                isAdmin: (suiteData.adminUids || []).includes(mUid),
              });
            } catch (_) {}
          }
        }
      }

      res.write(`data: ${JSON.stringify({ type: 'members', members })}\n\n`);
    }
  } catch (_) {}

  // Heartbeat every 25s to keep connection alive through proxies
  const hb = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (_) { clearInterval(hb); }
  }, 25000);

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(hb);
    const clients = inviteStore.sseClients.get(suiteId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) inviteStore.sseClients.delete(suiteId);
    }
  });
});

module.exports = router;
