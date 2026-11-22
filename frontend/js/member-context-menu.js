/* ── member-context-menu.js – Right-Click Member Context Menu ────
 *
 * Public API (module-scope):
 *   initMemberContextMenu()                              – setup document listeners
 *   showMemberContextMenu(e, memberId, memberName, isHost) – show menu
 *   hideMemberContextMenu()                              – hide menu
 *   confirmRemoveMember()                                – confirm removal action
 *
 * The context menu is injected into #member-context-menu div (already in HTML).
 * A MutationObserver auto-attaches context-menu handlers to new .member-card elements.
 */
'use strict';

var _cmMenuEl       = null;
var _cmPendingRemove = null; // { memberId, memberName }

/* ══ Public: initMemberContextMenu ══════════════════════════ */
function initMemberContextMenu() {
  _cmMenuEl = document.getElementById('member-context-menu');

  /* Close on Escape */
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' || e.key === 'Esc') hideMemberContextMenu();
  });

  /* Close on click outside */
  document.addEventListener('click', function(e) {
    if (_cmMenuEl && !_cmMenuEl.classList.contains('hidden') && !_cmMenuEl.contains(e.target)) {
      hideMemberContextMenu();
    }
  });

  /* Close on window resize, navigation, or scrolling outside the menu */
  window.addEventListener('resize', hideMemberContextMenu);
  window.addEventListener('hashchange', hideMemberContextMenu);
  window.addEventListener('popstate', hideMemberContextMenu);

  /* Delegation: Right-click directly on member cards in sidebar */
  document.addEventListener('contextmenu', function(e) {
    var card = e.target.closest('.member-card[data-uid], .member-card[data-member-uid]');
    if (!card) {
      // Right-clicking outside a member entry: close menu if open, do NOT open menu
      if (_cmMenuEl && !_cmMenuEl.classList.contains('hidden') && !_cmMenuEl.contains(e.target)) {
        hideMemberContextMenu();
      }
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    var uid  = card.dataset.uid || card.dataset.memberUid;
    if (!uid) return;
    var name = card.dataset.name || card.querySelector('.member-name')?.textContent?.trim() || 'Member';
    showMemberContextMenu(e, uid, name);
  });

  /* MutationObserver: auto-attach handlers when member cards are added to sidebar */
  var sidebar = document.getElementById('sidebar-members-list');
  if (sidebar && window.MutationObserver) {
    var observer = new MutationObserver(function() {
      _patchMemberCards();
    });
    observer.observe(sidebar, { childList: true, subtree: true });
  }

  _patchMemberCards();

  console.info('[MemberContextMenu] Initialised.');
}

