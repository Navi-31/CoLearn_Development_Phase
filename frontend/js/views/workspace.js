/* ── VIEW 6 – Active Suite Workspace ─────────────────────────── */

/* ─ Workspace initialisation ─────────────────────────────────── */
function initWorkspace() {
  const suite = AppState.currentSuite;

  // Suite name in header
  const nameEl = document.getElementById('ws-suite-name');
  if (nameEl) nameEl.textContent = suite ? (suite.name || 'Unnamed Suite') : 'Suite';

  // Privacy badge
  const badge = document.getElementById('ws-privacy-badge');
  if (badge) {
    if (suite && suite.isPrivate) {
      badge.textContent = '🔒 Private';
      badge.style.cssText = 'background:#fff3cd;color:#856404;font-size:0.78rem;padding:0.25rem 0.7rem;border-radius:20px;font-weight:600;';
    } else {
      badge.textContent = '🔓 Public';
      badge.style.cssText = 'background:#d4edda;color:#155724;font-size:0.78rem;padding:0.25rem 0.7rem;border-radius:20px;font-weight:600;';
    }
  }

  // Load join requests if host or admin
  if (suite && suite.id && suite.isPrivate) {
    loadSuiteJoinRequests(suite.id);
  } else {
    const jr = document.getElementById('join-request-container');
    if (jr) jr.style.display = 'none';
  }

  // Reset member 4
  ['ws-member4-info','member4-sidebar-card','vid-member4'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });

  // Reset sidebar
  AppState.sidebarOpen = true;
  const sidebar = document.getElementById('ws-sidebar');
  if (sidebar) sidebar.classList.remove('collapsed');
  const chev = document.getElementById('sidebar-chevron');
  if (chev) chev.textContent = '›';

  // Reset chat
  AppState.chatOpen = false;
  const chatPanel = document.getElementById('chat-panel');
  if (chatPanel) chatPanel.classList.remove('open');
  const chatBtn = document.getElementById('btn-chat');
  if (chatBtn) chatBtn.classList.remove('active-tool');

  // Reset AI panel
  AppState.aiOpen = false;
  const aiPanel = document.getElementById('ai-panel');
  if (aiPanel) aiPanel.classList.remove('open');
  const aiBtn = document.getElementById('btn-ai');
  if (aiBtn) aiBtn.classList.remove('active-tool');


  // Reset mic/cam (Microphone starts OFF by default)
  AppState.micOn = false; AppState.camOn = false;
  ['btn-mic','btn-cam'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.classList.add('muted');
  });
  const tbMic = document.getElementById('tb-btn-mic');
  if (tbMic) { tbMic.classList.add('muted'); tbMic.classList.remove('active-tool'); tbMic.style.color = '#dc3545'; }
  const micIcon = document.querySelector('#btn-mic .taskbar-icon');
  const camIcon = document.querySelector('#btn-cam .taskbar-icon');
  if (micIcon) micIcon.textContent = '🔇';
  if (camIcon) camIcon.textContent = '📹';

  // Reset taskbar tool highlights
  ['btn-docs','btn-whiteboard'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.classList.remove('active-tool');
  });


  // Invite link — use real backend link if suite has an ID + user is host
  const linkTextEl = document.getElementById('invite-link-text');
  if (suite && suite.id && AppState.currentUser) {
    if (linkTextEl) linkTextEl.textContent = 'Generating invite link…';
    const user = AppState.currentUser;
    if (!suite.ownerUid || suite.ownerUid === user.uid) {
      API.generateInvite({ suiteId: suite.id, uid: user.uid })
        .then(data => {
          if (data && data.success) {
            if (linkTextEl) linkTextEl.textContent = data.inviteUrl;
            if (typeof window !== 'undefined') {
              window._currentInviteLink = data.inviteUrl;
            }
          }
        })
        .catch(() => {
          if (linkTextEl) linkTextEl.textContent = location.origin + '/invite/(code generated on demand)';
        });
    } else {
      if (linkTextEl) linkTextEl.textContent = 'Ask the host for the invite link.';
    }
  } else {
    const code = Math.random().toString(36).substr(2, 8).toUpperCase();
    if (linkTextEl) linkTextEl.textContent = location.origin + '/quick/' + code;
  }

  // Set default state
  setWSState('invite', true);

  // Connect SSE for real-time member list (only for persistent suites)
  if (suite && suite.id && typeof connectMemberSSE === 'function') {
    connectMemberSSE(suite.id);
  }

  // Fetch initial suite members from REST API immediately
  if (suite && suite.id && typeof API !== 'undefined' && typeof API.getSuiteMembers === 'function') {
    API.getSuiteMembers(suite.id).then(res => {
      if (res && res.success && Array.isArray(res.members)) {
        if (typeof updateWorkspaceMembers === 'function') {
          updateWorkspaceMembers(res.members);
        }
      }
    }).catch(() => {});
  }

  // Init whiteboard
  setTimeout(() => initWhiteboard(), 50);

  // Init real-time suite presence (Online / Offline tracking)
  if (suite && suite.id) {
    initSuitePresence(suite.id);
  }

  // Init real-time chat (Firebase)
  if (suite && suite.id) {
    initSuiteChat(suite.id);
  }

  // Init voice (WebRTC)
  if (suite && suite.id && AppState.currentUser) {
    if (typeof initVoice === 'function') {
      initVoice(suite.id, AppState.currentUser.uid, AppState.currentUser.name);
    }
  }

  // Init video call module
  if (suite && suite.id && AppState.currentUser) {
    if (typeof initVideoCall === 'function') {
      initVideoCall(suite.id, AppState.currentUser.uid, AppState.currentUser.name);
    }
  }

  // Init screen share module
  if (suite && suite.id && AppState.currentUser) {
    if (typeof initScreenShare === 'function') {
      initScreenShare(suite.id, AppState.currentUser.uid, AppState.currentUser.name);
    }
  }

  // Init notifications
  if (AppState.currentUser) {
    if (typeof initNotifications === 'function') {
      initNotifications(AppState.currentUser.uid);
    }
  }

  // Init private chat
  if (AppState.currentUser) {
    if (typeof initPrivateChat === 'function') {
      initPrivateChat(AppState.currentUser.uid, AppState.currentUser.name);
    }
  }

  // Init Google Drive: clear stale file cards but PRESERVE the upload queue
  // so files queued before navigating away are still visible on return.
  if (suite && suite.id) {
    // Preserve queue on workspace entry — wipe only rendered cards + stale caches
    if (typeof clearSuiteDocState === 'function') {
      clearSuiteDocState({ preserveQueue: true });
    }
    // Check Drive connection status (updates badge)
    if (typeof _checkDriveStatus === 'function') {
      _checkDriveStatus();
    }
    // Load existing Drive files for this suite
    if (typeof loadSuiteDriveFiles === 'function') {
      loadSuiteDriveFiles(suite.id);
    }
  }
  // Init file grid (Fluent document view)
  if (suite && suite.id) {
    if (typeof fileGridInit === 'function') {
      fileGridInit();
    }
  }

  // Compute workspace role for permission gating (HOST, ADMIN, MEMBER)
  if (suite && AppState.currentUser) {
    const uid = AppState.currentUser.uid;
    const isHost = (suite.hostUid === uid || suite.ownerUid === uid);
    const adminUids = Array.isArray(suite.adminUids) ? suite.adminUids : [];
    const isAdmin = !isHost && adminUids.includes(uid);
    AppState.wsRole = isHost ? 'host' : (isAdmin ? 'admin' : 'member');
  } else {
    AppState.wsRole = 'member';
  }
}

