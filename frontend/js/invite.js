/* ── invite.js – Frontend Invite System ──────────────────────────
 *
 * Handles:
 *  • Showing the invite modal with 5-digit suite code
 *  • Joining via 5-digit code (Join with Code only)
 *  • SSE member-list real-time updates
 *  • Host invalidation on logout/leave
 */

/* ── State ───────────────────────────────────────────────────────── */
let _currentInviteCode  = '';   // Active 5-digit code
let _sseEventSource     = null; // Active SSE connection
let _sseReconnectCount  = 0;    // How many times SSE has dropped and reconnected

/* ══════════════════════════════════════════════════════════════════
   INVITE MODAL — show with real 5-digit code
   ══════════════════════════════════════════════════════════════════ */

/**
 * Called by the "+ Invite" button in the workspace sidebar.
 * Opens the modal and immediately generates/fetches the 5-digit code.
 */
async function showInviteModal() {
  openModal('modal-ws-invite');

  // Reset UI state
  _setInviteModalState('generating');

  const suite = AppState.currentSuite;
  const user  = AppState.currentUser;

  // Only permanent suites (with a real ID + owner) can generate backend invites
  if (!suite || !suite.id || !user) {
    _setInviteModalState('no-backend');
    return;
  }

  // Only the host or admins can generate invites
  const isHost = Boolean(suite.ownerUid === user.uid || suite.hostUid === user.uid);
  const adminUids = Array.isArray(suite.adminUids) ? suite.adminUids : [];
  const isAdmin = !isHost && adminUids.includes(user.uid);
  if (!isHost && !isAdmin) {
    _setInviteModalState('not-host');
    return;
  }

  try {
    const data = await API.generateInvite({ suiteId: suite.id, uid: user.uid });
    if (data && data.success && data.inviteCode) {
      _currentInviteCode = String(data.inviteCode);
      _setInviteModalState('ready', data.inviteCode);
    } else {
      _setInviteModalState('error', null, (data && data.error) || 'Failed to generate invite code.');
    }
  } catch (err) {
    _setInviteModalState('error', null, 'Connection error. Please try again.');
  }
}

/** Set the invite modal to a specific display state. */
function _setInviteModalState(state, code, errorMsg) {
  const generatingEl  = document.getElementById('invite-generating');
  const infoPanel     = document.getElementById('invite-info-panel');
  const divider       = document.getElementById('invite-divider');
  const emailForm     = document.getElementById('invite-email-form');
  const loadingEl     = document.getElementById('invite-loading');
  const alertEl       = document.getElementById('invite-email-alert');
  const codeEl        = document.getElementById('invite-code-display');

  // Hide obsolete / auxiliary sections
  [generatingEl, infoPanel, divider, emailForm, loadingEl].forEach(el => {
    if (el) el.style.display = 'none';
  });
  if (alertEl) { alertEl.className = 'hidden'; alertEl.textContent = ''; }

  switch (state) {
    case 'generating':
      if (generatingEl) generatingEl.style.display = 'block';
      break;

    case 'ready':
      if (codeEl && code) {
        _currentInviteCode = String(code);
        codeEl.textContent = String(code).split('').join(' ');
      }
      if (infoPanel) infoPanel.style.display = 'block';
      break;

    case 'not-host':
      if (infoPanel) infoPanel.style.display = 'none';
      if (alertEl) {
        alertEl.className   = 'text-xs p-2.5 rounded-lg bg-red-50 text-red-700 border border-red-200';
        alertEl.textContent = 'Only the Suite Host or Admins can access invitation codes.';
        alertEl.style.display = 'block';
      }
      break;

    case 'no-backend':
      if (alertEl) {
        alertEl.className = 'text-xs p-2.5 rounded-lg bg-amber-50 text-amber-800 border border-amber-200';
        alertEl.innerHTML = '⚡ Quick suites don\'t support permanent invite codes.<br>Create a <strong>Permanent Suite</strong> from the dashboard to invite peers with a code.';
        alertEl.style.display = 'block';
      }
      break;

    case 'error':
      if (alertEl) {
        alertEl.className   = 'text-xs p-2.5 rounded-lg bg-red-50 text-red-700 border border-red-200';
        alertEl.textContent = errorMsg || 'An error occurred generating the code.';
        alertEl.style.display = 'block';
      }
      break;
  }
}

/* ══════════════════════════════════════════════════════════════════
   COPY INVITE CODE
   ══════════════════════════════════════════════════════════════════ */

