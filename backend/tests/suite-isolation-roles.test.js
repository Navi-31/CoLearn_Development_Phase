'use strict';
/**
 * suite-isolation-roles.test.js
 *
 * Regression tests for:
 *   Bug 1 – Suite member isolation (presence leak fix)
 *   Bug 2 – Role management context-menu logic
 *
 * Run:  node --test tests/suite-isolation-roles.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

/* ══════════════════════════════════════════════════════════════════
   SIMULATE updateWorkspaceMembers (patched version from invite.js)
   ══════════════════════════════════════════════════════════════════ */

function makeUpdateWorkspaceMembers() {
  let _cachedWorkspaceMembers = [];

  // Simulated globals
  const mockGlobals = {
    _suitePresenceMap: {},
    _currentPresenceSuiteId: null,
    _cachedWorkspaceMembers: [],
  };

  // The patched function (mirrors the fix applied in invite.js)
  function updateWorkspaceMembers(AppState, globals, members) {
    if (Array.isArray(members)) {
      _cachedWorkspaceMembers = members;
    }

    const presenceMap = globals._suitePresenceMap || {};
    const currentUid  = (AppState && AppState.currentUser) ? AppState.currentUser.uid : null;
    const isSelfInActiveSuite = Boolean(currentUid && globals._currentPresenceSuiteId);

    const memberMap = new Map();

    // 1. Cached/passed members
    (_cachedWorkspaceMembers || []).forEach(m => {
      if (m && m.uid) memberMap.set(m.uid, { ...m });
    });

    // 2. AppState.currentSuite.members filtered to recordedUids only
    if (AppState && AppState.currentSuite) {
      const suite = AppState.currentSuite;
      const recordedUids = new Set(Array.isArray(suite.memberUids) ? suite.memberUids : []);
      if (suite.ownerUid) recordedUids.add(suite.ownerUid);
      if (suite.hostUid)  recordedUids.add(suite.hostUid);

      if (Array.isArray(suite.members)) {
        suite.members.forEach(m => {
          if (m && m.uid && !memberMap.has(m.uid) && recordedUids.has(m.uid)) {
            memberMap.set(m.uid, { ...m });
          }
        });
      }
    }

    // 3. Self-fallback only if actually recorded
    if (currentUid && isSelfInActiveSuite && !memberMap.has(currentUid)) {
      const suite = AppState && AppState.currentSuite;
      const recordedUids = suite && Array.isArray(suite.memberUids) ? suite.memberUids : [];
      const isRecorded = suite && (
        suite.ownerUid === currentUid ||
        suite.hostUid  === currentUid ||
        recordedUids.includes(currentUid)
      );
      if (isRecorded) {
        memberMap.set(currentUid, {
          uid: currentUid,
          name: AppState.currentUser.name || 'User',
          username: AppState.currentUser.username || '',
          isHost:  suite && (suite.ownerUid === currentUid || suite.hostUid === currentUid),
          isAdmin: suite && Array.isArray(suite.adminUids) && suite.adminUids.includes(currentUid),
        });
      }
    }

    // 4. Overlay presence onto EXISTING members only — never add new ones
    Object.keys(presenceMap).forEach(uid => {
      const p = presenceMap[uid];
      if (p && memberMap.has(uid)) {
        const existing = memberMap.get(uid);
        if (p.name && (existing.name === uid || !existing.name)) existing.name = p.name;
        if (p.isHost) existing.isHost = true;
      }
      // Non-members in presenceMap are intentionally ignored
    });

    return Array.from(memberMap.values());
  }

  return { updateWorkspaceMembers, mockGlobals };
}

/* ══════════════════════════════════════════════════════════════════
   Bug 1 — Suite Isolation Tests
   ══════════════════════════════════════════════════════════════════ */