/* ─ Viewport state switching ─────────────────────────────────── */
function setWSState(state, silent) {
  if (AppState.wsCurrentState === 'whiteboard' && state !== 'whiteboard') {
    if (typeof cleanupWhiteboardAutoHide === 'function') cleanupWhiteboardAutoHide();
  }

  AppState.wsCurrentState = state;
  ['invite','docs','whiteboard','room-hub'].forEach(s => {
    const el = document.getElementById('ws-state-' + s);
    if (el) el.style.display = 'none';
  });
  const active = document.getElementById('ws-state-' + state);
  if (active) { active.style.display = 'block'; active.style.animation = 'fadeIn 0.2s ease'; }

  ['btn-docs','btn-whiteboard'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.classList.remove('active-tool');
  });
  if (state === 'docs')       document.getElementById('btn-docs')?.classList.add('active-tool');
  if (state === 'whiteboard') document.getElementById('btn-whiteboard')?.classList.add('active-tool');

  if (state === 'whiteboard') {
    if (!silent) setTimeout(resizeWhiteboard, 80);
    // Auto screen share on whiteboard start (Issue 9)
    if (typeof _ssIsPresenting !== 'undefined' && !_ssIsPresenting && typeof startScreenShare === 'function') {
      startScreenShare();
    }
    if (typeof initWhiteboardAutoHide === 'function') {
      initWhiteboardAutoHide();
    }
  }

  // When switching to invite (Suite Home), refresh the file grid
  if (state === 'invite' && !silent) {
    const suite = AppState && AppState.currentSuite;
    if (suite && suite.id) {
      if (typeof loadSuiteDriveFiles === 'function') loadSuiteDriveFiles(suite.id);
      if (typeof fileGridInit === 'function') fileGridInit();
    }
    if (typeof _checkDriveStatus === 'function') _checkDriveStatus();
  }

  // When switching to docs view, reload Drive files for the current (and only) suite
  if (state === 'docs' && !silent) {
    const suite = AppState && AppState.currentSuite;
    if (suite && suite.id) {
      if (typeof loadSuiteDriveFiles === 'function') {
        loadSuiteDriveFiles(suite.id);
      }
    }
    if (typeof _checkDriveStatus === 'function') {
      _checkDriveStatus();
    }
    // #17: Hide participants panel in document view mode
    const docParticipants = document.getElementById('doc-view-participants');
    if (docParticipants) docParticipants.style.display = 'none';
  }

  // When switching to room hub, render it
  if (state === 'room-hub' && !silent) {
    _renderRoomHub();
  }
}

/* ─ Room Hub renderer ────────────────────────────────────────── */
function _renderRoomHub() {
  const hub = document.getElementById('ws-state-room-hub');
  if (!hub) return;
  const isVoice = (typeof _voiceActive !== 'undefined' && _voiceActive) || (typeof window._voiceActive !== 'undefined' && window._voiceActive);

  hub.innerHTML = `
    <div style="padding:0 0 0.5rem;">
      <div style="font-size:1.1rem;font-weight:800;color:var(--fl-text-hi);margin-bottom:0.25rem;">&#128682; Room</div>
      <div style="font-size:0.82rem;color:var(--fl-text-lo);">Choose what to do in the suite room.</div>
    </div>
    <div class="fl-room-hub-grid">
      <button class="fl-room-hub-btn" onclick="joinVideoCall()">
        <span class="fl-room-hub-icon">&#128249;</span>
        <span class="fl-room-hub-label">Video Call</span>
        <span class="fl-room-hub-desc">Join with camera &amp; mic</span>
      </button>
      <button class="fl-room-hub-btn" id="room-hub-voice-btn" onclick="${isVoice ? 'endVoiceCall()' : 'startVoiceCall()'}">
        <span class="fl-room-hub-icon">&#127908;</span>
        <span class="fl-room-hub-label" id="room-hub-voice-label">${isVoice ? 'End Voice Call' : 'Voice Only'}</span>
        <span class="fl-room-hub-desc" id="room-hub-voice-desc">${isVoice ? 'Leave active voice session' : 'Join with microphone'}</span>
      </button>
      <button class="fl-room-hub-btn" onclick="startScreenShare()">
        <span class="fl-room-hub-icon">&#128250;</span>
        <span class="fl-room-hub-label">Screen Share</span>
        <span class="fl-room-hub-desc">Share your screen</span>
      </button>
      <button class="fl-room-hub-btn" onclick="setWSState('whiteboard')">
        <span class="fl-room-hub-icon">&#127912;</span>
        <span class="fl-room-hub-label">Whiteboard</span>
        <span class="fl-room-hub-desc">Draw together live</span>
      </button>
      <button class="fl-room-hub-btn" onclick="setWSState('docs')">
        <span class="fl-room-hub-icon">&#128193;</span>
        <span class="fl-room-hub-label">Documents</span>
        <span class="fl-room-hub-desc">Access &amp; view files</span>
      </button>
      <button class="fl-room-hub-btn" onclick="toggleChat()">
        <span class="fl-room-hub-icon">&#128172;</span>
        <span class="fl-room-hub-label">Chat</span>
        <span class="fl-room-hub-desc">Open group chat</span>
      </button>
      <button class="fl-room-hub-btn" onclick="setWSState('invite')">
        <span class="fl-room-hub-icon">&#127968;</span>
        <span class="fl-room-hub-label">Suite Home</span>
        <span class="fl-room-hub-desc">Back to home</span>
      </button>
    </div>`;
}