function copyInviteCode() {
  const codeEl = document.getElementById('invite-code-display');
  const textEl = document.getElementById('invite-code-text');

  let text = _currentInviteCode;
  if (!text && codeEl) {
    text = codeEl.textContent.replace(/\s+/g, '').trim();
  }
  if ((!text || text.includes('─')) && textEl) {
    text = textEl.textContent.trim();
  }

  // Clean formatted code
  text = (text || '').replace(/[^0-9]/g, '');

  if (text) {
    copyToClipboard(text);
    showToast('main-toast', `✓ Suite code ${text} copied to clipboard!`, 'green');
  } else {
    showToast('main-toast', '⚠️ No invite code available to copy.');
  }
}

// Backward compatibility alias for any existing callers of copyInviteLink
function copyInviteLink() {
  copyInviteCode();
}

/* ══════════════════════════════════════════════════════════════════
   JOIN SUITE — Join with 5-digit code only
   ══════════════════════════════════════════════════════════════════ */

async function handleJoinSuite() {
  const input = document.getElementById('join-suite-code');
  const raw   = input ? input.value.trim() : '';

  if (!raw) {
    showToast('main-toast', '⚠️ Please enter a 5-digit suite code.');
    return;
  }

  const user = AppState.currentUser;
  if (!user) {
    // Not logged in — save pending code and redirect to login
    sessionStorage.setItem('pendingInviteRaw', raw);
    navigate('view-login');
    return;
  }

  // Show loading
  const btn = document.querySelector('#view-dashboard .action-block .btn-primary[onclick*="handleJoinSuite"]')
           || document.querySelector('button[onclick="handleJoinSuite()"]');
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }

  try {
    await _processJoinInput(raw, user);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Join'; }
    if (input) input.value = '';
  }
}

/**
 * Process join input: accepts 5-digit codes only.
 * Validates against backend and joins the suite.
 */
async function _processJoinInput(raw, user) {
  const code = (raw || '').trim();

  // Explicitly reject links
  if (code.startsWith('http') || code.includes('/invite/')) {
    return _joinError('Join with Link has been removed. Please enter a 5-digit suite code.');
  }

  if (!/^\d{5}$/.test(code)) {
    return _joinError('Please enter a valid 5-digit suite code.');
  }

  let inviteData = null;
  try {
    const res = await API.validateInviteCode(code);
    if (!res.success) {
      return _joinError(res.error || 'This invite code is invalid or has expired.');
    }
    inviteData = { suiteId: res.suiteId, suiteName: res.suiteName };
  } catch (e) {
    return _joinError('Connection error. Please try again.');
  }

  // Now join the suite
  try {
    showToast('main-toast', '⏳ Joining suite…', 'dark');
    const joinRes = await API.joinSuite({ uid: user.uid, suiteId: inviteData.suiteId });

    if (joinRes.success) {
      const suite = {
        id:        inviteData.suiteId,
        name:      joinRes.suite ? joinRes.suite.name : inviteData.suiteName,
        isPrivate: joinRes.suite ? joinRes.suite.isPrivate : false,
        ownerUid:  joinRes.suite ? joinRes.suite.ownerUid : null,
        type:      'joined',
      };
      AppState.saveSuite(suite);
      navigate('view-workspace');
    } else if (joinRes.error && joinRes.error.includes('already a member')) {
      // Already joined — just open the suite
      const suite = {
        id:        inviteData.suiteId,
        name:      inviteData.suiteName,
        isPrivate: false,
        type:      'joined',
      };
      AppState.saveSuite(suite);
      navigate('view-workspace');
    } else {
      _joinError(joinRes.error || 'Failed to join suite.');
    }
  } catch (e) {
    _joinError('Connection error. Please try again.');
  }
}

function _joinError(msg) {
  showToast('main-toast', `⚠️ ${msg}`);
}

/* ══════════════════════════════════════════════════════════════════
   INVITE LINK URL CLEANUP (Obsolete link handler)
   ══════════════════════════════════════════════════════════════════ */

async function handleInviteUrlOnLoad() {
  const path  = window.location.pathname;
  if (/^\/invite\//i.test(path)) {
    const cleanUrl = (window.CONFIG && window.CONFIG.BASE_PATH) || '/';
    history.replaceState({}, '', cleanUrl);
    showToast('main-toast', '⚠️ Join with Link has been removed. Please join using a 5-digit suite code.');
  }
}

/**
 * Called after successful login to check for a pending invite code.
 */
async function resumePendingInvite(user) {
  const raw = sessionStorage.getItem('pendingInviteRaw');
  _clearPendingInvite();

  if (raw && /^\d{5}$/.test(raw.trim())) {
    await _processJoinInput(raw.trim(), user);
    return true;
  }
  return false;
}