/* ══ Public: showMemberContextMenu ══════════════════════════ */
/* ══ Public: showMemberContextMenu ══════════════════════════ */
function showMemberContextMenu(e, memberId, memberName, isCallerHost) {
  if (e && e.preventDefault) e.preventDefault();
  if (e && e.stopPropagation) e.stopPropagation();

  if (!_cmMenuEl) _cmMenuEl = document.getElementById('member-context-menu');
  if (!_cmMenuEl) return;

  var currentUser = window.AppState && window.AppState.currentUser;
  var currentUid  = currentUser ? currentUser.uid : null;
  var suite       = window.AppState && window.AppState.currentSuite;
  var isSelf      = Boolean(currentUid && memberId === currentUid);

  // 1. Determine Current User Role: HOST, ADMIN, MEMBER
  var callerIsHost = Boolean(
    isCallerHost || (suite && currentUser && (
      suite.ownerUid === currentUser.uid ||
      suite.hostUid === currentUser.uid
    ))
  );

  var callerIsAdmin = Boolean(
    !callerIsHost && suite && currentUser && Array.isArray(suite.adminUids) && suite.adminUids.includes(currentUser.uid)
  );

  var callerRole = callerIsHost ? 'HOST' : (callerIsAdmin ? 'ADMIN' : 'MEMBER');

  // 2. Determine Target Member Role: HOST, ADMIN, MEMBER
  var cachedMembers = window._cachedWorkspaceMembers || (suite && suite.members) || [];
  var targetMember = Array.isArray(cachedMembers) ? cachedMembers.find(function(m) { return m && m.uid === memberId; }) : null;

  var targetIsHost = Boolean(
    (suite && (suite.ownerUid === memberId || suite.hostUid === memberId)) ||
    (targetMember && targetMember.isHost)
  );

  var targetIsAdmin = Boolean(
    !targetIsHost && (
      (suite && Array.isArray(suite.adminUids) && suite.adminUids.includes(memberId)) ||
      (targetMember && targetMember.isAdmin)
    )
  );

  var targetRole = targetIsHost ? 'HOST' : (targetIsAdmin ? 'ADMIN' : 'MEMBER');

  /* Menu Items Definition based on exact specifications:
   *
   * Host targeting MEMBER: VIEW DETAILS | PROMOTE | CHAT | REMOVE
   * Host targeting ADMIN:  VIEW DETAILS | DEMOTE | CHAT | REMOVE
   * Host targeting self:   VIEW DETAILS
   *
   * Admin targeting HOST:  VIEW DETAILS | CHAT
   * Admin targeting MEMBER: VIEW DETAILS | CHAT | REMOVE
   * Admin targeting ADMIN: VIEW DETAILS | CHAT (for another admin); VIEW DETAILS (for themselves)
   *
   * Member targeting anyone: VIEW DETAILS | CHAT (for others); VIEW DETAILS (for themselves)
   */

  var items = [];

  if (isSelf) {
    // Host, Admin, or Member right-clicking their own entry:
    // Do not show promotion, demotion, removal, or ownership-transfer options.
    items.push({
      label: '👁️ View Profile',
      action: function() { _cmShowMemberProfile(memberId, memberName); }
    });
  } else if (callerRole === 'HOST') {
    if (targetRole === 'MEMBER') {
      // 1. Promote to Admin
      var adminLimit = typeof suite.adminLimit === 'number' ? suite.adminLimit : 3;
      var adminCount = (suite && Array.isArray(suite.adminUids)) ? suite.adminUids.length : 0;
      var atLimit = adminCount >= adminLimit;

      if (atLimit) {
        items.push({
          label: '🛡️ Promote to Admin',
          disabled: true,
          explanation: `Admin limit reached (${adminCount}/${adminLimit}). Increase limit in Settings to promote.`
        });
      } else {
        items.push({
          label: '🛡️ Promote to Admin',
          action: function() { _cmPromoteAdmin(memberId, memberName); }
        });
      }

      // 2. Private Chat
      items.push({
        label: '💬 Private Chat',
        action: function() { _cmOpenPrivateChat(memberId, memberName); }
      });

      // 3. Remove Member
      items.push({
        label: '🚫 Remove Member',
        danger: true,
        action: function() { _cmConfirmRemove(memberId, memberName, 'MEMBER'); }
      });

    } else if (targetRole === 'ADMIN') {
      // 1. Demote to Member
      items.push({
        label: '⏬ Demote to Member',
        action: function() { _cmDemoteAdmin(memberId, memberName); }
      });

      // 2. Private Chat
      items.push({
        label: '💬 Private Chat',
        action: function() { _cmOpenPrivateChat(memberId, memberName); }
      });

      // 3. Remove Admin
      items.push({
        label: '🚫 Remove Admin',
        danger: true,
        action: function() { _cmConfirmRemove(memberId, memberName, 'ADMIN'); }
      });
    }

  } else if (callerRole === 'ADMIN') {
    if (targetRole === 'MEMBER') {
      // 1. Private Chat
      items.push({
        label: '💬 Private Chat',
        action: function() { _cmOpenPrivateChat(memberId, memberName); }
      });

      // 2. Remove Member
      items.push({
        label: '🚫 Remove Member',
        danger: true,
        action: function() { _cmConfirmRemove(memberId, memberName, 'MEMBER'); }
      });

    } else if (targetRole === 'ADMIN' || targetRole === 'HOST') {
      // Admin right-clicking another Admin or the Host: Private Chat only
      items.push({
        label: '💬 Private Chat',
        action: function() { _cmOpenPrivateChat(memberId, memberName); }
      });
    }

  } else {
    // Regular Member right-clicking any other person: Private Chat only
    items.push({
      label: '💬 Private Chat',
      action: function() { _cmOpenPrivateChat(memberId, memberName); }
    });
  }

  // Render items
  window._cmActiveActions = items;
  var html = items.map(function(item, idx) {
    if (item.disabled) {
      return `<div class="cm-btn ctx-item" style="opacity:0.5;cursor:not-allowed;display:flex;flex-direction:column;align-items:flex-start;" title="${_esc(item.explanation || '')}"><span>${item.label}</span><small style="font-size:0.65rem;color:var(--fl-text-muted);">${_esc(item.explanation || '')}</small></div>`;
    }
    var cls = 'cm-btn ctx-item' + (item.danger ? ' danger' : '');
    return `<button class="${cls}" onclick="hideMemberContextMenu();window._cmExecuteAction(${idx})">${item.label}</button>`;
  }).join('');

  if (isSelf) {
    html += '<div class="ctx-separator" style="height:1px;background:var(--border,#e2e8f0);margin:4px 0;"></div>';
    html += '<div class="cm-btn ctx-item" style="pointer-events:none;opacity:0.6;font-size:0.75rem;font-style:italic;">(That\'s you)</div>';
  }

  _cmMenuEl.innerHTML = html;
  _cmMenuEl.classList.remove('hidden');
  _cmMenuEl.classList.add('active');
  _cmMenuEl.style.display = 'flex';

  /* Position at cursor or touch position (keep within viewport) */
  var rect = _cmMenuEl.getBoundingClientRect();
  var menuW = rect.width || 210;
  var menuH = rect.height || 160;
  var clientX = (e.clientX !== undefined) ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : window.innerWidth / 2);
  var clientY = (e.clientY !== undefined) ? e.clientY : (e.touches && e.touches[0] ? e.touches[0].clientY : window.innerHeight / 2);

  var x = clientX;
  var y = clientY;
  if (x + menuW > window.innerWidth - 8)  x = Math.max(8, window.innerWidth  - menuW - 8);
  if (y + menuH > window.innerHeight - 8) y = Math.max(8, window.innerHeight - menuH - 8);
  x = Math.max(8, x);
  y = Math.max(8, y);

  _cmMenuEl.style.left = x + 'px';
  _cmMenuEl.style.top  = y + 'px';
}