/* ─ Return to active call ────────────────────────────────────── */
function returnToCall() {
  // Show whichever overlay is currently active
  const vc  = document.getElementById('video-call-overlay');
  const ss  = document.getElementById('screen-share-overlay');
  if (vc  && !vc.classList.contains('hidden'))  return;
  if (ss  && !ss.classList.contains('hidden'))  return;
  // Re-open video overlay if in a call
  if (AppState.activeCallState === 'video') {
    if (vc)  vc.classList.remove('hidden');
  } else if (AppState.activeCallState === 'screen') {
    if (ss)  ss.classList.remove('hidden');
  }
}

/* ─ Sidebar toggle ───────────────────────────────────────────── */
function toggleSidebar() {
  AppState.sidebarOpen = !AppState.sidebarOpen;
  const sidebar = document.getElementById('ws-sidebar');
  const chevron = document.getElementById('sidebar-chevron');
  if (sidebar) sidebar.classList.toggle('collapsed', !AppState.sidebarOpen);
  if (chevron) chevron.textContent = AppState.sidebarOpen ? '›' : '‹';
}

/* ─ Leave suite ──────────────────────────────────────────────── */
async function leaveSuite() {
  if (!confirm('Leave this suite? Your session will end.')) return;

  // Cleanup suite presence (marks user Offline in RTDB)
  cleanupSuitePresence();

  // Cleanup all media modules
  if (typeof cleanupVoice              === 'function') cleanupVoice();
  if (typeof cleanupVideoCall          === 'function') await cleanupVideoCall();
  if (typeof cleanupScreenShare        === 'function') await cleanupScreenShare();
  if (typeof cleanupNotifications      === 'function') cleanupNotifications();
  if (typeof cleanupPrivateChat        === 'function') cleanupPrivateChat();
  if (typeof cleanupWhiteboardAutoHide === 'function') cleanupWhiteboardAutoHide();

  // Disconnect chat listener
  cleanupSuiteChat();

  // Disconnect SSE
  if (typeof disconnectMemberSSE === 'function') disconnectMemberSSE();

  // If host, invalidate all active invites
  if (typeof invalidateHostInvitesNow === 'function') {
    await invalidateHostInvitesNow();
  }

  // Clear all Drive state for this suite — wipe queue too (leaving, not navigating)
  if (typeof clearSuiteDocState === 'function') {
    clearSuiteDocState({ preserveQueue: false });
  }

  // Clear suite from session (keep user logged in)
  AppState.saveSuite(null);

  navigate('view-dashboard');
}

/* ─ Mic / Cam ────────────────────────────────────────────────── */
function toggleMic() {
  if (typeof _vcInCall !== 'undefined' && _vcInCall) {
    if (typeof toggleVideoMic === 'function') {
      return toggleVideoMic();
    }
  }
  // Call full voice module toggleMic if available
  if (typeof window.toggleMic === 'function' && window.toggleMic !== toggleMic) {
    return window.toggleMic();
  }
  // Fallback if voice.js not yet loaded
  AppState.micOn = !AppState.micOn;
  const btn  = document.getElementById('btn-mic');
  const icon = btn?.querySelector('.taskbar-icon');
  if (btn)  btn.classList.toggle('muted', !AppState.micOn);
  if (icon) icon.textContent = AppState.micOn ? '🎤' : '🔇';

  if (typeof setVoiceMute === 'function') {
    setVoiceMute(!AppState.micOn);
  }
}

function toggleCam() {
  AppState.camOn = !AppState.camOn;
  const btn  = document.getElementById('btn-cam');
  const icon = btn?.querySelector('.taskbar-icon');
  if (btn)  btn.classList.toggle('muted', !AppState.camOn);
  if (icon) icon.textContent = AppState.camOn ? '📹' : '🚫';
}

/* ─ Chat fly-out ─────────────────────────────────────────────── */
function toggleChat() {
  AppState.chatOpen = !AppState.chatOpen;
  const panel = document.getElementById('chat-panel');
  const btn   = document.getElementById('btn-chat');
  if (panel) panel.classList.toggle('open', AppState.chatOpen);
  if (btn)   btn.classList.toggle('active-tool', AppState.chatOpen);

  // Scroll to bottom when opening
  if (AppState.chatOpen) {
    const messages = document.getElementById('chat-messages');
    if (messages) setTimeout(() => { messages.scrollTop = messages.scrollHeight; }, 50);
  }
}

/* ═══════════════════════════════════════════════════════════════
   SUITE MEMBER PRESENCE (Real-time Online/Offline tracking)
   ═══════════════════════════════════════════════════════════════ */
let _suitePresenceRef       = null;
let _suitePresenceListener  = null;
let _suiteConnectedListener = null;
let _currentPresenceSuiteId = null;

/**
 * Connect to RTDB presence and announce active online status for the suite
 */