function _clearPendingInvite() {
  ['pendingInviteToken','pendingInviteRaw','pendingInviteSuiteId','pendingInviteSuiteName']
    .forEach(k => sessionStorage.removeItem(k));
}

/* ══════════════════════════════════════════════════════════════════
   SSE — Real-time member list updates
   ══════════════════════════════════════════════════════════════════ */

/**
 * Connect to the SSE stream for a suite.
 * Called when entering the workspace view.
 */
function connectMemberSSE(suiteId) {
  disconnectMemberSSE(); // clean up previous connection

  if (!suiteId) return;

  const uid = (AppState && AppState.currentUser) ? AppState.currentUser.uid : '';
  const token = (AppState && AppState.token) ? AppState.token : '';
  const queryParams = new URLSearchParams();
  if (uid) queryParams.set('uid', uid);
  if (token) queryParams.set('token', token);
  const qStr = queryParams.toString();
  const url = `${CONFIG.API_BASE}/api/suite/${encodeURIComponent(suiteId)}/members/stream${qStr ? '?' + qStr : ''}`;
  _sseEventSource = new EventSource(url);

  _sseEventSource.onmessage = (e) => {
    try {
      const payload = JSON.parse(e.data);

      // ── Member list update (existing)
      if (payload.type === 'members' && Array.isArray(payload.members)) {
        updateWorkspaceMembers(payload.members);
      }

      // ── File added – real-time document list update
      // ISOLATION: only process if event belongs to the currently active suite.
      if (payload.type === 'file_added' && payload.file) {
        const activeSuite = AppState && AppState.currentSuite;
        const eventSuiteId = payload.file.suiteId || payload.suiteId || '';
        if (activeSuite && eventSuiteId && eventSuiteId !== activeSuite.id) {
          // Event from a different suite — discard
          console.log('[SSE] file_added ignored: event suiteId', eventSuiteId, '!== active', activeSuite.id);
        } else {
          if (typeof addDriveFileToList === 'function') {
            addDriveFileToList(payload.file);
          }
          // Toast only for other members' uploads
          const uploader = payload.file.uploadedByName || 'Someone';
          const fileName = payload.file.fileName       || 'a file';
          const selfUid  = AppState && AppState.currentUser ? AppState.currentUser.uid : '';
          if (payload.file.ownerUid !== selfUid) {
            showToast('main-toast', `📄 ${escapeHtml(uploader)} uploaded "${escapeHtml(fileName)}"`, 'dark');
          }
        }
      }

      // ── File deleted
      // ISOLATION: only process if event belongs to the currently active suite.
      if (payload.type === 'file_deleted' && payload.fileId) {
        const activeSuite = AppState && AppState.currentSuite;
        const eventSuiteId = payload.suiteId || '';
        if (activeSuite && eventSuiteId && eventSuiteId !== activeSuite.id) {
          console.log('[SSE] file_deleted ignored: event suiteId', eventSuiteId, '!== active', activeSuite.id);
        } else {
          if (typeof removeDriveFileFromList === 'function') {
            removeDriveFileFromList(payload.fileId);
          }
        }
      }

    } catch (_) {}
  };

  _sseEventSource.onerror = () => {
    _sseReconnectCount++;
    // SSE dropped — EventSource auto-reconnects silently.
    // We just track the count so developers can diagnose unstable connections.
    console.log('[SSE] Connection dropped, will auto-reconnect (total drops: ' + _sseReconnectCount + ')');
  };
}

/** Disconnect and clean up the SSE connection. */
function disconnectMemberSSE() {
  if (_sseEventSource) {
    _sseEventSource.close();
    _sseEventSource = null;
  }
}

/**
 * Returns SSE connection info for CoLearnDebug and getListenerCount().
 * Called from document-service.js getListenerCount().
 */