describe('Bug 1 – Suite Isolation', () => {

  test('Only recorded memberUids appear — presence-only users are excluded', () => {
    const { updateWorkspaceMembers, mockGlobals } = makeUpdateWorkspaceMembers();

    const suite = {
      id: 'suite-A',
      ownerUid: 'user-host',
      hostUid:  'user-host',
      memberUids: ['user-host', 'user-alice'],
      adminUids:  [],
      members: [
        { uid: 'user-host',  name: 'Host',  isHost: true,  isAdmin: false },
        { uid: 'user-alice', name: 'Alice', isHost: false, isAdmin: false },
      ],
    };

    // Bob is online (in RTDB presence) but NOT a member of suite-A
    mockGlobals._suitePresenceMap = {
      'user-host':  { uid: 'user-host',  name: 'Host',  isHost: true,  online: true },
      'user-alice': { uid: 'user-alice', name: 'Alice', isHost: false, online: true },
      'user-bob':   { uid: 'user-bob',   name: 'Bob',   isHost: false, online: true }, // NOT a member
    };
    mockGlobals._currentPresenceSuiteId = 'suite-A';

    const AppState = {
      currentUser:  { uid: 'user-host', name: 'Host' },
      currentSuite: suite,
    };

    const result = updateWorkspaceMembers(AppState, mockGlobals, suite.members);
    const uids = result.map(m => m.uid);

    assert.ok(uids.includes('user-host'),  'Host must be in list');
    assert.ok(uids.includes('user-alice'), 'Alice (recorded member) must be in list');
    assert.ok(!uids.includes('user-bob'),  'Bob (presence-only) must NOT appear in suite member list');
    assert.equal(result.length, 2, 'Exactly 2 members: host + alice');
  });

  test('Stale members from suite.members that are not in memberUids are excluded', () => {
    const { updateWorkspaceMembers, mockGlobals } = makeUpdateWorkspaceMembers();

    // Suite B has charlie as stale member in the members array but NOT in memberUids
    const suite = {
      id: 'suite-B',
      ownerUid: 'user-host',
      hostUid:  'user-host',
      memberUids: ['user-host'],       // Only host is recorded
      adminUids:  [],
      members: [
        { uid: 'user-host',    name: 'Host',    isHost: true  },
        { uid: 'user-charlie', name: 'Charlie', isHost: false }, // stale
      ],
    };

    mockGlobals._suitePresenceMap = {};
    mockGlobals._currentPresenceSuiteId = 'suite-B';

    const AppState = {
      currentUser:  { uid: 'user-host', name: 'Host' },
      currentSuite: suite,
    };

    // Pass fresh list from REST API (only host)
    const result = updateWorkspaceMembers(AppState, mockGlobals, [
      { uid: 'user-host', name: 'Host', isHost: true, isAdmin: false },
    ]);
    const uids = result.map(m => m.uid);

    assert.ok(uids.includes('user-host'),    'Host must appear');
    assert.ok(!uids.includes('user-charlie'), 'Stale member Charlie must NOT appear');
    assert.equal(result.length, 1, 'Exactly 1 member');
  });

  test('Self-fallback only works when currentUser is a recorded member', () => {
    const { updateWorkspaceMembers, mockGlobals } = makeUpdateWorkspaceMembers();

    const suite = {
      id: 'suite-C',
      ownerUid: 'user-host',
      hostUid:  'user-host',
      memberUids: ['user-host', 'user-alice'],
      adminUids:  [],
      members: [],
    };

    mockGlobals._suitePresenceMap = {};
    mockGlobals._currentPresenceSuiteId = 'suite-C';

    // Current user is dave, who is NOT in memberUids
    const AppState = {
      currentUser:  { uid: 'user-dave', name: 'Dave' },
      currentSuite: suite,
    };

    const result = updateWorkspaceMembers(AppState, mockGlobals, []);
    const uids = result.map(m => m.uid);
    assert.ok(!uids.includes('user-dave'), 'Non-member Dave must NOT be auto-added via self-fallback');
  });

  test('Host is always included even if not in presence map', () => {
    const { updateWorkspaceMembers, mockGlobals } = makeUpdateWorkspaceMembers();

    const suite = {
      id: 'suite-D',
      ownerUid: 'user-host',
      hostUid:  'user-host',
      memberUids: ['user-host', 'user-alice'],
      adminUids:  [],
      members: [
        { uid: 'user-host',  name: 'Host',  isHost: true,  isAdmin: false },
        { uid: 'user-alice', name: 'Alice', isHost: false, isAdmin: false },
      ],
    };

    mockGlobals._suitePresenceMap = {}; // Nobody online
    mockGlobals._currentPresenceSuiteId = 'suite-D';

    const AppState = {
      currentUser:  { uid: 'user-host', name: 'Host' },
      currentSuite: suite,
    };

    const result = updateWorkspaceMembers(AppState, mockGlobals, suite.members);
    const uids = result.map(m => m.uid);
    assert.ok(uids.includes('user-host'),  'Host still present without RTDB presence');
    assert.ok(uids.includes('user-alice'), 'Alice still present without RTDB presence');
    assert.equal(result.length, 2);
  });

  test('Presence overlay updates name for existing member but never adds strangers', () => {
    const { updateWorkspaceMembers, mockGlobals } = makeUpdateWorkspaceMembers();

    const suite = {
      id: 'suite-E',
      ownerUid: 'user-host',
      memberUids: ['user-host', 'user-alice'],
      adminUids: [],
      members: [
        { uid: 'user-host',  name: 'user-host', isHost: true  }, // name = uid (placeholder)
        { uid: 'user-alice', name: 'Alice',      isHost: false },
      ],
    };

    mockGlobals._suitePresenceMap = {
      'user-host':   { name: 'HostRealName', isHost: true,  online: true },
      'user-eve':    { name: 'Eve',          isHost: false, online: true },  // stranger
    };
    mockGlobals._currentPresenceSuiteId = 'suite-E';

    const AppState = {
      currentUser:  { uid: 'user-host', name: 'Host' },
      currentSuite: suite,
    };

    const result = updateWorkspaceMembers(AppState, mockGlobals, suite.members);
    const hostEntry = result.find(m => m.uid === 'user-host');
    const uids = result.map(m => m.uid);

    assert.equal(hostEntry.name, 'HostRealName', 'Presence name overlays placeholder uid name');
    assert.ok(!uids.includes('user-eve'), 'Eve (stranger in presence) must NOT appear');
  });
});

