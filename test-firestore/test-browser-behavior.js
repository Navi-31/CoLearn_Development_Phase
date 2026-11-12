const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const assert = require('assert');

function runBrowserBehaviorTest() {
  console.log('--- Testing Actual Browser DOM & JS Behavior ---');

  const html = fs.readFileSync(path.resolve(__dirname, '../frontend/index.html'), 'utf8');

  const dom = new JSDOM(html, {
    url: 'http://localhost:3000',
    runScripts: 'dangerously',
    // no external fetch
  });

  const window = dom.window;
  const document = window.document;

  // Polyfills & mocks for window environment
  window.CONFIG = { API_BASE: 'http://localhost:3000' };
  window.showToast = (id, msg) => { /* no-op */ };
  window.openModal = (id) => { const el = document.getElementById(id); if (el) el.classList.remove('hidden'); };
  window.closeModal = (id) => { const el = document.getElementById(id); if (el) el.classList.add('hidden'); };
  window.escapeHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };

  // Load scripts into the JSDOM context
  const stateCode = fs.readFileSync(path.resolve(__dirname, '../frontend/js/state.js'), 'utf8');
  const utilsCode = fs.readFileSync(path.resolve(__dirname, '../frontend/js/utils.js'), 'utf8');
  const inviteCode = fs.readFileSync(path.resolve(__dirname, '../frontend/js/invite.js'), 'utf8');
  const menuCode = fs.readFileSync(path.resolve(__dirname, '../frontend/js/member-context-menu.js'), 'utf8');

  window.eval(stateCode + "; window.AppState = AppState;");
  window.eval(utilsCode);
  window.eval(inviteCode);
  window.eval(menuCode);
  const workspaceCode = fs.readFileSync(path.resolve(__dirname, '../frontend/js/views/workspace.js'), 'utf8');
  window.eval(workspaceCode);


  window.initMemberContextMenu();

  console.log('✓ Frontend JS loaded into JSDOM environment');

  // ==========================================
  // TEST BUG 1: SUITE ISOLATION IN THE DOM
  // ==========================================
  console.log('\n--- Bug 1: Testing Suite Isolation in Sidebar DOM ---');
  window.AppState.currentUser = { uid: 'uid_host', name: 'Host User' };
  window.AppState.currentSuite = {
    id: 'suite_1',
    ownerUid: 'uid_host',
    hostUid: 'uid_host',
    memberUids: ['uid_host', 'uid_alice'],
    adminUids: [],
    adminLimit: 3,
    members: [
      { uid: 'uid_host', name: 'Host User', isHost: true, isAdmin: false },
      { uid: 'uid_alice', name: 'Alice', isHost: false, isAdmin: false }
    ]
  };
  window._currentPresenceSuiteId = 'suite_1';

  // Stranger Bob is in RTDB presence but NOT in memberUids
  window._suitePresenceMap = {
    'uid_host': { uid: 'uid_host', name: 'Host User', isHost: true, online: true },
    'uid_alice': { uid: 'uid_alice', name: 'Alice', isHost: false, online: true },
    'uid_bob_stranger': { uid: 'uid_bob_stranger', name: 'Bob Stranger', isHost: false, online: true }
  };

  // Render members
  window.updateWorkspaceMembers(window.AppState.currentSuite.members);

  const sidebarCards = document.querySelectorAll('#sidebar-members-list .member-card');
  const renderedUids = Array.from(sidebarCards).map(card => card.getAttribute('data-uid'));
  console.log('Rendered member UIDs in sidebar:', renderedUids);

  assert.strictEqual(renderedUids.includes('uid_host'), true, 'Host must be rendered');
  assert.strictEqual(renderedUids.includes('uid_alice'), true, 'Alice must be rendered');
  assert.strictEqual(renderedUids.includes('uid_bob_stranger'), false, 'Bob Stranger must NOT be rendered');
  console.log('[PASS] Bug 1: Stranger presence does not leak into Suite 1 sidebar DOM');

  // Switch to Suite 2 — verify cleanup prevents bleed
  window.cleanupSuitePresence();
  window.AppState.currentSuite = {
    id: 'suite_2',
    ownerUid: 'uid_host',
    hostUid: 'uid_host',
    memberUids: ['uid_host', 'uid_charlie'],
    adminUids: [],
    adminLimit: 3,
    members: [
      { uid: 'uid_host', name: 'Host User', isHost: true, isAdmin: false },
      { uid: 'uid_charlie', name: 'Charlie', isHost: false, isAdmin: false }
    ]
  };
  window._currentPresenceSuiteId = 'suite_2';
  window.updateWorkspaceMembers(window.AppState.currentSuite.members);

  const suite2Cards = document.querySelectorAll('#sidebar-members-list .member-card');
  const suite2Uids = Array.from(suite2Cards).map(card => card.getAttribute('data-uid'));
  console.log('Suite 2 rendered UIDs:', suite2Uids);
  assert.strictEqual(suite2Uids.includes('uid_alice'), false, 'Alice from Suite 1 must NOT appear in Suite 2');
  assert.strictEqual(suite2Uids.includes('uid_charlie'), true, 'Charlie must appear in Suite 2');
  console.log('[PASS] Bug 1: Suite 1 members do not bleed into Suite 2 sidebar DOM');

  // ==========================================
  // TEST BUG 2: ROLE MANAGEMENT CONTEXT MENU
  // ==========================================
  console.log('\n--- Bug 2: Testing Context Menu Combinations in DOM ---');

  const menuEl = document.getElementById('member-context-menu');

  function getMenuButtons() {
    return Array.from(menuEl.querySelectorAll('button.ctx-item, div.ctx-item')).map(el => {
      // Return label text (without small badge explanation)
      const clone = el.cloneNode(true);
      const small = clone.querySelector('small');
      if (small) small.remove();
      return clone.textContent.trim();
    });
  }

  // Set up suite with Host, Admin Bob, Member Charlie
  window.AppState.currentSuite = {
    id: 'suite_roles',
    ownerUid: 'uid_host',
    hostUid: 'uid_host',
    memberUids: ['uid_host', 'uid_admin_bob', 'uid_member_charlie'],
    adminUids: ['uid_admin_bob'],
    adminLimit: 3,
    members: [
      { uid: 'uid_host', name: 'Host', isHost: true, isAdmin: false },
      { uid: 'uid_admin_bob', name: 'Bob Admin', isHost: false, isAdmin: true },
      { uid: 'uid_member_charlie', name: 'Charlie Member', isHost: false, isAdmin: false }
    ]
  };
  window.updateWorkspaceMembers(window.AppState.currentSuite.members);

  // 1. HOST -> MEMBER (Charlie)
  window.AppState.currentUser = { uid: 'uid_host', name: 'Host' };
  window.showMemberContextMenu({ clientX: 100, clientY: 100 }, 'uid_member_charlie', 'Charlie Member');
  let buttons = getMenuButtons();
  console.log('HOST -> MEMBER buttons:', buttons);
  assert.deepStrictEqual(buttons, ['👁️ VIEW DETAILS', '🛡️ PROMOTE', '💬 CHAT', '🚫 REMOVE']);
  console.log('[PASS] HOST -> MEMBER: View Details, Promote, Chat, Remove');

  // 2. HOST -> ADMIN (Bob)
  window.showMemberContextMenu({ clientX: 100, clientY: 100 }, 'uid_admin_bob', 'Bob Admin');
  buttons = getMenuButtons();
  console.log('HOST -> ADMIN buttons:', buttons);
  assert.deepStrictEqual(buttons, ['👁️ VIEW DETAILS', '⏬ DEMOTE', '💬 CHAT', '🚫 REMOVE']);
  console.log('[PASS] HOST -> ADMIN: View Details, Demote, Chat, Remove');

  // 3. HOST -> self (Host)
  window.showMemberContextMenu({ clientX: 100, clientY: 100 }, 'uid_host', 'Host');
  buttons = getMenuButtons();
  console.log('HOST -> self buttons:', buttons);
  assert.deepStrictEqual(buttons, ['👁️ VIEW DETAILS', '(That\'s you)']);
  console.log('[PASS] HOST -> self: View Details');

  // 4. ADMIN (Bob) -> MEMBER (Charlie)
  window.AppState.currentUser = { uid: 'uid_admin_bob', name: 'Bob Admin' };
  window.showMemberContextMenu({ clientX: 100, clientY: 100 }, 'uid_member_charlie', 'Charlie Member');
  buttons = getMenuButtons();
  console.log('ADMIN -> MEMBER buttons:', buttons);
  assert.deepStrictEqual(buttons, ['👁️ VIEW DETAILS', '💬 CHAT', '🚫 REMOVE']);
  console.log('[PASS] ADMIN -> MEMBER: View Details, Chat, Remove');

  // 5. ADMIN (Bob) -> HOST (Host)
  window.showMemberContextMenu({ clientX: 100, clientY: 100 }, 'uid_host', 'Host');
  buttons = getMenuButtons();
  console.log('ADMIN -> HOST buttons:', buttons);
  assert.deepStrictEqual(buttons, ['👁️ VIEW DETAILS', '💬 CHAT']);
  console.log('[PASS] ADMIN -> HOST: View Details, Chat');

  // Add a second admin Dan to test ADMIN -> ADMIN
  window.AppState.currentSuite.adminUids.push('uid_admin_dan');
  window.AppState.currentSuite.memberUids.push('uid_admin_dan');
  window.AppState.currentSuite.members.push({ uid: 'uid_admin_dan', name: 'Dan Admin', isHost: false, isAdmin: true });
  window.updateWorkspaceMembers(window.AppState.currentSuite.members);

  // 6. ADMIN (Bob) -> ADMIN (Dan)
  window.showMemberContextMenu({ clientX: 100, clientY: 100 }, 'uid_admin_dan', 'Dan Admin');
  buttons = getMenuButtons();
  console.log('ADMIN -> ADMIN buttons:', buttons);
  assert.deepStrictEqual(buttons, ['👁️ VIEW DETAILS', '💬 CHAT']);
  console.log('[PASS] ADMIN -> ADMIN: View Details, Chat');

  // 7. ADMIN (Bob) -> self (Bob)
  window.showMemberContextMenu({ clientX: 100, clientY: 100 }, 'uid_admin_bob', 'Bob Admin');
  buttons = getMenuButtons();
  console.log('ADMIN -> self buttons:', buttons);
  assert.deepStrictEqual(buttons, ['👁️ VIEW DETAILS', '(That\'s you)']);
  console.log('[PASS] ADMIN -> self: View Details');

  // 8. MEMBER (Charlie) -> others (Bob Admin)
  window.AppState.currentUser = { uid: 'uid_member_charlie', name: 'Charlie Member' };
  window.showMemberContextMenu({ clientX: 100, clientY: 100 }, 'uid_admin_bob', 'Bob Admin');
  buttons = getMenuButtons();
  console.log('MEMBER -> others buttons:', buttons);
  assert.deepStrictEqual(buttons, ['👁️ VIEW DETAILS', '💬 CHAT']);
  console.log('[PASS] MEMBER -> others: View Details, Chat');

  // 9. MEMBER (Charlie) -> self (Charlie)
  window.showMemberContextMenu({ clientX: 100, clientY: 100 }, 'uid_member_charlie', 'Charlie Member');
  buttons = getMenuButtons();
  console.log('MEMBER -> self buttons:', buttons);
  assert.deepStrictEqual(buttons, ['👁️ VIEW DETAILS', '(That\'s you)']);
  console.log('[PASS] MEMBER -> self: View Details');

  // 10. Admin Limit check: HOST -> MEMBER when admin limit is reached
  window.AppState.currentUser = { uid: 'uid_host', name: 'Host' };
  window.AppState.currentSuite.adminLimit = 2; // We currently have 2 admins: Bob and Dan
  window.showMemberContextMenu({ clientX: 100, clientY: 100 }, 'uid_member_charlie', 'Charlie Member');
  const disabledItem = menuEl.querySelector('div.ctx-item[style*="not-allowed"]');
  assert.ok(disabledItem, 'Promote option must be disabled when admin limit reached');
  console.log('Disabled item text:', disabledItem.textContent.trim());
  assert.ok(disabledItem.textContent.includes('Admin limit reached'), 'Must show admin limit explanation');
  console.log('[PASS] HOST -> MEMBER: Promote is disabled when admin limit reached');

  // 11. Modal test: Confirm remove modal
  window._cmConfirmRemove('uid_member_charlie', 'Charlie Member');
  const removeModal = document.getElementById('modal-remove-member');
  const removeName = document.getElementById('remove-member-name');
  assert.strictEqual(removeModal.classList.contains('hidden'), false, 'Remove modal should be open');
  assert.strictEqual(removeName.textContent, 'Charlie Member', 'Remove modal should show member name');
  console.log('[PASS] Removal confirmation modal correctly populated and opened');

  console.log('\n🎉 ALL BROWSER BEHAVIOR AND DOM TESTS PASSED SUCCESSFULLY!');
}

runBrowserBehaviorTest();
process.exit(0);