function getSseListenerInfo() {
  return {
    connected:      _sseEventSource !== null,
    reconnectCount: _sseReconnectCount,
  };
}

  let _cachedWorkspaceMembers = [];

  function updateWorkspaceMembers(members) {
    if (Array.isArray(members)) {
      _cachedWorkspaceMembers = members;
    }

    const presenceMap = window._suitePresenceMap || {};
    const currentUid  = (AppState && AppState.currentUser) ? AppState.currentUser.uid : null;
    const isSelfInActiveSuite = Boolean(currentUid && window._currentPresenceSuiteId);

    // Build unified member list — only recorded suite members are shown.
    // Presence data is overlaid for online/offline status only; it never adds new members.
    const memberMap = new Map();

    // 1. Add cached/passed members (from REST /members API or SSE broadcast)
    (_cachedWorkspaceMembers || []).forEach(m => {
      if (m && m.uid) {
        memberMap.set(m.uid, { ...m });
      }
    });

    // 2. Merge AppState.currentSuite.members ONLY for UIDs that are recorded
    //    in memberUids — prevents stale data from a different suite session
    //    from leaking into the current suite's member display.
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

    // 3. Ensure the current user appears IF they are a recorded suite member.
    //    Only adds as a fallback — the backend /members response already includes them.
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

    // 4. Overlay RTDB presence onto EXISTING recorded members ONLY.
    //    A UID that is only in the presence map (not in memberMap) is ignored;
    //    presence alone NEVER grants membership in a suite.
    Object.keys(presenceMap).forEach(uid => {
      const p = presenceMap[uid];
      if (p && memberMap.has(uid)) {
        const existing = memberMap.get(uid);
        // Update display name only if current stored name looks like a uid placeholder
        if (p.name && (existing.name === uid || !existing.name)) existing.name = p.name;
        // isHost confirmed by presence, but never demote a confirmed host
        if (p.isHost) existing.isHost = true;
      }
      // UIDs in presenceMap but NOT in memberMap are intentionally ignored.
    });

    const displayMembers = Array.from(memberMap.values());
    _cachedWorkspaceMembers = displayMembers;
    window._cachedWorkspaceMembers = displayMembers;
    if (AppState && AppState.currentSuite) {
      AppState.currentSuite.members = displayMembers;
    }

    // Update sidebar members list
    const sidebar = document.getElementById('sidebar-members-list');
    
    // Update Member Count in Header
    const headerTitle = document.getElementById('ws-sidebar-header-title');
    if (headerTitle) {
      headerTitle.textContent = `Members (${displayMembers.length})`;
    }

    if (sidebar) {
      const avatarColors = [
        'background:linear-gradient(135deg,var(--fl-accent-dark),var(--fl-accent))',
        'background:linear-gradient(135deg,#17a2b8,#0f7a8c)',
        'background:linear-gradient(135deg,#28a745,#1e7e34)',
        'background:linear-gradient(135deg,#ffc107,#d39e00);color:#212529',
        'background:linear-gradient(135deg,#dc3545,#bd2130)',
        'background:linear-gradient(135deg,#6f42c1,#5a32a3)',
      ];
  
      // Re-render members (keep join-request-container and member4 at bottom)
      const joinReqContainer  = document.getElementById('join-request-container');
      const member4Card       = document.getElementById('member4-sidebar-card');
      const savedJoinReq      = joinReqContainer ? joinReqContainer.outerHTML : '';
      const savedMember4      = member4Card ? member4Card.outerHTML : '';

      // Build member cards with real-time Online / Offline presence
      const memberHTML = displayMembers.map((m, i) => {
        const initial    = (m.name || '?')[0].toUpperCase();
        const colorStyle = avatarColors[i % avatarColors.length];
        
        // Determine whether this specific member is currently active in the suite
        const isOnline = !!(presenceMap[m.uid] && presenceMap[m.uid].online) || (isSelfInActiveSuite && m.uid === currentUid);

        let badges = isOnline
          ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--fl-green, #16a34a);margin-right:4px;"></span> <span style="color:var(--fl-green, #16a34a);font-weight:600;">Online</span>`
          : `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--fl-text-muted, #94a3b8);margin-right:4px;"></span> <span style="color:var(--fl-text-muted, #64748b);">Offline</span>`;

        if (m.isHost) {
          badges += ` <span style="background:var(--fl-accent-bg);color:var(--fl-accent-dark);padding:2px 6px;border-radius:4px;font-size:0.65rem;margin-left:4px;font-weight:700;">HOST</span>`;
        } else if (m.isAdmin) {
          badges += ` <span style="background:var(--fl-yellow-bg);color:var(--fl-yellow);padding:2px 6px;border-radius:4px;font-size:0.65rem;margin-left:4px;font-weight:700;">ADMIN</span>`;
        } else {
          badges += ` <span style="background:#f1f5f9;color:#475569;padding:2px 6px;border-radius:4px;font-size:0.65rem;margin-left:4px;font-weight:600;">MEMBER</span>`;
        }

        return `
          <div class="member-card" data-uid="${escapeHtml(m.uid || '')}" data-name="${escapeHtml(m.name || '')}" data-online="${isOnline ? '1' : '0'}" data-host="${m.isHost ? '1' : '0'}" style="animation:fadeIn 0.3s ease;display:flex;align-items:center;gap:0.75rem;padding:0.75rem 1rem;border-bottom:1px solid var(--fl-border);cursor:context-menu;">
            <div class="member-avatar" style="${colorStyle};width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;flex-shrink:0;">${initial}</div>
            <div style="min-width:0;flex:1;">
              <div class="member-name" style="font-weight:600;font-size:0.9rem;color:var(--fl-text-hi);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(m.name || 'Unknown')}</div>
              <div style="font-size:0.75rem;color:var(--fl-text-muted);display:flex;align-items:center;margin-top:2px;">${badges}</div>
            </div>
          </div>`;
      }).join('');
  
      sidebar.innerHTML = memberHTML + savedJoinReq + savedMember4;
    }

    // Update member grid in ws-state-invite (the main panel)
    const memberGrid = document.querySelector('#ws-state-invite .section-label + div[style*="grid"]');
    if (memberGrid && displayMembers.length > 0) {
      const avatarColorsGrid = ['', 'background:linear-gradient(135deg,#17a2b8,#0f7a8c)', 'background:linear-gradient(135deg,#28a745,#1e7e34)', 'background:linear-gradient(135deg,#ffc107,#d39e00);color:#212529'];

      memberGrid.innerHTML = displayMembers.map((m, i) => {
        const bgStyle = avatarColorsGrid[i % avatarColorsGrid.length] || '';
        const isOnline = !!(presenceMap[m.uid] && presenceMap[m.uid].online) || (isSelfInActiveSuite && m.uid === currentUid);
          const roleLabel = m.isHost ? 'Host' : (m.isAdmin ? 'Admin' : 'Member');
          return `<div class="member-card" data-uid="${escapeHtml(m.uid || '')}" data-name="${escapeHtml(m.name || '')}" data-online="${isOnline ? '1' : '0'}" data-host="${m.isHost ? '1' : '0'}" style="background:var(--c-lightgray);border-radius:9px;padding:0.6rem 0.8rem;font-size:0.85rem;color:var(--c-charcoal);animation:fadeIn 0.3s ease;cursor:context-menu;">
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <span style="font-weight:600;">${escapeHtml(m.name || 'Unknown')}</span>
            <span style="font-size:0.72rem;font-weight:600;color:${isOnline ? 'var(--fl-green, #16a34a)' : 'var(--fl-text-muted, #64748b)'};">${isOnline ? '● Online' : '○ Offline'}</span>
          </div>
          <span style="color:var(--c-slate);font-size:0.78rem;">${m.username ? '@' + escapeHtml(m.username) : ''} · ${roleLabel}</span>
        </div>`;
      }).join('');
    }

    // Toggle "+ Invite Peers" button visibility (Host and Admins only)
    const activeSuite = AppState.currentSuite;
    const activeUser  = AppState.currentUser;
    const isHostOrAdmin = Boolean(activeUser && activeSuite && (
      activeSuite.hostUid === activeUser.uid ||
      activeSuite.ownerUid === activeUser.uid ||
      (Array.isArray(activeSuite.adminUids) && activeSuite.adminUids.includes(activeUser.uid))
    ));
    const sidebarInviteBtn = document.getElementById('btn-sidebar-invite');
    if (sidebarInviteBtn) {
      sidebarInviteBtn.style.display = isHostOrAdmin ? '' : 'none';
    }

    if (typeof window._patchMemberCards === 'function') {
      window._patchMemberCards();
    }
}

window.updateWorkspaceMembers = updateWorkspaceMembers;
window.copyInviteCode         = copyInviteCode;
window.copyInviteLink         = copyInviteLink;
window.showInviteModal        = showInviteModal;
window.handleJoinSuite        = handleJoinSuite;
window.resumePendingInvite    = resumePendingInvite;
window.handleInviteUrlOnLoad  = handleInviteUrlOnLoad;

/* ══════════════════════════════════════════════════════════════════
   HOST: INVALIDATE INVITES ON LEAVE / LOGOUT
   ══════════════════════════════════════════════════════════════════ */

async function invalidateHostInvitesNow() {
  const user  = AppState.currentUser;
  const suite = AppState.currentSuite;
  if (!user) return;

  // Only invalidate if this user is the host of the current suite
  if (suite && suite.ownerUid && suite.ownerUid !== user.uid) return;

  try {
    await API.invalidateHostInvites(user.uid);
  } catch (_) {}
}

/* ══════════════════════════════════════════════════════════════════
   INIT — handled by initApp() in router.js
   handleInviteUrlOnLoad() is called from initApp() to avoid
   race conditions between session restore and invite handling.
   ══════════════════════════════════════════════════════════════ */