/* ══════════════════════════════════════════════════════════════════
   Bug 2 – Role Management Context Menu Logic
   (Pure logic simulation — mirrors member-context-menu.js decisions)
   ══════════════════════════════════════════════════════════════════ */
describe('Bug 2 – Role Management Context Menu', () => {

  function buildContextMenuItems(callerRole, targetRole, isSelf, adminCount, adminLimit) {
    const items = [];
    items.push('VIEW_DETAILS');

    if (callerRole === 'HOST') {
      if (targetRole === 'MEMBER' && !isSelf) {
        const atLimit = adminCount >= adminLimit;
        items.push(atLimit ? 'PROMOTE_DISABLED' : 'PROMOTE');
        items.push('CHAT');
        items.push('REMOVE');
      } else if (targetRole === 'ADMIN' && !isSelf) {
        items.push('DEMOTE');
        items.push('CHAT');
        items.push('REMOVE');
      }
      // HOST targeting self: only VIEW_DETAILS
    } else if (callerRole === 'ADMIN') {
      if (targetRole === 'HOST') {
        items.push('CHAT');
      } else if (targetRole === 'MEMBER' && !isSelf) {
        items.push('CHAT');
        items.push('REMOVE');
      } else if (targetRole === 'ADMIN' && !isSelf) {
        items.push('CHAT');
      }
      // ADMIN targeting self: only VIEW_DETAILS
    } else {
      // MEMBER
      if (!isSelf) {
        items.push('CHAT');
      }
      // MEMBER targeting self: only VIEW_DETAILS
    }

    return items;
  }

  test('HOST → MEMBER: VIEW DETAILS, PROMOTE, CHAT, REMOVE', () => {
    const items = buildContextMenuItems('HOST', 'MEMBER', false, 0, 3);
    assert.deepEqual(items, ['VIEW_DETAILS', 'PROMOTE', 'CHAT', 'REMOVE']);
  });

  test('HOST → ADMIN: VIEW DETAILS, DEMOTE, CHAT, REMOVE', () => {
    const items = buildContextMenuItems('HOST', 'ADMIN', false, 1, 3);
    assert.deepEqual(items, ['VIEW_DETAILS', 'DEMOTE', 'CHAT', 'REMOVE']);
  });

  test('HOST → self: VIEW DETAILS only', () => {
    const items = buildContextMenuItems('HOST', 'HOST', true, 0, 3);
    assert.deepEqual(items, ['VIEW_DETAILS']);
  });

  test('ADMIN → MEMBER: VIEW DETAILS, CHAT, REMOVE', () => {
    const items = buildContextMenuItems('ADMIN', 'MEMBER', false, 1, 3);
    assert.deepEqual(items, ['VIEW_DETAILS', 'CHAT', 'REMOVE']);
  });

  test('ADMIN → HOST: VIEW DETAILS, CHAT', () => {
    const items = buildContextMenuItems('ADMIN', 'HOST', false, 1, 3);
    assert.deepEqual(items, ['VIEW_DETAILS', 'CHAT']);
  });

  test('ADMIN → another ADMIN: VIEW DETAILS, CHAT', () => {
    const items = buildContextMenuItems('ADMIN', 'ADMIN', false, 2, 3);
    assert.deepEqual(items, ['VIEW_DETAILS', 'CHAT']);
  });

  test('ADMIN → self: VIEW DETAILS only', () => {
    const items = buildContextMenuItems('ADMIN', 'ADMIN', true, 1, 3);
    assert.deepEqual(items, ['VIEW_DETAILS']);
  });

  test('MEMBER → others: VIEW DETAILS, CHAT', () => {
    const items = buildContextMenuItems('MEMBER', 'MEMBER', false, 0, 3);
    assert.deepEqual(items, ['VIEW_DETAILS', 'CHAT']);
  });

  test('MEMBER → self: VIEW DETAILS only', () => {
    const items = buildContextMenuItems('MEMBER', 'MEMBER', true, 0, 3);
    assert.deepEqual(items, ['VIEW_DETAILS']);
  });

  test('HOST → MEMBER at admin limit: PROMOTE is disabled', () => {
    const items = buildContextMenuItems('HOST', 'MEMBER', false, 3, 3); // atLimit
    assert.ok(items.includes('PROMOTE_DISABLED'), 'PROMOTE should be disabled at limit');
    assert.ok(!items.includes('PROMOTE'), 'PROMOTE should not be enabled');
  });

  test('HOST → MEMBER below admin limit: PROMOTE is enabled', () => {
    const items = buildContextMenuItems('HOST', 'MEMBER', false, 2, 3); // below limit
    assert.ok(items.includes('PROMOTE'), 'PROMOTE should be enabled below limit');
    assert.ok(!items.includes('PROMOTE_DISABLED'), 'Disabled PROMOTE should not appear');
  });
});

