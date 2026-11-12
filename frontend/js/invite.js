/* ── invite.js – Frontend Invite System ──────────────────────────
 *
 * Handles:
 *  • Showing the invite modal with real code + link
 *  • Sending invite emails
 *  • Joining via 5-digit code or invite link
 *  • Invite link URL handling (/invite/:token)
 *  • SSE member-list real-time updates
 *  • Host invalidation on logout/leave
 */

/* ── State ───────────────────────────────────────────────────────── */
let _currentInviteLink  = '';   // Full invite URL currently displayed
let _sseEventSource     = null; // Active SSE connection
let _sseReconnectCount  = 0;    // How many times SSE has dropped and reconnected

/* ══════════════════════════════════════════════════════════════════
   INVITE MODAL — show with real code + link
   ══════════════════════════════════════════════════════════════════ */

/**
 * Called by the "+ Invite" button in the workspace sidebar.
 * Opens the modal and immediately generates/fetches the invite code + link.
 */
async function showInviteModal() {
  openModal('modal-ws-invite');

  // Reset UI state
  _setInviteModalState('generating');

  const suite = AppState.currentSuite;
  const user  = AppState.currentUser;

  // Only permanent suites (with a real ID + owner) can generate backend invites
  if (!suite || !suite.id || !user) {
    // Fallback for quick/temporary suites: show a static message
    _setInviteModalState('no-backend');
    return;
  }

  // Only the host can generate invites
  if (suite.ownerUid && suite.ownerUid !== user.uid) {
    _setInviteModalState('not-host');
    return;
  }

  try {
    const data = await API.generateInvite({ suiteId: suite.id, uid: user.uid });
    if (data.success) {
      _currentInviteLink = data.inviteUrl;
      _setInviteModalState('ready', data.inviteCode, data.inviteUrl);
    } else {
      _setInviteModalState('error', null, null, data.error || 'Failed to generate invite.');
    }
  } catch (err) {
    _setInviteModalState('error', null, null, 'Connection error. Please try again.');
  }
}

/** Set the invite modal to a specific display state. */
function _setInviteModalState(state, code, link, errorMsg) {
  const generatingEl  = document.getElementById('invite-generating');
  const infoPanel     = document.getElementById('invite-info-panel');
  const divider       = document.getElementById('invite-divider');
  const emailForm     = document.getElementById('invite-email-form');
  const loadingEl     = document.getElementById('invite-loading');
  const alertEl       = document.getElementById('invite-email-alert');
  const codeEl        = document.getElementById('invite-code-display');
  const linkEl        = document.getElementById('invite-link-display');
  const emailInput    = document.getElementById('invite-email-input');
  const sendBtn       = document.getElementById('btn-send-invite');

  // Hide everything first
  [generatingEl, infoPanel, divider, emailForm, loadingEl].forEach(el => {
    if (el) el.style.display = 'none';
  });
  if (alertEl) { alertEl.className = 'hidden'; alertEl.textContent = ''; }
  if (emailInput) emailInput.value = '';

  switch (state) {
    case 'generating':
      if (generatingEl) generatingEl.style.display = 'block';
      break;

    case 'ready':
      // Show code
      if (codeEl && code) {
        // Format as spaced digits: "4 9 2 8 3"
        codeEl.textContent = String(code).split('').join(' ');
      }
      // Show link
      if (linkEl && link) {
        linkEl.textContent = link;
        _currentInviteLink = link;
      }
      if (infoPanel)  infoPanel.style.display  = 'block';
      if (divider)    divider.style.display     = 'flex';
      if (emailForm)  emailForm.style.display   = 'block';
      break;

    case 'loading':
      if (infoPanel)   infoPanel.style.display   = 'block';
      if (divider)     divider.style.display      = 'flex';
      if (loadingEl)   loadingEl.style.display    = 'block';
      if (emailForm)   emailForm.style.display    = 'none';
      break;

    case 'not-host':
      if (infoPanel)  infoPanel.style.display  = 'none';
      if (divider)    divider.style.display     = 'none';
      if (emailForm)  emailForm.style.display   = 'block';
      if (alertEl) {
        alertEl.className   = 'alert-error';
        alertEl.textContent = 'Only the Suite Host can send invitations.';
        alertEl.style.display = 'block';
      }
      if (sendBtn) sendBtn.disabled = true;
      break;

    case 'no-backend':
      // Quick suite — no DB record
      if (emailForm) emailForm.style.display = 'block';
      if (alertEl) {
        alertEl.className = 'alert-info';
        alertEl.innerHTML = '⚡ Quick suites don\'t support invite emails.<br>Create a <strong>Permanent Suite</strong> from the dashboard to enable invitations.';
        alertEl.style.display = 'block';
      }
      if (sendBtn) sendBtn.disabled = true;
      break;

    case 'error':
      if (emailForm) emailForm.style.display = 'block';
      if (alertEl) {
        alertEl.className   = 'alert-error';
        alertEl.textContent = errorMsg || 'An error occurred.';
        alertEl.style.display = 'block';
      }
      break;

    case 'sent':
      if (infoPanel) infoPanel.style.display = 'block';
      if (emailForm) emailForm.style.display = 'block';
      if (alertEl) {
        alertEl.className   = 'alert-success';
        alertEl.innerHTML   = '✅ Invitation sent successfully!';
        alertEl.style.display = 'block';
      }
      if (emailInput) emailInput.value = '';
      break;
  }
}

