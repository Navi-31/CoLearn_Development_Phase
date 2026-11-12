'use strict';
/**
 * CoLearn – Suite Routes
 * ─────────────────────────────────────────────────────────────
 *   DELETE /api/suite/:suiteId/members/:memberId  – host removes a member
 *   GET    /api/suite/:suiteId/members            – list suite members
 *   POST   /api/suite/:suiteId/screen-share       – update screen-share state
 *   GET    /api/suite/:suiteId                    – get suite details
 */

const express = require('express');
const router  = express.Router();
const { admin, db, rtdb } = require('../config/firebase');
const driveController = require('../controllers/driveController');
const requireAuth = require('../middleware/requireAuth');

/* ── Auth helper ──────────────────────────────────────────────── */
function getCallerUid(req) {
  return (req.verifiedUid || req.headers['x-fs-uid'] || (req.body && req.body.uid) || (req.query && req.query.uid) || '').trim();
}

/* ══════════════════════════════════════════════════════════════
   GET /api/suite/:suiteId  – Suite details with resolved host name
   ══════════════════════════════════════════════════════════════ */
router.get('/suite/:suiteId', requireAuth, async (req, res) => {
  const { suiteId } = req.params;
  const callerUid   = getCallerUid(req);
  if (!callerUid) return res.status(401).json({ success: false, error: 'Authentication required.' });
  if (!suiteId)   return res.status(400).json({ success: false, error: 'Suite ID required.' });

  try {
    const snap = await db.collection('suites').doc(suiteId).get();
    if (!snap.exists) return res.status(404).json({ success: false, error: 'Suite not found.' });

    const suiteData = snap.data();
    const adminUids = Array.isArray(suiteData.adminUids) ? suiteData.adminUids : [];
    const memberUids = Array.isArray(suiteData.memberUids) ? suiteData.memberUids : [];
    const adminLimit = typeof suiteData.adminLimit === 'number' ? suiteData.adminLimit : 3;

    // Resolve authoritative host name from users collection
    let hostName = 'Host';
    if (suiteData.ownerUid) {
      try {
        const hostSnap = await db.collection('users').doc(suiteData.ownerUid).get();
        if (hostSnap.exists) {
          hostName = hostSnap.data().name || hostSnap.data().username || 'Host';
        }
      } catch (_) {}
    }

    const suite = {
      id: snap.id,
      ...suiteData,
      adminLimit,
      adminCount: adminUids.length,
      hostName,
    };
    return res.json({ success: true, suite });
  } catch (err) {
    console.error('[suite] GET /suite/:id error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/* ══════════════════════════════════════════════════════════════
   PATCH /api/suite/:suiteId/settings – Update suite settings
   Host can edit suite name and configured admin limit.
   Others read-only.
   ══════════════════════════════════════════════════════════════ */
router.patch('/suite/:suiteId/settings', requireAuth, async (req, res) => {
  const { suiteId } = req.params;
  const callerUid = getCallerUid(req);
  const { name, adminLimit } = req.body;

  if (!callerUid) return res.status(401).json({ success: false, error: 'Authentication required.' });
  if (!suiteId) return res.status(400).json({ success: false, error: 'Suite ID required.' });

  const suiteRef = db.collection('suites').doc(suiteId);

  try {
    const result = await db.runTransaction(async (transaction) => {
      const suiteDoc = await transaction.get(suiteRef);
      if (!suiteDoc.exists) {
        throw new Error('NOT_FOUND');
      }
      const data = suiteDoc.data();

      // Only host can update suite settings
      if (data.ownerUid !== callerUid) {
        throw new Error('FORBIDDEN_HOST_ONLY');
      }

      const updates = { updatedAt: new Date().toISOString() };

      if (name !== undefined) {
        const trimmedName = String(name).trim();
        if (!trimmedName) throw new Error('INVALID_NAME');
        if (trimmedName.length > 100) throw new Error('NAME_TOO_LONG');
        updates.name = trimmedName;
      }

      if (adminLimit !== undefined) {
        const parsedLimit = Number(adminLimit);
        if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 20) {
          throw new Error('INVALID_LIMIT_BOUNDS');
        }
        const currentAdminCount = Array.isArray(data.adminUids) ? data.adminUids.length : 0;
        if (parsedLimit < currentAdminCount) {
          const excess = currentAdminCount - parsedLimit;
          const err = new Error('LIMIT_BELOW_CURRENT_COUNT');
          err.excess = excess;
          err.currentAdminCount = currentAdminCount;
          throw err;
        }
        updates.adminLimit = parsedLimit;
      }

      transaction.update(suiteRef, updates);
      return { ...data, ...updates };
    });

    // Notify connected SSE clients / RTDB
    if (rtdb) {
      rtdb.ref(`suites/${suiteId}/settingsUpdated`).set({ at: Date.now(), updatedBy: callerUid }).catch(() => {});
    }

    return res.json({ success: true, message: 'Settings updated successfully.', suite: result });
  } catch (err) {
    if (err.message === 'NOT_FOUND') {
      return res.status(404).json({ success: false, error: 'Suite not found.' });
    }
    if (err.message === 'FORBIDDEN_HOST_ONLY') {
      return res.status(403).json({ success: false, error: 'Only the suite host can modify suite settings.' });
    }
    if (err.message === 'INVALID_NAME' || err.message === 'NAME_TOO_LONG') {
      return res.status(400).json({ success: false, error: 'Please enter a valid suite name (1-100 characters).' });
    }
    if (err.message === 'INVALID_LIMIT_BOUNDS') {
      return res.status(400).json({ success: false, error: 'Admin limit must be an integer between 1 and 20.' });
    }
    if (err.message === 'LIMIT_BELOW_CURRENT_COUNT') {
      return res.status(400).json({
        success: false,
        error: `Cannot reduce limit below current admin count (${err.currentAdminCount}). Please demote ${err.excess} admin(s) first.`,
        excess: err.excess,
        currentAdminCount: err.currentAdminCount,
      });
    }
    console.error('[suite] PATCH /settings error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/* ══════════════════════════════════════════════════════════════
   GET /api/suite/:suiteId/members  – List suite members with roles
   ══════════════════════════════════════════════════════════════ */
router.get('/suite/:suiteId/members', requireAuth, async (req, res) => {
  const { suiteId } = req.params;
  const callerUid   = getCallerUid(req);
  if (!callerUid) return res.status(401).json({ success: false, error: 'Authentication required.' });

  try {
    const snap  = await db.collection('suites').doc(suiteId).get();
    if (!snap.exists) return res.status(404).json({ success: false, error: 'Suite not found.' });

    const suite      = snap.data();
    let memberUids = Array.isArray(suite.memberUids) ? [...suite.memberUids] : [];
    if (suite.ownerUid && !memberUids.includes(suite.ownerUid)) {
      memberUids.unshift(suite.ownerUid);
    }

    // Authorization: only actual suite members (or host) may fetch the member list.
    // This prevents non-members from enumerating who is in a suite.
    const isCallerMember = suite.ownerUid === callerUid || memberUids.includes(callerUid);
    if (!isCallerMember) {
      return res.status(403).json({ success: false, error: 'Access denied: you are not a member of this suite.' });
    }

    const adminUids = Array.isArray(suite.adminUids) ? suite.adminUids : [];

    /* Fetch user profiles for each member */
    const members = await Promise.all(
      memberUids.map(async (uid) => {
        try {
          const userSnap = await db.collection('users').doc(uid).get();
          const u = userSnap.exists ? userSnap.data() : {};
          const isHost = uid === suite.ownerUid;
          const isAdmin = !isHost && adminUids.includes(uid);
          return { 
            uid, 
            name: u.name || uid, 
            username: u.username || uid, 
            role: isHost ? 'HOST' : (isAdmin ? 'ADMIN' : 'MEMBER'),
            isHost,
            isAdmin,
          };
        } catch {
          const isHost = uid === suite.ownerUid;
          const isAdmin = !isHost && adminUids.includes(uid);
          return { 
            uid, 
            name: uid, 
            username: uid, 
            role: isHost ? 'HOST' : (isAdmin ? 'ADMIN' : 'MEMBER'),
            isHost,
            isAdmin,
          };
        }
      })
    );

    return res.json({
      success: true,
      members,
      adminLimit: typeof suite.adminLimit === 'number' ? suite.adminLimit : 3,
      adminCount: adminUids.length,
    });
  } catch (err) {
    console.error('[suite] GET /suite/:id/members error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/* ══════════════════════════════════════════════════════════════
   DELETE /api/suite/:suiteId/members/:memberId  – Remove a member
   HOST: can remove MEMBER and ADMIN (cannot remove self).
   ADMIN: can remove MEMBER (cannot remove HOST, other ADMINs, or self).
   MEMBER: cannot remove anyone.
   ══════════════════════════════════════════════════════════════ */
router.delete('/suite/:suiteId/members/:memberId', requireAuth, async (req, res) => {
  const { suiteId, memberId } = req.params;
  const callerUid = getCallerUid(req);

  if (!callerUid)  return res.status(401).json({ success: false, error: 'Authentication required.' });
  if (!suiteId)    return res.status(400).json({ success: false, error: 'Suite ID required.' });
  if (!memberId)   return res.status(400).json({ success: false, error: 'Member ID required.' });
  if (callerUid === memberId) return res.status(400).json({ success: false, error: 'Host cannot remove themselves from the suite.' });

  try {
    const suiteRef  = db.collection('suites').doc(suiteId);
    let curMembers = [];
    let suiteName = '';

    await db.runTransaction(async (transaction) => {
      const suiteSnap = await transaction.get(suiteRef);
      if (!suiteSnap.exists) throw new Error('NOT_FOUND');

      const suite = suiteSnap.data();
      suiteName = suite.name || 'Suite';
      const isHost = suite.ownerUid === callerUid;
      const adminUids = Array.isArray(suite.adminUids) ? suite.adminUids : [];
      const isAdmin = !isHost && adminUids.includes(callerUid);

      const isTargetHost = suite.ownerUid === memberId;
      const isTargetAdmin = !isTargetHost && adminUids.includes(memberId);

      // Enforce removal authorization
      if (!isHost && !isAdmin) {
        throw new Error('FORBIDDEN_NOT_AUTHORIZED');
      }

      if (isTargetHost) {
        throw new Error('CANNOT_REMOVE_HOST');
      }

      if (isAdmin && !isHost && isTargetAdmin) {
        throw new Error('ADMIN_CANNOT_REMOVE_ADMIN');
      }

      const memberUids = Array.isArray(suite.memberUids) ? suite.memberUids : [];
      if (!memberUids.includes(memberId)) {
        throw new Error('MEMBER_NOT_IN_SUITE');
      }

      curMembers = (suite.members || []).filter(m => m.uid !== memberId);
      const newMemberUids = memberUids.filter(id => id !== memberId);
      const newAdminUids = adminUids.filter(id => id !== memberId);

      transaction.update(suiteRef, {
        memberUids: newMemberUids,
        adminUids: newAdminUids,
        members: curMembers,
        updatedAt: new Date().toISOString(),
      });
    });

    /* Broadcast updated members via SSE */
    try {
      const inviteController = require('../controllers/inviteController');
      if (typeof inviteController.broadcastMembers === 'function') {
        inviteController.broadcastMembers(suiteId, curMembers);
      }
    } catch (_) {}

    /* Clean up suite-specific presence immediately in RTDB */
    if (rtdb) {
      try {
        rtdb.ref(`suites/${suiteId}/presence/${memberId}`).remove().catch(() => {});
        const removedRef = rtdb.ref(`suites/${suiteId}/memberRemoved`);
        removedRef.set({ uid: memberId, removedBy: callerUid, at: Date.now() })
          .then(() => setTimeout(() => removedRef.remove().catch(() => {}), 10000))
          .catch(() => {});
      } catch (_) {}
    }

    /* Write notification to removed member */
    try {
      await db.collection('notifications').doc(memberId).collection('items').add({
        type:      'member_removed',
        title:     'Removed from Suite',
        body:      `You were removed from "${suiteName}"`,
        icon:      '🚫',
        data:      { suiteId, suiteName },
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        read:      false,
      });
    } catch (e) {
      console.warn('[suite] Notification write failed:', e.message);
    }

    /* Revoke removed member's Google Drive access (fire-and-forget) */
    try {
      const removedUserSnap = await db.collection('users').doc(memberId).get();
      const removedEmail    = removedUserSnap.exists ? (removedUserSnap.data().email || '') : '';
      if (removedEmail) {
        driveController.revokeMemberAccess(
          { verifiedUid: callerUid, body: { suiteId, memberEmail: removedEmail } },
          { json: () => {} }
        ).catch(e => console.warn('[suite] Drive revoke failed:', e.message));
      }
    } catch (e) {
      console.warn('[suite] Could not fetch removed member email for Drive revocation:', e.message);
    }

    console.log(`[suite] Member ${memberId} removed from suite ${suiteId} by ${callerUid}`);
    return res.json({ success: true, message: 'Member removed from suite.' });

  } catch (err) {
    if (err.message === 'NOT_FOUND') return res.status(404).json({ success: false, error: 'Suite not found.' });
    if (err.message === 'FORBIDDEN_NOT_AUTHORIZED') return res.status(403).json({ success: false, error: 'Only the suite host or an admin can remove members.' });
    if (err.message === 'CANNOT_REMOVE_HOST') return res.status(403).json({ success: false, error: 'The suite host cannot be removed.' });
    if (err.message === 'ADMIN_CANNOT_REMOVE_ADMIN') return res.status(403).json({ success: false, error: 'Admins cannot remove the host or other admins.' });
    if (err.message === 'MEMBER_NOT_IN_SUITE') return res.status(404).json({ success: false, error: 'Member not found in this suite.' });

    console.error('[suite] DELETE /members error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/* ══════════════════════════════════════════════════════════════
   POST /api/suite/:suiteId/promote/:memberId  – Promote to Admin
   HOST-only. Concurrency-safe admin limit enforcement.
   ══════════════════════════════════════════════════════════════ */
router.post('/suite/:suiteId/promote/:memberId', requireAuth, async (req, res) => {
  const { suiteId, memberId } = req.params;
  const callerUid = getCallerUid(req);

  if (!callerUid)  return res.status(401).json({ success: false, error: 'Authentication required.' });
  if (!suiteId || !memberId) return res.status(400).json({ success: false, error: 'Missing parameters.' });

  const suiteRef = db.collection('suites').doc(suiteId);

  try {
    const updatedSuite = await db.runTransaction(async (transaction) => {
      const suiteSnap = await transaction.get(suiteRef);
      if (!suiteSnap.exists) throw new Error('NOT_FOUND');

      const suite = suiteSnap.data();
      if (suite.ownerUid !== callerUid) {
        throw new Error('FORBIDDEN_HOST_ONLY');
      }
      if (suite.ownerUid === memberId) {
        throw new Error('CANNOT_PROMOTE_HOST');
      }

      const memberUids = Array.isArray(suite.memberUids) ? suite.memberUids : [];
      if (!memberUids.includes(memberId)) {
        throw new Error('MEMBER_NOT_FOUND');
      }

      const adminUids = Array.isArray(suite.adminUids) ? suite.adminUids : [];
      if (adminUids.includes(memberId)) {
        throw new Error('ALREADY_ADMIN');
      }

      const configuredLimit = typeof suite.adminLimit === 'number' ? suite.adminLimit : 3;
      if (adminUids.length >= configuredLimit) {
        const err = new Error('ADMIN_LIMIT_REACHED');
        err.limit = configuredLimit;
        err.count = adminUids.length;
        throw err;
      }

      const newAdminUids = [...adminUids, memberId];
      const curMembers = Array.isArray(suite.members) ? suite.members.map(m => {
        if (m.uid === memberId) return { ...m, role: 'ADMIN', isAdmin: true };
        return m;
      }) : [];
      const updates = {
        adminUids: newAdminUids,
        updatedAt: new Date().toISOString(),
      };
      if (curMembers.length > 0) updates.members = curMembers;
      transaction.update(suiteRef, updates);

      return { ...suite, adminUids: newAdminUids, members: curMembers };
    });

    try {
      const inviteController = require('../controllers/inviteController');
      if (typeof inviteController.broadcastMembers === 'function' && updatedSuite.members && updatedSuite.members.length) {
        inviteController.broadcastMembers(suiteId, updatedSuite.members);
      }
    } catch (_) {}

    return res.json({
      success: true,
      message: 'Member promoted to admin.',
      adminCount: updatedSuite.adminUids.length,
      adminLimit: updatedSuite.adminLimit || 3,
    });
  } catch (err) {
    if (err.message === 'NOT_FOUND') return res.status(404).json({ success: false, error: 'Suite not found.' });
    if (err.message === 'FORBIDDEN_HOST_ONLY') return res.status(403).json({ success: false, error: 'Only the suite host can promote members to admin.' });
    if (err.message === 'CANNOT_PROMOTE_HOST') return res.status(400).json({ success: false, error: 'Host is already the suite creator.' });
    if (err.message === 'MEMBER_NOT_FOUND') return res.status(404).json({ success: false, error: 'Member not found in this suite.' });
    if (err.message === 'ALREADY_ADMIN') return res.status(400).json({ success: false, error: 'Member is already an admin.' });
    if (err.message === 'ADMIN_LIMIT_REACHED') {
      return res.status(403).json({
        success: false,
        error: `Admin limit reached (${err.count}/${err.limit}). Increase the limit in Suite Settings before promoting.`,
      });
    }
    console.error('[suite] promote error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/* ══════════════════════════════════════════════════════════════
   POST /api/suite/:suiteId/demote/:memberId  – Demote to Member
   HOST-only. Cannot demote self.
   ══════════════════════════════════════════════════════════════ */
router.post('/suite/:suiteId/demote/:memberId', requireAuth, async (req, res) => {
  const { suiteId, memberId } = req.params;
  const callerUid = getCallerUid(req);

  if (!callerUid)  return res.status(401).json({ success: false, error: 'Authentication required.' });
  if (!suiteId || !memberId) return res.status(400).json({ success: false, error: 'Missing parameters.' });
  if (callerUid === memberId) return res.status(400).json({ success: false, error: 'Host cannot demote themselves.' });

  const suiteRef = db.collection('suites').doc(suiteId);

  try {
    const updatedSuite = await db.runTransaction(async (transaction) => {
      const suiteSnap = await transaction.get(suiteRef);
      if (!suiteSnap.exists) throw new Error('NOT_FOUND');

      const suite = suiteSnap.data();
      if (suite.ownerUid !== callerUid) {
        throw new Error('FORBIDDEN_HOST_ONLY');
      }

      const adminUids = Array.isArray(suite.adminUids) ? suite.adminUids : [];
      if (!adminUids.includes(memberId)) {
        throw new Error('NOT_AN_ADMIN');
      }

      const newAdminUids = adminUids.filter(id => id !== memberId);
      const curMembers = Array.isArray(suite.members) ? suite.members.map(m => {
        if (m.uid === memberId) return { ...m, role: 'MEMBER', isAdmin: false };
        return m;
      }) : [];
      const updates = {
        adminUids: newAdminUids,
        updatedAt: new Date().toISOString(),
      };
      if (curMembers.length > 0) updates.members = curMembers;
      transaction.update(suiteRef, updates);

      return { ...suite, adminUids: newAdminUids, members: curMembers };
    });

    try {
      const inviteController = require('../controllers/inviteController');
      if (typeof inviteController.broadcastMembers === 'function' && updatedSuite.members && updatedSuite.members.length) {
        inviteController.broadcastMembers(suiteId, updatedSuite.members);
      }
    } catch (_) {}

    return res.json({
      success: true,
      message: 'Admin demoted to member.',
      adminCount: updatedSuite.adminUids.length,
      adminLimit: updatedSuite.adminLimit || 3,
    });
  } catch (err) {
    if (err.message === 'NOT_FOUND') return res.status(404).json({ success: false, error: 'Suite not found.' });
    if (err.message === 'FORBIDDEN_HOST_ONLY') return res.status(403).json({ success: false, error: 'Only the suite host can demote admins.' });
    if (err.message === 'NOT_AN_ADMIN') return res.status(400).json({ success: false, error: 'Member is not an admin.' });

    console.error('[suite] demote error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/* ══════════════════════════════════════════════════════════════
   PRIVATE SUITE JOIN REQUESTS:
   POST /api/suite/:suiteId/join-requests          – Request to join
   GET  /api/suite/:suiteId/join-requests          – List pending requests
   POST /api/suite/:suiteId/join-requests/:reqId/approve – Approve request
   POST /api/suite/:suiteId/join-requests/:reqId/reject  – Reject request
   ══════════════════════════════════════════════════════════════ */

/** Create join request (requester initiates) */
router.post('/suite/:suiteId/join-requests', requireAuth, async (req, res) => {
  const { suiteId } = req.params;
  const callerUid = getCallerUid(req);
  if (!callerUid) return res.status(401).json({ success: false, error: 'Authentication required.' });

  try {
    const suiteSnap = await db.collection('suites').doc(suiteId).get();
    if (!suiteSnap.exists) return res.status(404).json({ success: false, error: 'Suite not found.' });

    const suite = suiteSnap.data();
    const memberUids = Array.isArray(suite.memberUids) ? suite.memberUids : [];
    if (memberUids.includes(callerUid) || suite.ownerUid === callerUid) {
      return res.status(409).json({ success: false, error: 'You are already a member of this suite.' });
    }

    // Check existing pending request
    const existingSnap = await db.collection('suites').doc(suiteId)
      .collection('joinRequests')
      .where('requesterUid', '==', callerUid)
      .where('status', '==', 'pending')
      .get();

    if (!existingSnap.empty) {
      return res.status(409).json({ success: false, error: 'A join request is already pending for this suite.' });
    }

    // Fetch requester info
    let userName = 'User';
    let userUsername = '';
    try {
      const uSnap = await db.collection('users').doc(callerUid).get();
      if (uSnap.exists) {
        userName = uSnap.data().name || 'User';
        userUsername = uSnap.data().username || '';
      }
    } catch (_) {}

    const reqData = {
      suiteId,
      requesterUid: callerUid,
      targetUid: callerUid,
      requesterName: userName,
      requesterUsername: userUsername,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    const ref = await db.collection('suites').doc(suiteId).collection('joinRequests').add(reqData);

    // Notify Host and Admins
    const notifyUids = [suite.ownerUid, ...(suite.adminUids || [])].filter(Boolean);
    for (const nUid of notifyUids) {
      try {
        await db.collection('notifications').doc(nUid).collection('items').add({
          type: 'join_request',
          title: 'New Join Request',
          body: `${userName} wants to join "${suite.name}"`,
          icon: '👥',
          data: { suiteId, requestId: ref.id, requesterUid: callerUid },
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          read: false,
        });
      } catch (_) {}
    }

    return res.status(201).json({ success: true, message: 'Join request submitted.', requestId: ref.id });
  } catch (err) {
    console.error('[suite] create join request error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/** List pending join requests (Host and Admins only) */
router.get('/suite/:suiteId/join-requests', requireAuth, async (req, res) => {
  const { suiteId } = req.params;
  const callerUid = getCallerUid(req);
  if (!callerUid) return res.status(401).json({ success: false, error: 'Authentication required.' });

  try {
    const suiteSnap = await db.collection('suites').doc(suiteId).get();
    if (!suiteSnap.exists) return res.status(404).json({ success: false, error: 'Suite not found.' });

    const suite = suiteSnap.data();
    const isHost = suite.ownerUid === callerUid;
    const isAdmin = Array.isArray(suite.adminUids) && suite.adminUids.includes(callerUid);

    if (!isHost && !isAdmin) {
      return res.status(403).json({ success: false, error: 'Only the host or admins can view join requests.' });
    }

    const snap = await db.collection('suites').doc(suiteId)
      .collection('joinRequests')
      .where('status', '==', 'pending')
      .get();

    const requests = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    return res.json({ success: true, requests });
  } catch (err) {
    console.error('[suite] list join requests error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/** Approve join request (Host and Admins only) */
router.post('/suite/:suiteId/join-requests/:requestId/approve', requireAuth, async (req, res) => {
  const { suiteId, requestId } = req.params;
  const callerUid = getCallerUid(req);
  if (!callerUid) return res.status(401).json({ success: false, error: 'Authentication required.' });

  try {
    const suiteRef = db.collection('suites').doc(suiteId);
    const reqRef   = suiteRef.collection('joinRequests').doc(requestId);

    let newMemberObj = null;
    let newMembersList = [];

    await db.runTransaction(async (transaction) => {
      const suiteSnap = await transaction.get(suiteRef);
      if (!suiteSnap.exists) throw new Error('SUITE_NOT_FOUND');

      const reqSnap = await transaction.get(reqRef);
      if (!reqSnap.exists) throw new Error('REQUEST_NOT_FOUND');

      const suite = suiteSnap.data();
      const isHost = suite.ownerUid === callerUid;
      const isAdmin = Array.isArray(suite.adminUids) && suite.adminUids.includes(callerUid);

      if (!isHost && !isAdmin) {
        throw new Error('FORBIDDEN_APPROVAL');
      }

      const requestData = reqSnap.data();
      if (requestData.status !== 'pending') {
        throw new Error('ALREADY_PROCESSED');
      }

      const targetUid = requestData.requesterUid || requestData.targetUid;
      const memberUids = Array.isArray(suite.memberUids) ? suite.memberUids : [];
      let members = Array.isArray(suite.members) ? [...suite.members] : [];

      if (!memberUids.includes(targetUid)) {
        memberUids.push(targetUid);
        newMemberObj = {
          uid: targetUid,
          name: requestData.requesterName || 'Member',
          username: requestData.requesterUsername || '',
          isHost: false,
          role: 'MEMBER',
          joinedAt: new Date().toISOString(),
        };
        members.push(newMemberObj);
        newMembersList = members;
      }

      transaction.update(reqRef, {
        status: 'approved',
        processedBy: callerUid,
        processedAt: new Date().toISOString(),
      });

      transaction.update(suiteRef, {
        memberUids,
        members,
        updatedAt: new Date().toISOString(),
      });
    });

    // Broadcast new members via SSE
    try {
      const inviteController = require('../controllers/inviteController');
      if (typeof inviteController.broadcastMembers === 'function') {
        inviteController.broadcastMembers(suiteId, newMembersList);
      }
    } catch (_) {}

    return res.json({ success: true, message: 'Join request approved.' });
  } catch (err) {
    if (err.message === 'SUITE_NOT_FOUND') return res.status(404).json({ success: false, error: 'Suite not found.' });
    if (err.message === 'REQUEST_NOT_FOUND') return res.status(404).json({ success: false, error: 'Join request not found.' });
    if (err.message === 'FORBIDDEN_APPROVAL') return res.status(403).json({ success: false, error: 'Only the host or admins can approve join requests.' });
    if (err.message === 'ALREADY_PROCESSED') return res.status(400).json({ success: false, error: 'Join request has already been processed.' });

    console.error('[suite] approve request error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/** Reject join request (Host and Admins only) */
router.post('/suite/:suiteId/join-requests/:requestId/reject', requireAuth, async (req, res) => {
  const { suiteId, requestId } = req.params;
  const callerUid = getCallerUid(req);
  if (!callerUid) return res.status(401).json({ success: false, error: 'Authentication required.' });

  try {
    const suiteRef = db.collection('suites').doc(suiteId);
    const reqRef   = suiteRef.collection('joinRequests').doc(requestId);

    await db.runTransaction(async (transaction) => {
      const suiteSnap = await transaction.get(suiteRef);
      if (!suiteSnap.exists) throw new Error('SUITE_NOT_FOUND');

      const reqSnap = await transaction.get(reqRef);
      if (!reqSnap.exists) throw new Error('REQUEST_NOT_FOUND');

      const suite = suiteSnap.data();
      const isHost = suite.ownerUid === callerUid;
      const isAdmin = Array.isArray(suite.adminUids) && suite.adminUids.includes(callerUid);

      if (!isHost && !isAdmin) {
        throw new Error('FORBIDDEN_REJECTION');
      }

      const requestData = reqSnap.data();
      if (requestData.status !== 'pending') {
        throw new Error('ALREADY_PROCESSED');
      }

      transaction.update(reqRef, {
        status: 'rejected',
        processedBy: callerUid,
        processedAt: new Date().toISOString(),
      });
    });

    return res.json({ success: true, message: 'Join request rejected.' });
  } catch (err) {
    if (err.message === 'SUITE_NOT_FOUND') return res.status(404).json({ success: false, error: 'Suite not found.' });
    if (err.message === 'REQUEST_NOT_FOUND') return res.status(404).json({ success: false, error: 'Join request not found.' });
    if (err.message === 'FORBIDDEN_REJECTION') return res.status(403).json({ success: false, error: 'Only the host or admins can reject join requests.' });
    if (err.message === 'ALREADY_PROCESSED') return res.status(400).json({ success: false, error: 'Join request has already been processed.' });

    console.error('[suite] reject request error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/* ══════════════════════════════════════════════════════════════
   POST /api/suite/:suiteId/screen-share  – Update screen-share state
   ══════════════════════════════════════════════════════════════ */
router.post('/suite/:suiteId/screen-share', requireAuth, async (req, res) => {
  const { suiteId }                          = req.params;
  const { presenterUid, presenterName, action } = req.body;
  const callerUid = getCallerUid(req);

  if (!callerUid) return res.status(401).json({ success: false, error: 'Authentication required.' });
  if (!suiteId)   return res.status(400).json({ success: false, error: 'Suite ID required.' });

  try {
    const docRef = db.collection('screenSharing').doc(suiteId);

    if (action === 'start') {
      await docRef.set({
        isSharing:     true,
        presenterUid:  presenterUid || callerUid,
        presenterName: presenterName || 'User',
        startedAt:     admin.firestore.FieldValue.serverTimestamp(),
        suiteId,
      });
    } else if (action === 'stop') {
      await docRef.delete();
    } else {
      return res.status(400).json({ success: false, error: 'Action must be "start" or "stop".' });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('[suite] POST /screen-share error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

module.exports = router;