window._cmExecuteAction = function(index) {
  if (window._cmActiveActions && window._cmActiveActions[index] && typeof window._cmActiveActions[index].action === 'function') {
    window._cmActiveActions[index].action();
  }
};

/* ══ Public: hideMemberContextMenu ══════════════════════════ */
function hideMemberContextMenu() {
  if (!_cmMenuEl) _cmMenuEl = document.getElementById('member-context-menu');
  if (_cmMenuEl) {
    _cmMenuEl.classList.add('hidden');
    _cmMenuEl.classList.remove('active');
    _cmMenuEl.style.display = 'none';
  }
}

/* ══ Public: confirmRemoveMember (called from modal) ════════ */
async function confirmRemoveMember() {
  if (!_cmPendingRemove) return;
  var memberId   = _cmPendingRemove.memberId;
  var memberName = _cmPendingRemove.memberName;
  _cmPendingRemove = null;

  if (typeof closeModal === 'function') closeModal('modal-remove-member');

  var suite = window.AppState && window.AppState.currentSuite;
  if (!suite || !suite.id) { showToast('main-toast', '⚠️ Suite not found.', 'dark'); return; }

  var btn = document.getElementById('btn-confirm-remove-member');
  if (btn) btn.disabled = true;

  try {
    var resp = await API.removeMember(suite.id, memberId);
    if (resp && resp.success) {
      showToast('main-toast', '✓ ' + memberName + ' removed from suite.', 'dark');
      /* Optimistically remove card from sidebar */
      var card = document.querySelector('.member-card[data-uid="' + memberId + '"]');
      if (card) {
        card.style.transition = 'opacity 0.25s';
        card.style.opacity = '0';
        setTimeout(function() { card.remove(); }, 260);
      }
      if (typeof updateWorkspaceMembers === 'function') {
        updateWorkspaceMembers();
      }
    } else {
      showToast('main-toast', '⚠️ ' + (resp.error || 'Could not remove member.'), 'dark');
    }
  } catch (err) {
    showToast('main-toast', '⚠️ Network error. Could not remove member.', 'dark');
    console.error('[MemberContextMenu] removeMember error:', err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ══ API Action Wrappers ═════════════════════════════════════ */
async function _cmPromoteAdmin(memberId, memberName) {
  if (!confirm('Promote ' + memberName + ' to Suite Admin?')) return;
  var suite = window.AppState && window.AppState.currentSuite;
  if (!suite || !suite.id) return;
  try {
    var resp = await API.promoteAdmin(suite.id, memberId);
    if (resp && resp.success) {
      showToast('main-toast', '🛡️ ' + memberName + ' promoted to Admin.', 'green');
      // Update local adminUids immediately for context-menu role detection
      if (!Array.isArray(suite.adminUids)) suite.adminUids = [];
      if (!suite.adminUids.includes(memberId)) suite.adminUids.push(memberId);
      // Update resp.adminCount on suite for limit display
      if (resp.adminCount !== undefined) suite.adminCount = resp.adminCount;
      if (resp.adminLimit !== undefined) suite.adminLimit = resp.adminLimit;
      // Re-fetch authoritative member list from backend to refresh role badges
      if (typeof API !== 'undefined' && typeof API.getSuiteMembers === 'function') {
        try {
          var memRes = await API.getSuiteMembers(suite.id);
          if (memRes && memRes.success && typeof updateWorkspaceMembers === 'function') {
            updateWorkspaceMembers(memRes.members);
          }
        } catch (_) {
          if (typeof updateWorkspaceMembers === 'function') updateWorkspaceMembers();
        }
      } else if (typeof updateWorkspaceMembers === 'function') {
        updateWorkspaceMembers();
      }
    } else {
      showToast('main-toast', '⚠️ ' + (resp.error || 'Could not promote member.'), 'dark');
    }
  } catch (err) {
    showToast('main-toast', '⚠️ Network error.', 'dark');
  }
}

async function _cmDemoteAdmin(memberId, memberName) {
  if (!confirm('Demote ' + memberName + ' from Admin to Member?')) return;
  var suite = window.AppState && window.AppState.currentSuite;
  if (!suite || !suite.id) return;
  try {
    var resp = await API.demoteAdmin(suite.id, memberId);
    if (resp && resp.success) {
      showToast('main-toast', '⏬ ' + memberName + ' demoted to Member.', 'dark');
      // Update local adminUids immediately for context-menu role detection
      if (Array.isArray(suite.adminUids)) {
        suite.adminUids = suite.adminUids.filter(function(id) { return id !== memberId; });
      }
      if (resp.adminCount !== undefined) suite.adminCount = resp.adminCount;
      if (resp.adminLimit !== undefined) suite.adminLimit = resp.adminLimit;
      // Re-fetch authoritative member list from backend to refresh role badges
      if (typeof API !== 'undefined' && typeof API.getSuiteMembers === 'function') {
        try {
          var memRes = await API.getSuiteMembers(suite.id);
          if (memRes && memRes.success && typeof updateWorkspaceMembers === 'function') {
            updateWorkspaceMembers(memRes.members);
          }
        } catch (_) {
          if (typeof updateWorkspaceMembers === 'function') updateWorkspaceMembers();
        }
      } else if (typeof updateWorkspaceMembers === 'function') {
        updateWorkspaceMembers();
      }
    } else {
      showToast('main-toast', '⚠️ ' + (resp.error || 'Could not demote member.'), 'dark');
    }
  } catch (err) {
    showToast('main-toast', '⚠️ Network error.', 'dark');
  }
}

async function _cmBanMember(memberId, memberName) {
  if (!confirm('Ban ' + memberName + ' for 2 hours?')) return;
  var suite = window.AppState && window.AppState.currentSuite;
  if (!suite || !suite.id) return;
  try {
    var resp = await API.banMember(suite.id, memberId);
    if (resp && resp.success) {
      showToast('main-toast', '🔨 ' + memberName + ' has been banned.', 'dark');
    } else {
      showToast('main-toast', '⚠️ ' + (resp.error || 'Could not ban member.'), 'dark');
    }
  } catch (err) {
    showToast('main-toast', '⚠️ Network error.', 'dark');
  }
}

/* ══ Internal helpers ════════════════════════════════════════ */

function _cmOpenPrivateChat(memberId, memberName) {
  if (typeof openPrivateConversation === 'function') {
    openPrivateConversation(memberId, memberName);
  } else {
    showToast('main-toast', '💬 Private chat is loading…', 'dark');
  }
}

function _cmShowMemberProfile(memberId, memberName) {
  var presenceMap = window._suitePresenceMap || {};
  var currentUid  = window.AppState && window.AppState.currentUser ? window.AppState.currentUser.uid : null;
  var isOnline    = !!(presenceMap[memberId] && presenceMap[memberId].online) || (currentUid && memberId === currentUid);
  var suite       = window.AppState && window.AppState.currentSuite;
  var cachedMembers = window._cachedWorkspaceMembers || (suite && suite.members) || [];
  var targetMember = Array.isArray(cachedMembers) ? cachedMembers.find(function(m) { return m && m.uid === memberId; }) : null;

  var isHost      = Boolean(
    (suite && (suite.ownerUid === memberId || suite.hostUid === memberId)) ||
    (targetMember && (targetMember.isHost || targetMember.role === 'host'))
  );
  var isAdmin     = Boolean(
    !isHost && (
      (targetMember && (targetMember.isAdmin || targetMember.role === 'admin')) ||
      (suite && Array.isArray(suite.adminUids) && suite.adminUids.includes(memberId)) ||
      (suite && Array.isArray(suite.admins) && suite.admins.includes(memberId))
    )
  );
  var isSelf      = (memberId === currentUid);

  var initial = (memberName || '?')[0].toUpperCase();
  var avatarEl = document.getElementById('minfo-avatar');
  var nameEl   = document.getElementById('minfo-name');
  var statusEl = document.getElementById('minfo-status');
  var roleEl   = document.getElementById('minfo-role');
  var msgBtn   = document.getElementById('minfo-msg-btn');

  if (avatarEl) avatarEl.textContent = initial;
  if (nameEl)   nameEl.textContent   = memberName || 'Member';
  if (statusEl) {
    statusEl.innerHTML = isOnline
      ? '<span style="color:var(--fl-green, #16a34a);font-weight:600;">● Online</span>'
      : '<span style="color:var(--fl-text-muted, #64748b);">○ Offline</span>';
  }
  if (roleEl) {
    roleEl.textContent = isHost ? '👑 Suite Host' : (isAdmin ? '🛡️ Suite Admin' : '👥 Member');
  }
  if (msgBtn) {
    if (isSelf) {
      msgBtn.style.display = 'none';
    } else {
      msgBtn.style.display = 'inline-block';
      msgBtn.onclick = function() {
        if (typeof closeModal === 'function') closeModal('modal-member-info');
        _cmOpenPrivateChat(memberId, memberName);
      };
    }
  }

  if (typeof openModal === 'function') {
    openModal('modal-member-info');
  }
}

function _cmConfirmRemove(memberId, memberName, targetRole) {
  _cmPendingRemove = { memberId: memberId, memberName: memberName, role: targetRole };
  var nameEl = document.getElementById('remove-member-name');
  if (nameEl) nameEl.textContent = memberName;

  var isTargetAdmin = (targetRole === 'ADMIN');
  var titleEl = document.getElementById('remove-member-title') || document.querySelector('#modal-remove-member .modal-title span:last-child');
  var btnEl = document.getElementById('btn-confirm-remove-member');
  if (titleEl) titleEl.textContent = isTargetAdmin ? 'Remove Admin' : 'Remove Member';
  if (btnEl) btnEl.textContent = isTargetAdmin ? 'Remove Admin' : 'Remove Member';

  if (typeof openModal === 'function') openModal('modal-remove-member');
}

/* Escape strings for use in onclick attribute strings */
function _esc(str) {
  return (str || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

/* Patch all existing and future member-card elements with contextmenu handler */
function _patchMemberCards() {
  var cards = document.querySelectorAll('.member-card[data-uid], [data-member-uid]');
  cards.forEach(function(card) {
    if (card.dataset.cmPatched) return; // already attached
    card.dataset.cmPatched = '1';
    
    // Desktop right-click
    card.addEventListener('contextmenu', function(e) {
      e.preventDefault();
      e.stopPropagation();
      var uid  = card.dataset.uid || card.dataset.memberUid;
      var name = card.dataset.name || card.querySelector('.member-name')?.textContent?.trim() || 'Member';
      showMemberContextMenu(e, uid, name);
    });

    // Mobile long-press
    var pressTimer = null;
    var touchStartX = 0;
    var touchStartY = 0;
    var touchMoved = false;

    card.addEventListener('touchstart', function(e) {
      touchMoved = false;
      if (e.touches && e.touches[0]) {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
      }
      pressTimer = setTimeout(function() {
        if (!touchMoved) {
          var uid  = card.dataset.uid || card.dataset.memberUid;
          var name = card.dataset.name || card.querySelector('.member-name')?.textContent?.trim() || 'Member';
          showMemberContextMenu({
            clientX: touchStartX,
            clientY: touchStartY,
            preventDefault: function() {},
            stopPropagation: function() {}
          }, uid, name);
        }
      }, 500);
    }, { passive: true });

    card.addEventListener('touchmove', function(e) {
      if (e.touches && e.touches[0]) {
        var dx = Math.abs(e.touches[0].clientX - touchStartX);
        var dy = Math.abs(e.touches[0].clientY - touchStartY);
        if (dx > 10 || dy > 10) touchMoved = true;
      } else {
        touchMoved = true;
      }
      if (touchMoved && pressTimer) clearTimeout(pressTimer);
    }, { passive: true });

    card.addEventListener('touchend', function() {
      if (pressTimer) clearTimeout(pressTimer);
    }, { passive: true });

    card.addEventListener('touchcancel', function() {
      if (pressTimer) clearTimeout(pressTimer);
    }, { passive: true });
  });
}

// Window attachments
window.initMemberContextMenu   = initMemberContextMenu;
window.showMemberContextMenu   = showMemberContextMenu;
window.hideMemberContextMenu   = hideMemberContextMenu;
window.confirmRemoveMember     = confirmRemoveMember;
window._patchMemberCards       = _patchMemberCards;
window._cmOpenPrivateChat      = _cmOpenPrivateChat;
window._cmShowMemberProfile    = _cmShowMemberProfile;
window._cmConfirmRemove        = _cmConfirmRemove;
window._cmPromoteAdmin         = _cmPromoteAdmin;
window._cmDemoteAdmin          = _cmDemoteAdmin;
window._cmBanMember            = _cmBanMember;

/* ══ Auto-init on DOMContentLoaded ══════════════════════════ */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initMemberContextMenu);
} else {
  initMemberContextMenu();
}