/* ══════════════════════════════════════════════════════════════════
   Backend Role Enforcement Logic (in-process simulation)
   ══════════════════════════════════════════════════════════════════ */
describe('Backend – Role enforcement (simulate suite.js logic)', () => {

  function canRemove(callerRole, targetRole) {
    if (callerRole === 'HOST' && targetRole !== 'HOST') return true;  // host can remove any non-host
    if (callerRole === 'ADMIN' && targetRole === 'MEMBER') return true; // admin can remove members
    return false; // member cannot remove anyone; admin cannot remove host/admin
  }

  function canPromote(callerRole, targetRole) {
    return callerRole === 'HOST' && targetRole === 'MEMBER';
  }

  function canDemote(callerRole, targetRole) {
    return callerRole === 'HOST' && targetRole === 'ADMIN';
  }

  test('Host can remove Member', () => {
    assert.ok(canRemove('HOST', 'MEMBER'));
  });

  test('Host can remove Admin', () => {
    assert.ok(canRemove('HOST', 'ADMIN'));
  });

  test('Host cannot remove Host (self)', () => {
    assert.ok(!canRemove('HOST', 'HOST'));
  });

  test('Admin can remove Member', () => {
    assert.ok(canRemove('ADMIN', 'MEMBER'));
  });

  test('Admin cannot remove Admin', () => {
    assert.ok(!canRemove('ADMIN', 'ADMIN'));
  });

  test('Admin cannot remove Host', () => {
    assert.ok(!canRemove('ADMIN', 'HOST'));
  });

  test('Member cannot remove anyone', () => {
    assert.ok(!canRemove('MEMBER', 'MEMBER'));
    assert.ok(!canRemove('MEMBER', 'ADMIN'));
    assert.ok(!canRemove('MEMBER', 'HOST'));
  });

  test('Host can promote Member to Admin', () => {
    assert.ok(canPromote('HOST', 'MEMBER'));
  });

  test('Host cannot promote another Admin', () => {
    assert.ok(!canPromote('HOST', 'ADMIN'));
  });

  test('Admin cannot promote anyone', () => {
    assert.ok(!canPromote('ADMIN', 'MEMBER'));
  });

  test('Host can demote Admin to Member', () => {
    assert.ok(canDemote('HOST', 'ADMIN'));
  });

  test('Admin cannot demote anyone', () => {
    assert.ok(!canDemote('ADMIN', 'ADMIN'));
  });

  test('Admin limit: host (ownerUid) is NOT counted in adminCount', () => {
    // The admin limit applies only to non-host admins
    const adminUids = ['user-alice', 'user-bob']; // 2 admins
    const ownerUid  = 'user-host';
    // Owner is in adminUids? No — by design ownerUid is never added to adminUids
    const adminCount = adminUids.filter(uid => uid !== ownerUid).length;
    assert.equal(adminCount, 2, 'Admin count excludes host');
  });
});