/* ══════════════════════════════════════════════════════════════════
   SEND INVITE EMAIL
   ══════════════════════════════════════════════════════════════════ */

async function handleSendInviteEmail() {
  const emailInput = document.getElementById('invite-email-input');
  const alertEl    = document.getElementById('invite-email-alert');
  const email      = (emailInput ? emailInput.value.trim() : '').toLowerCase();

  // Client-side validation
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    if (alertEl) {
      alertEl.className = 'alert-error';
      alertEl.textContent = 'Please enter a valid email address.';
      alertEl.style.display = 'block';
    }
    return;
  }

  const suite = AppState.currentSuite;
  const user  = AppState.currentUser;

  if (!suite || !suite.id || !user) {
    if (alertEl) {
      alertEl.className = 'alert-error';
      alertEl.textContent = 'Cannot send invite for this suite type.';
      alertEl.style.display = 'block';
    }
    return;
  }

  _setInviteModalState('loading');

  try {
    const data = await API.sendInvite({ suiteId: suite.id, uid: user.uid, email });

    if (data.success) {
      // Update displayed code/link in case they were regenerated
      if (data.inviteCode || data.inviteUrl) {
        _currentInviteLink = data.inviteUrl || _currentInviteLink;
        const codeEl = document.getElementById('invite-code-display');
        const linkEl = document.getElementById('invite-link-display');
        if (codeEl && data.inviteCode) codeEl.textContent = String(data.inviteCode).split('').join(' ');
        if (linkEl && data.inviteUrl)  linkEl.textContent = data.inviteUrl;
      }
      _setInviteModalState('sent');

      if (data.warning) {
        // Email failed but invite was generated
        const alertEl2 = document.getElementById('invite-email-alert');
        if (alertEl2) {
          alertEl2.className = 'alert-warn';
          alertEl2.innerHTML = `⚠️ ${data.warning}`;
          alertEl2.style.display = 'block';
        }
      }
    } else {
      _setInviteModalState('error', null, null, data.error || 'Failed to send invitation.');
    }
  } catch (err) {
    _setInviteModalState('error', null, null, 'Connection error. Please try again.');
  }
}

/* ══════════════════════════════════════════════════════════════════
   COPY INVITE LINK
   (Overrides the stub in workspace.js)
   ══════════════════════════════════════════════════════════════════ */

function copyInviteLink() {
  // Prefer the real backend-generated link; fall back to what's shown on screen
  const linkEl = document.getElementById('invite-link-display')
               || document.getElementById('invite-link-text');
  const text   = _currentInviteLink
               || (linkEl ? linkEl.textContent.trim() : '')
               || location.href;

  copyToClipboard(text);
  showToast('copy-toast', '✓ Invite link copied!', 'green');
}