async function initSuitePresence(suiteId) {
  cleanupSuitePresence();
  if (!suiteId || !AppState.currentUser) return;

  _currentPresenceSuiteId = suiteId;
  const user = AppState.currentUser;
  const suite = AppState.currentSuite;
  const isHost = suite && (suite.ownerUid === user.uid || suite.hostUid === user.uid);

  console.log(`[Presence] suiteId=${suiteId}`);
  console.log(`[Presence] currentUid=${user.uid}`);
  console.log(`[Presence] member path=suites/${suiteId}/presence`);

  // Optimistically set own presence in local map immediately so UI instantly renders self as Online
  window._suitePresenceMap = window._suitePresenceMap || {};
  window._suitePresenceMap[user.uid] = {
    uid: user.uid,
    name: user.name || 'User',
    isHost: isHost,
    online: true,
    onlineAt: Date.now(),
  };
  if (typeof updateWorkspaceMembers === 'function') updateWorkspaceMembers();

  if (!window.fsRtdb) {
    return;
  }

  // Ensure Firebase client SDK is authenticated before writing presence to RTDB
  if (typeof window.ensureFirebaseAuth === 'function') {
    await window.ensureFirebaseAuth(user.uid).catch(() => {});
  } else if (window.fsAuth && (!window.fsAuth.currentUser || window.fsAuth.currentUser.uid !== user.uid)) {
    if (typeof window.authenticateFirebaseClient === 'function') {
      await window.authenticateFirebaseClient(user.uid).catch(() => {});
    }
  }

  if (_currentPresenceSuiteId !== suiteId) return; // Guard against race if suite changed

  const connectedRef    = window.fsRtdb.ref('.info/connected');
  const userPresenceRef = window.fsRtdb.ref(`suites/${suiteId}/presence/${user.uid}`);
  _suitePresenceRef     = userPresenceRef;

  // Immediate presence write
  try {
    userPresenceRef.onDisconnect().remove();
    userPresenceRef.set({
      uid: user.uid,
      name: user.name || 'User',
      isHost: isHost,
      online: true,
      onlineAt: Date.now(),
    }).catch((e) => {
      console.warn('[Presence] RTDB presence set warning:', e.message);
    });
  } catch (_) {}

  // 1. Hook to .info/connected for automatic disconnect & reconnect handling
  _suiteConnectedListener = connectedRef.on('value', (snap) => {
    if (snap.val() === true) {
      userPresenceRef.onDisconnect().remove();
      userPresenceRef.set({
        uid: user.uid,
        name: user.name || 'User',
        isHost: isHost,
        online: true,
        onlineAt: Date.now(),
      }).catch(() => {});
    }
  });

  // 2. Real-time suite-level presence listener for all active members
  const suitePresenceRef = window.fsRtdb.ref(`suites/${suiteId}/presence`);
  _suitePresenceListener = suitePresenceRef.on('value', (snap) => {
    const data = snap.val() || {};
    // Keep own presence online if active in this suite
    if (_currentPresenceSuiteId === suiteId && user && user.uid && !data[user.uid]) {
      data[user.uid] = {
        uid: user.uid,
        name: user.name || 'User',
        isHost: isHost,
        online: true,
        onlineAt: Date.now(),
      };
    }
    const memberUids = Object.keys(data);
    console.log(`[Presence] members received=${memberUids.length} uids=${JSON.stringify(memberUids)}`);

    window._suitePresenceMap = data;
    if (typeof updateWorkspaceMembers === 'function') {
      updateWorkspaceMembers();
    }
    // Update active private chat peer status indicator in real time if open
    const statusEl = document.getElementById('pc-peer-status');
    if (statusEl && typeof _pcPeerId !== 'undefined' && _pcPeerId) {
      const isPeerOnline = !!(data[_pcPeerId] && data[_pcPeerId].online);
      statusEl.innerHTML = isPeerOnline
        ? '<span style="color:var(--fl-green, #16a34a);font-weight:600;">● Online</span>'
        : '<span style="color:var(--fl-text-muted, #64748b);">○ Offline</span>';
    }
  });

  suitePresenceRef.on('child_added', (childSnap) => {
    console.log(`[Presence] member added=${childSnap.key}`);
  });
  suitePresenceRef.on('child_removed', (childSnap) => {
    console.log(`[Presence] member removed=${childSnap.key}`);
  });
}

/**
 * Disconnect and remove active presence when leaving the suite
 */
function cleanupSuitePresence() {
  if (_suitePresenceRef) {
    try { _suitePresenceRef.remove(); } catch (_) {}
    _suitePresenceRef = null;
  }
  if (_suiteConnectedListener && window.fsRtdb) {
    try { window.fsRtdb.ref('.info/connected').off('value', _suiteConnectedListener); } catch (_) {}
    _suiteConnectedListener = null;
  }
  if (_suitePresenceListener && window.fsRtdb && _currentPresenceSuiteId) {
    try { window.fsRtdb.ref(`suites/${_currentPresenceSuiteId}/presence`).off('value', _suitePresenceListener); } catch (_) {}
    _suitePresenceListener = null;
  }
  _currentPresenceSuiteId = null;
  window._suitePresenceMap = {};
  // Clear the cached member list so stale members from this suite
  // do not bleed into the next suite that gets opened.
  window._cachedWorkspaceMembers = [];
  if (typeof updateWorkspaceMembers === 'function') {
    updateWorkspaceMembers([]);
  }
}

window.initSuitePresence    = initSuitePresence;
window.cleanupSuitePresence = cleanupSuitePresence;
window.addEventListener('beforeunload', cleanupSuitePresence);
window.addEventListener('pagehide', cleanupSuitePresence);

// Re-establish presence and video signaling when client authentication succeeds
window.addEventListener('firebaseAuthReady', function() {
  const suite = window.AppState && window.AppState.currentSuite;
  const user = window.AppState && window.AppState.currentUser;
  if (suite && suite.id && window.AppState.wsCurrentState) {
    initSuitePresence(suite.id);
    if (user && user.uid && typeof initVideoCall === 'function') {
      initVideoCall(suite.id, user.uid, user.name);
    }
  }
});

/* ─ Real-time Chat (Firebase Firestore) ──────────────────────── */
let _chatUnsubscribe   = null;   // Firestore onSnapshot unsubscribe handle
let _chatRenderedIds   = new Set(); // Track rendered message IDs to prevent duplicates

/**
 * Initialize suite chat: load history and subscribe to new messages.
 * Uses Firebase Client SDK Firestore (window.fsDb).
 */
function initSuiteChat(suiteId) {
  // Clean up any previous listener
  cleanupSuiteChat();
  _chatRenderedIds.clear();

  // Clear placeholder messages from HTML
  const messages = document.getElementById('chat-messages');
  if (messages) messages.innerHTML = '';

  // Check if Firebase client SDK is available
  if (typeof window.fsDb === 'undefined') {
    console.warn('[Chat] Firebase client DB not available. Chat will be local-only.');
    return;
  }

  try {
    const messagesRef = window.fsDb
      .collection('suites')
      .doc(suiteId)
      .collection('messages')
      .orderBy('timestamp', 'asc')
      .limitToLast(100);

    _chatUnsubscribe = messagesRef.onSnapshot(snapshot => {
      snapshot.docChanges().forEach(change => {
        if (change.type === 'added') {
          const msg = { id: change.doc.id, ...change.doc.data() };
          _renderChatMessage(msg);
        }
      });
    }, err => {
      console.error('[Chat] Snapshot error:', err.message);
    });

  } catch (e) {
    console.error('[Chat] Failed to init chat listener:', e.message);
  }
}