/* ══════════════════════════════════════════════════════════════════
   JOIN SUITE — from dashboard "Join Suite" section
   (Replaces the stub handleJoinSuite in dashboard.js)
   ══════════════════════════════════════════════════════════════════ */

async function handleJoinSuite() {
  const input = document.getElementById('join-suite-code');
  const raw   = input ? input.value.trim() : '';

  if (!raw) {
    showToast('main-toast', '⚠️ Please enter a suite code or invite link.');
    return;
  }

  const user = AppState.currentUser;
  if (!user) {
    // Not logged in — save pending and redirect to login
    sessionStorage.setItem('pendingInviteRaw', raw);
    navigate('view-login');
    return;
  }

  // Show loading
  const btn = document.querySelector('#view-dashboard .action-block .btn-primary[onclick*="handleJoinSuite"]');
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }

  try {
    await _processJoinInput(raw, user);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Enter'; }
    if (input) input.value = '';
  }
}

/**
 * Process raw join input: detects invite URL vs 5-digit code,
 * validates against backend, and joins the suite.
 */
async function _processJoinInput(raw, user) {
  let inviteData = null;

  // Detect invite link
  const isUrl = raw.startsWith('http') || raw.includes('/invite/');
  if (isUrl) {
    // Extract token from URL
    const match = raw.match(/\/invite\/([a-f0-9]+)/i);
    const token = match ? match[1] : raw;

    try {
      const res = await API.validateInviteToken(token);
      if (!res.success) {
        return _joinError(res.error || 'This invitation link is invalid or has expired.');
      }
      inviteData = { suiteId: res.suiteId, suiteName: res.suiteName };
    } catch (e) {
      return _joinError('Connection error. Please try again.');
    }

  } else if (/^\d{5}$/.test(raw)) {
    // 5-digit code
    try {
      const res = await API.validateInviteCode(raw);
      if (!res.success) {
        return _joinError(res.error || 'This invite code is invalid or has expired.');
      }
      inviteData = { suiteId: res.suiteId, suiteName: res.suiteName };
    } catch (e) {
      return _joinError('Connection error. Please try again.');
    }

  } else {
    return _joinError('Please enter a valid 5-digit code or invite link.');
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
    } else if (joinRes.error && joinRes.error.includes("already a member")) {
      // Already joined — just open the suite
      const suite = {
        id:       inviteData.suiteId,
        name:     inviteData.suiteName,
        isPrivate: false,
        type:     'joined',
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
   INVITE LINK URL HANDLER
   Checks window.location.pathname for /invite/:token on page load
   ══════════════════════════════════════════════════════════════════ */

async function handleInviteUrlOnLoad() {
  const path  = window.location.pathname;
  const match = path.match(/^\/invite\/([a-f0-9]+)$/i);
  if (!match) return;

  const token = match[1];

  // Validate the token first
  let inviteData = null;
  try {
    const res = await API.validateInviteToken(token);
    if (!res.success) {
      // Invalid/expired — just navigate to login with a message
      sessionStorage.removeItem('pendingInviteToken');
      showToast('main-toast', `⚠️ ${res.error || 'This invitation link is invalid.'}`);
      // Clean URL and stay on login
      history.replaceState({}, '', '/');
      return;
    }
    inviteData = { suiteId: res.suiteId, suiteName: res.suiteName, token };
  } catch (e) {
    history.replaceState({}, '', '/');
    return;
  }

  // Store pending invite data
  sessionStorage.setItem('pendingInviteToken', token);
  sessionStorage.setItem('pendingInviteSuiteId', inviteData.suiteId);
  sessionStorage.setItem('pendingInviteSuiteName', inviteData.suiteName);

  // Clean the URL
  history.replaceState({}, '', '/');

  const user = AppState.currentUser;
  if (user) {
    // Already logged in → join immediately
    await _resumePendingInvite(user);
  } else {
    // Show a friendly banner on the login page
    _showPendingInviteBanner(inviteData.suiteName);
    navigate('view-login');
  }
}

/** Show a notice on login page that an invite is waiting */
function _showPendingInviteBanner(suiteName) {
  const loginAlert = document.getElementById('login-alert');
  if (!loginAlert) return;
  loginAlert.className = 'alert alert-info';
  loginAlert.innerHTML = `
    <strong>🔗 Suite Invite Waiting</strong><br>
    You've been invited to join <strong>${escapeHtml(suiteName)}</strong>.<br>
    Log in to continue joining.
  `;
  loginAlert.classList.remove('hidden');
}

/**
 * Called after successful login to check for a pending invite.
 * Returns true if a pending invite was processed.
 */
async function resumePendingInvite(user) {
  const token     = sessionStorage.getItem('pendingInviteToken');
  const raw       = sessionStorage.getItem('pendingInviteRaw');
  const suiteId   = sessionStorage.getItem('pendingInviteSuiteId');
  const suiteName = sessionStorage.getItem('pendingInviteSuiteName');

  if (token && suiteId) {
    _clearPendingInvite();
    await _resumePendingInvite(user, { suiteId, suiteName, token });
    return true;
  } else if (raw) {
    _clearPendingInvite();
    await _processJoinInput(raw, user);
    return true;
  }
  return false;
}

async function _resumePendingInvite(user, override) {
  const suiteId   = override ? override.suiteId   : sessionStorage.getItem('pendingInviteSuiteId');
  const suiteName = override ? override.suiteName : sessionStorage.getItem('pendingInviteSuiteName');

  if (!suiteId) return;
  _clearPendingInvite();

  showToast('main-toast', '⏳ Joining suite…', 'dark');

  try {
    const joinRes = await API.joinSuite({ uid: user.uid, suiteId });
    if (joinRes.success || (joinRes.error && joinRes.error.includes('already a member'))) {
      const suite = {
        id:        suiteId,
        name:      (joinRes.suite && joinRes.suite.name) || suiteName || 'Suite',
        isPrivate: joinRes.suite ? joinRes.suite.isPrivate : false,
        ownerUid:  joinRes.suite ? joinRes.suite.ownerUid : null,
        type:      'joined',
      };
      AppState.saveSuite(suite);
      navigate('view-workspace');
    } else {
      showToast('main-toast', `⚠️ ${joinRes.error || 'Failed to join suite.'}`);
      navigate('view-dashboard');
    }
  } catch (e) {
    showToast('main-toast', '⚠️ Connection error. Could not join suite.');
    navigate('view-dashboard');
  }
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

        if (m.isHost) badges += ` <span style="background:var(--fl-accent-bg);color:var(--fl-accent-dark);padding:2px 6px;border-radius:4px;font-size:0.65rem;margin-left:4px;font-weight:700;">HOST</span>`;
        if (m.isAdmin) badges += ` <span style="background:var(--fl-yellow-bg);color:var(--fl-yellow);padding:2px 6px;border-radius:4px;font-size:0.65rem;margin-left:4px;font-weight:700;">ADMIN</span>`;

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
        return `<div class="member-card" data-uid="${escapeHtml(m.uid || '')}" data-name="${escapeHtml(m.name || '')}" data-online="${isOnline ? '1' : '0'}" data-host="${m.isHost ? '1' : '0'}" style="background:var(--c-lightgray);border-radius:9px;padding:0.6rem 0.8rem;font-size:0.85rem;color:var(--c-charcoal);animation:fadeIn 0.3s ease;cursor:context-menu;">
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <span style="font-weight:600;">${escapeHtml(m.name || 'Unknown')}</span>
            <span style="font-size:0.72rem;font-weight:600;color:${isOnline ? 'var(--fl-green, #16a34a)' : 'var(--fl-text-muted, #64748b)'};">${isOnline ? '● Online' : '○ Offline'}</span>
          </div>
          <span style="color:var(--c-slate);font-size:0.78rem;">${m.username ? '@' + escapeHtml(m.username) : ''}${m.isHost ? ' · Host' : ' · Member'}</span>
        </div>`;
      }).join('');
    }

    if (typeof window._patchMemberCards === 'function') {
      window._patchMemberCards();
    }
}

window.updateWorkspaceMembers = updateWorkspaceMembers;

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