/** Render a single message into the chat panel */
function _renderChatMessage(msg) {
  if (_chatRenderedIds.has(msg.id)) return; // Prevent duplicates
  _chatRenderedIds.add(msg.id);

  const messages = document.getElementById('chat-messages');
  if (!messages) return;

  const isOwn = AppState.currentUser && msg.senderUid === AppState.currentUser.uid;
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble${isOwn ? ' own' : ''}`;
  bubble.dataset.msgId = msg.id;

  // Format timestamp
  let timeStr = '';
  if (msg.timestamp) {
    const ts = msg.timestamp.toDate ? msg.timestamp.toDate() : new Date(msg.timestamp);
    timeStr = ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  bubble.innerHTML = `
    <div class="chat-sender">${escapeHtml(msg.senderName || 'Unknown')}${timeStr ? `<span style="font-size:0.7rem;color:var(--c-mutedgray);margin-left:6px;">${timeStr}</span>` : ''}</div>
    ${escapeHtml(msg.text)}
  `;

  messages.appendChild(bubble);
  messages.scrollTop = messages.scrollHeight;
}

/** Cleanup chat Firestore listener */
function cleanupSuiteChat() {
  if (_chatUnsubscribe) {
    try { _chatUnsubscribe(); } catch (_) {}
    _chatUnsubscribe = null;
  }
  _chatRenderedIds.clear();
}

/** Send a chat message — saves to Firestore */
async function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const text  = input ? input.value.trim() : '';
  if (!text) {
    if (typeof showToast === 'function') showToast('main-toast', '⚠️ Cannot send an empty message.', 'dark');
    return;
  }

  const user  = AppState.currentUser;
  const suite = AppState.currentSuite;

  // If Firebase is available, write to Firestore
  if (typeof window.fsDb !== 'undefined' && suite && suite.id) {
    // Ensure Firebase client SDK authentication matches current user
    if (user && user.uid && window.fsAuth && (!window.fsAuth.currentUser || window.fsAuth.currentUser.uid !== user.uid)) {
      if (typeof window.authenticateFirebaseClient === 'function') {
        try {
          await window.authenticateFirebaseClient(user.uid);
        } catch (_) {}
      }
    }

    const msg = {
      text,
      senderUid:  user ? user.uid  : (window.fsAuth && window.fsAuth.currentUser ? window.fsAuth.currentUser.uid : 'anon'),
      senderName: user ? (user.name || 'User') : 'Anonymous',
      timestamp:  firebase.firestore.FieldValue.serverTimestamp(),
    };

    try {
      await window.fsDb
        .collection('suites')
        .doc(suite.id)
        .collection('messages')
        .add(msg);
      // SUCCESS: clear input only after confirmed write
      if (input) input.value = '';
    } catch (err) {
      console.error('[Chat] Failed to send message:', err.message);
      if (typeof showToast === 'function') {
        showToast('main-toast', '⚠️ Failed to send message: ' + (err.message || 'Unknown error'), 'dark');
      }
      // Keep the typed message in input on failure
    }
  } else {
    // Firebase not available — show locally
    if (input) input.value = '';
    _renderLocalMessage(text, user);
  }
}

/** Fallback: show a message locally only (when Firestore not available) */
function _renderLocalMessage(text, user) {
  const messages = document.getElementById('chat-messages');
  if (!messages) return;
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble own';
  bubble.innerHTML = `<div class="chat-sender">${escapeHtml(user?.name || 'You')}</div>${escapeHtml(text)}`;
  messages.appendChild(bubble);
  messages.scrollTop = messages.scrollHeight;
}

/* ─ Private suite admission & Join Requests ─────────────────── */
let _joinRequestPollTimer = null;

async function loadSuiteJoinRequests(suiteId) {
  if (!suiteId || typeof API === 'undefined' || typeof API.getJoinRequests !== 'function') return;
  const suite = AppState.currentSuite;
  const user  = AppState.currentUser;
  if (!suite || !user) return;

  const isHost = (suite.hostUid === user.uid || suite.ownerUid === user.uid);
  const adminUids = Array.isArray(suite.adminUids) ? suite.adminUids : [];
  const isAdmin = adminUids.includes(user.uid);

  // Only host or admins can view join requests
  if (!isHost && !isAdmin) {
    const jr = document.getElementById('join-request-container');
    if (jr) jr.style.display = 'none';
    return;
  }

  try {
    const res = await API.getJoinRequests(suiteId);
    const container = document.getElementById('join-request-container');
    if (!container) return;

    if (res && res.success && Array.isArray(res.requests) && res.requests.length > 0) {
      container.style.display = 'block';
      const reqListHtml = res.requests.map(req => {
        const initial = (req.requesterName || '?')[0].toUpperCase();
        return `
          <div class="join-request-badge" id="req-card-${escapeHtml(req.id)}" style="margin-bottom:0.5rem;">
            <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.6rem;">
              <div style="width:30px;height:30px;border-radius:50%;background:linear-gradient(135deg,var(--c-slate,#64748b),var(--c-mutedgray,#94a3b8));display:flex;align-items:center;justify-content:center;color:#fff;font-size:0.8rem;font-weight:700;">${initial}</div>
              <div>
                <div style="font-size:0.84rem;font-weight:700;color:#856404;">${escapeHtml(req.requesterName || 'User')}</div>
                <div style="font-size:0.76rem;color:#856404;">${escapeHtml(req.requesterEmail || 'Wants to join')}</div>
              </div>
            </div>
            <div style="display:flex;gap:0.5rem;">
              <button class="btn-green-sm" style="flex:1;cursor:pointer;" onclick="admitMemberRequest('${escapeHtml(req.id)}', '${escapeHtml(req.requesterName || '')}')">✓ Admit</button>
              <button class="btn-red-sm" style="flex:1;cursor:pointer;" onclick="rejectMemberRequest('${escapeHtml(req.id)}', '${escapeHtml(req.requesterName || '')}')">✕ Reject</button>
            </div>
          </div>`;
      }).join('');

      container.innerHTML = `<div class="section-label" style="color:#856404;font-size:0.75rem;font-weight:700;margin-bottom:4px;">Pending Requests (${res.requests.length})</div>` + reqListHtml;
    } else {
      container.style.display = 'none';
      container.innerHTML = '';
    }
  } catch (err) {
    console.warn('[JoinRequests] Failed to load join requests:', err);
  }
}

async function admitMemberRequest(requestId, requesterName) {
  const suite = AppState.currentSuite;
  if (!suite || !suite.id) return;
  try {
    const res = await API.approveJoinRequest(suite.id, requestId);
    if (res && res.success) {
      showToast('main-toast', `✅ ${requesterName || 'Member'} has been admitted!`, 'green');
      // Refresh join requests & member list
      loadSuiteJoinRequests(suite.id);
      if (typeof API.getSuiteMembers === 'function') {
        const memRes = await API.getSuiteMembers(suite.id);
        if (memRes && memRes.success && typeof updateWorkspaceMembers === 'function') {
          updateWorkspaceMembers(memRes.members);
        }
      }
    } else {
      showToast('main-toast', res.error || 'Failed to admit member', 'dark');
    }
  } catch (err) {
    showToast('main-toast', err.message || 'Error admitting member', 'dark');
  }
}

async function rejectMemberRequest(requestId, requesterName) {
  const suite = AppState.currentSuite;
  if (!suite || !suite.id) return;
  try {
    const res = await API.rejectJoinRequest(suite.id, requestId);
    if (res && res.success) {
      showToast('main-toast', `✕ Request from ${requesterName || 'user'} rejected.`);
      loadSuiteJoinRequests(suite.id);
    } else {
      showToast('main-toast', res.error || 'Failed to reject request', 'dark');
    }
  } catch (err) {
    showToast('main-toast', err.message || 'Error rejecting request', 'dark');
  }
}

// Backward compatibility stubs for UI elements calling legacy admitMember/rejectMember
function admitMember() {
  const suite = AppState.currentSuite;
  if (suite && suite.id) loadSuiteJoinRequests(suite.id);
}
function rejectMember() {
  const suite = AppState.currentSuite;
  if (suite && suite.id) loadSuiteJoinRequests(suite.id);
}

/* ─ Suite Settings Modal (Host editable, all can view) ───────── */
function openSuiteSettingsModal() {
  const suite = AppState.currentSuite;
  const user  = AppState.currentUser;
  if (!suite) {
    showToast('main-toast', 'No active suite selected', 'dark');
    return;
  }

  const nameInput = document.getElementById('sett-suite-name');
  const hostInput = document.getElementById('sett-suite-host');
  const createdInput = document.getElementById('sett-suite-created');
  const limitVal = document.getElementById('sett-admin-limit-val');
  const limitHidden = document.getElementById('sett-admin-limit');
  const currentCountEl = document.getElementById('sett-admin-current');
  const allowedCountEl = document.getElementById('sett-admin-allowed');
  const saveBtn = document.getElementById('btn-save-suite-settings');
  const errAlert = document.getElementById('sett-error-alert');
  const nameHint = document.getElementById('sett-suite-name-hint');
  const adminHint = document.getElementById('sett-admin-hint');
  const decBtn = document.getElementById('sett-admin-dec');
  const incBtn = document.getElementById('sett-admin-inc');

  if (errAlert) {
    errAlert.classList.add('hidden');
    errAlert.textContent = '';
  }

  // 1. Suite Name
  if (nameInput) {
    nameInput.value = suite.name || '';
  }

  // 2. Suite Host Name
  if (hostInput) {
    hostInput.value = suite.hostName || suite.ownerName || 'Host';
  }

  // 3. Created Date and Time
  if (createdInput) {
    let createdStr = 'Unknown';
    if (suite.createdAt) {
      const dt = typeof suite.createdAt === 'number' ? new Date(suite.createdAt) : new Date(suite.createdAt._seconds ? suite.createdAt._seconds * 1000 : suite.createdAt);
      createdStr = !isNaN(dt.getTime()) ? dt.toLocaleString() : String(suite.createdAt);
    }
    createdInput.value = createdStr;
  }

  // 4. Admin Limit & Current Admin Count
  const currentAdmins = Array.isArray(suite.adminUids) ? suite.adminUids.length : 0;
  const adminLimit = typeof suite.adminLimit === 'number' ? suite.adminLimit : 3;

  if (currentCountEl) currentCountEl.textContent = currentAdmins;
  if (allowedCountEl) allowedCountEl.textContent = adminLimit;
  if (limitVal) limitVal.textContent = adminLimit;
  if (limitHidden) limitHidden.value = adminLimit;

  // Permissions: Host vs Admin/Member
  const isHost = (user && (suite.hostUid === user.uid || suite.ownerUid === user.uid));
  if (nameInput) nameInput.disabled = !isHost;
  if (nameHint) nameHint.style.display = isHost ? 'none' : 'block';
  if (adminHint) adminHint.style.display = isHost ? 'none' : 'block';
  if (decBtn) decBtn.disabled = !isHost;
  if (incBtn) incBtn.disabled = !isHost;
  if (saveBtn) saveBtn.style.display = isHost ? 'block' : 'none';

  if (typeof openModal === 'function') {
    openModal('modal-suite-settings');
  }
}

function stepSettingsAdminLimit(delta) {
  const suite = AppState.currentSuite;
  const user  = AppState.currentUser;
  const isHost = (user && suite && (suite.hostUid === user.uid || suite.ownerUid === user.uid));
  if (!isHost) return;

  const currentAdmins = (suite && Array.isArray(suite.adminUids)) ? suite.adminUids.length : 0;
  const limitHidden = document.getElementById('sett-admin-limit');
  const limitVal = document.getElementById('sett-admin-limit-val');
  const allowedCountEl = document.getElementById('sett-admin-allowed');
  const errAlert = document.getElementById('sett-error-alert');

  let cur = parseInt(limitHidden ? limitHidden.value : (limitVal ? limitVal.textContent : '3'), 10) || 3;
  let next = cur + delta;

  // Minimum allowed: 1, and cannot reduce below current appointed admins count
  if (next < 1) next = 1;
  if (next > 20) next = 20;

  if (next < currentAdmins) {
    if (errAlert) {
      errAlert.textContent = `Cannot reduce admin limit to ${next}. There are currently ${currentAdmins} admins appointed. Demote ${currentAdmins - next} admin(s) first.`;
      errAlert.classList.remove('hidden');
    }
    return;
  }

  if (errAlert) {
    errAlert.classList.add('hidden');
    errAlert.textContent = '';
  }

  if (limitHidden) limitHidden.value = next;
  if (limitVal) limitVal.textContent = next;
  if (allowedCountEl) allowedCountEl.textContent = next;
}

async function saveSuiteSettings() {
  const suite = AppState.currentSuite;
  const user  = AppState.currentUser;
  const isHost = (user && suite && (suite.hostUid === user.uid || suite.ownerUid === user.uid));
  if (!isHost) {
    showToast('main-toast', 'Only the suite host can modify settings', 'dark');
    return;
  }

  const nameInput = document.getElementById('sett-suite-name');
  const limitHidden = document.getElementById('sett-admin-limit');
  const errAlert = document.getElementById('sett-error-alert');
  const saveBtn = document.getElementById('btn-save-suite-settings');

  const newName = (nameInput?.value || '').trim();
  const newLimit = parseInt(limitHidden?.value || '3', 10);

  if (!newName) {
    if (errAlert) {
      errAlert.textContent = 'Suite name cannot be empty.';
      errAlert.classList.remove('hidden');
    }
    return;
  }

  if (errAlert) errAlert.classList.add('hidden');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

  try {
    const res = await API.updateSuiteSettings(suite.id, {
      name: newName,
      adminLimit: newLimit
    });

    if (res && res.success) {
      showToast('main-toast', '✓ Suite settings updated!', 'green');
      suite.name = res.suite?.name || newName;
      suite.adminLimit = res.suite?.adminLimit !== undefined ? res.suite.adminLimit : newLimit;
      AppState.saveSuite(suite);

      // Update workspace header title
      const nameEl = document.getElementById('ws-suite-name');
      if (nameEl) nameEl.textContent = suite.name;

      if (typeof closeModal === 'function') closeModal('modal-suite-settings');
    } else {
      if (errAlert) {
        errAlert.textContent = res.error || 'Failed to update settings';
        errAlert.classList.remove('hidden');
      }
    }
  } catch (err) {
    if (errAlert) {
      errAlert.textContent = err.message || 'Error updating suite settings';
      errAlert.classList.remove('hidden');
    }
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
  }
}

window.loadSuiteJoinRequests = loadSuiteJoinRequests;
window.admitMemberRequest = admitMemberRequest;
window.rejectMemberRequest = rejectMemberRequest;
window.admitMember = admitMember;
window.rejectMember = rejectMember;
window.openSuiteSettingsModal = openSuiteSettingsModal;
window.stepSettingsAdminLimit = stepSettingsAdminLimit;
window.saveSuiteSettings = saveSuiteSettings;

/* ─ Google Drive integration ─────────────────────────────────── */
function linkDriveFile(type, filename) {
  const icons = { PDF:'📄', DOCX:'📝', PPTX:'📊', IMG:'🖼️' };
  showToast('main-toast', `☁️ Linked ${type}: ${filename}`);
  const iconEl = document.getElementById('doc-type-icon');
  const nameEl = document.getElementById('doc-file-name');
  const metaEl = document.getElementById('doc-file-meta');
  if (iconEl) iconEl.textContent = icons[type] || '📄';
  if (nameEl) nameEl.textContent = filename;
  if (metaEl) metaEl.textContent = `${type} · Synced from Google Drive`;
  setWSState('docs');
}

/* ─ Doc navigation ───────────────────────────────────────────── */
function changeDocPage(delta) {
  AppState.docPage = Math.max(1, Math.min(AppState.DOC_PAGES, AppState.docPage + delta));
  const ind = document.getElementById('doc-page-indicator');
  if (ind) ind.textContent = `Page ${AppState.docPage} of ${AppState.DOC_PAGES}`;
}

/* ─ Invite link ──────────────────────────────────────────────── */
// copyInviteLink() and showInviteModal() are implemented in invite.js
// which overrides these stubs at runtime.
function copyInviteLink() {
  const text = document.getElementById('invite-link-text')?.textContent || location.href;
  copyToClipboard(text);
  showToast('copy-toast', '✓ Invite link copied!', 'green');
}

function showInviteModal() { openModal('modal-ws-invite'); }

/* -- Live Media Status, Screen Share Toggle, & Voice Session Controls -- */
setInterval(function() {
  var isCamOn = (typeof _vcInCall !== 'undefined' && _vcInCall && (typeof _vcCameraOff === 'undefined' || !_vcCameraOff));
  var isVoiceActive = (typeof _voiceActive !== 'undefined' && _voiceActive) || (typeof window._voiceActive !== 'undefined' && window._voiceActive);

  // Update Live Media Status Indicator (Clean Light CoLearn Theme)
  var statusEl = document.getElementById('live-media-status');
  if (statusEl) {
    if (typeof _ssIsPresenting !== 'undefined' && _ssIsPresenting) {
      statusEl.className = '';
      statusEl.style.display = 'flex';
      statusEl.innerHTML = '<div class="blink-dot" style="background: #2563eb;"></div> ' +
        '<span style="color:#0f172a;font-weight:700;font-size:0.85rem;white-space:nowrap;">Screen Sharing</span> ' +
        '<button class="fl-btn fl-btn-danger fl-btn-xs" onclick="stopScreenShare()" style="margin-left:6px;padding:4px 14px;font-size:0.78rem;border-radius:12px;background:#dc2626;color:#fff;border:none;cursor:pointer;font-weight:700;white-space:nowrap;flex-shrink:0;" title="Stop Screen Sharing">Stop Sharing</button>';
    } else if (isCamOn) {
      statusEl.className = '';
      statusEl.style.display = 'flex';
      statusEl.innerHTML = '<div class="blink-dot" style="background: #dc2626;"></div> ' +
        '<span style="color:#0f172a;font-weight:700;font-size:0.85rem;white-space:nowrap;">Video Active</span> ' +
        '<button class="fl-btn fl-btn-danger fl-btn-xs" onclick="leaveVideoCall()" style="margin-left:6px;padding:4px 14px;font-size:0.78rem;border-radius:12px;background:#dc2626;color:#fff;border:none;cursor:pointer;font-weight:700;white-space:nowrap;flex-shrink:0;" title="End Video Call">End Call</button>';
    } else if (isVoiceActive) {
      var isMuted = (typeof _voiceMuted !== 'undefined') ? _voiceMuted : (window._voiceMuted !== false);
      var micLabel = !isMuted ? 'Mic ON' : 'Mic OFF';
      var micBtnLabel = !isMuted ? 'Mute' : 'Unmute';
      statusEl.className = '';
      statusEl.style.display = 'flex';
      statusEl.innerHTML = '<div class="blink-dot" style="background: #16a34a;"></div> ' +
        '<span style="color:#0f172a;font-weight:700;font-size:0.85rem;white-space:nowrap;">Voice Call (' + micLabel + ')</span> ' +
        '<button class="fl-btn fl-btn-outline fl-btn-xs" onclick="toggleMic()" style="margin-left:4px;padding:3px 10px;font-size:0.75rem;border-radius:12px;cursor:pointer;font-weight:600;white-space:nowrap;flex-shrink:0;" title="Toggle Microphone">' + micBtnLabel + '</button> ' +
        '<button class="fl-btn fl-btn-danger fl-btn-xs" onclick="endVoiceCall()" style="margin-left:4px;padding:4px 14px;font-size:0.78rem;border-radius:12px;background:#dc2626;color:#ffffff;border:none;cursor:pointer;font-weight:700;white-space:nowrap;flex-shrink:0;box-shadow:0 1px 4px rgba(220,38,38,0.3);" title="End Voice Call">End Call</button>';
    } else {
      statusEl.className = 'hidden';
      statusEl.style.display = 'none';
      statusEl.innerHTML = '';
    }
  }

  // Update Screen Share Button Toggle in Toolbar
  var ssBtn = document.getElementById('tb-btn-screen-share');
  if (ssBtn) {
    if (typeof AppState !== 'undefined' && AppState.wsCurrentState === 'whiteboard') {
      ssBtn.style.display = 'none';
    } else {
      ssBtn.style.display = '';
      if (typeof _ssIsPresenting !== 'undefined' && _ssIsPresenting) {
        ssBtn.title = 'Stop Screen Share';
        ssBtn.style.color = '#dc2626';
        ssBtn.classList.add('active-tool');
        ssBtn.onclick = function() { if (typeof stopScreenShare === 'function') stopScreenShare(); };
      } else {
        ssBtn.title = 'Screen Share';
        ssBtn.style.color = 'var(--fl-text-hi, #333)';
        ssBtn.classList.remove('active-tool');
        ssBtn.onclick = function() { if (typeof startScreenShare === 'function') startScreenShare(); };
      }
    }
  }

  // Update Room Hub cards with light/neutral theme (no large red cards)
  var hubVoiceCard = document.getElementById('hub-card-voice');
  if (hubVoiceCard) {
    if (isVoiceActive) {
      hubVoiceCard.textContent = 'Voice Call Active';
      hubVoiceCard.style.background = '';
      hubVoiceCard.style.color = '';
      hubVoiceCard.onclick = function() { if (typeof endVoiceCall === 'function') endVoiceCall(); };
    } else {
      hubVoiceCard.textContent = 'Start Voice';
      hubVoiceCard.style.background = '';
      hubVoiceCard.style.color = '';
      hubVoiceCard.onclick = function() { if (typeof startVoiceCall === 'function') startVoiceCall(); };
    }
  }

  var rhVoiceBtn = document.getElementById('room-hub-voice-btn');
  var rhVoiceLabel = document.getElementById('room-hub-voice-label');
  var rhVoiceDesc = document.getElementById('room-hub-voice-desc');
  if (rhVoiceBtn && rhVoiceLabel && rhVoiceDesc) {
    if (isVoiceActive) {
      rhVoiceBtn.style.background = '';
      rhVoiceBtn.style.borderColor = '';
      rhVoiceBtn.style.color = '';
      rhVoiceLabel.textContent = 'Voice Call Active';
      rhVoiceDesc.textContent = 'Voice session in progress';
      rhVoiceDesc.style.color = '';
      rhVoiceBtn.onclick = function() { if (typeof endVoiceCall === 'function') endVoiceCall(); };
    } else {
      rhVoiceBtn.style.background = '';
      rhVoiceBtn.style.borderColor = '';
      rhVoiceBtn.style.color = '';
      rhVoiceLabel.textContent = 'Voice Only';
      rhVoiceDesc.textContent = 'Join with microphone';
      rhVoiceDesc.style.color = '';
      rhVoiceBtn.onclick = function() { if (typeof startVoiceCall === 'function') startVoiceCall(); };
    }
  }

  var hubScreenCard = document.getElementById('hub-card-screen');
  if (hubScreenCard) {
    if (typeof _ssIsPresenting !== 'undefined' && _ssIsPresenting) {
      hubScreenCard.textContent = 'Screenshare (Sharing)';
      hubScreenCard.style.background = '';
      hubScreenCard.style.color = '';
      hubScreenCard.onclick = function() { if (typeof stopScreenShare === 'function') stopScreenShare(); };
    } else {
      hubScreenCard.textContent = 'Screenshare';
      hubScreenCard.style.background = '';
      hubScreenCard.style.color = '';
      hubScreenCard.onclick = function() { if (typeof startScreenShare === 'function') startScreenShare(); };
    }
  }

  // Update Sidebar active voice call bar
  var voiceBar = document.getElementById('active-voice-call-bar');
  if (voiceBar) {
    if (isVoiceActive) {
      voiceBar.style.display = 'flex';
      var voiceMicStatus = document.getElementById('voice-bar-mic-status');
      if (voiceMicStatus) {
        var isMuted = (typeof _voiceMuted !== 'undefined') ? _voiceMuted : (window._voiceMuted !== false);
        voiceMicStatus.textContent = !isMuted ? 'Mic ON (Speaking)' : 'Mic OFF (Muted)';
        voiceMicStatus.style.color = !isMuted ? '#16a34a' : '#3b82f6';
      }
    } else {
      voiceBar.style.display = 'none';
    }
  }

  // Toggle Bottom Toolbar Visibility based on Room Hub & Calls
  var toolbar = document.querySelector('.bottom-toolbar');
  if (toolbar && typeof AppState !== 'undefined') {
    var inVideo = (typeof _vcInCall !== 'undefined' && _vcInCall) || (document.getElementById('video-call-overlay') && !document.getElementById('video-call-overlay').classList.contains('hidden'));
    if (isVoiceActive) {
      // Hide the bottom circular CoLearn control bar completely during active Voice Call
      toolbar.style.display = 'none';
    } else if (inVideo) {
      toolbar.style.display = 'flex';
      if (AppState.wsCurrentState !== 'whiteboard') {
        toolbar.classList.remove('wb-auto-hidden');
        toolbar.classList.add('wb-auto-visible');
      }
    } else if (AppState.wsCurrentState === 'invite' || AppState.wsCurrentState === 'room-hub') {
      toolbar.style.display = 'none';
    } else if (AppState.wsCurrentState === 'whiteboard') {
      toolbar.style.display = 'flex';
    } else {
      toolbar.style.display = 'flex';
    }
  }
}, 400);
