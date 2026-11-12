/* ── video-call.js – CoLearn Video Call ───────────────────────
 *
 * Architecture: passive-first with clean active escalation.
 *
 * Every suite member joins the videoSignaling RTDB room passively
 * (receiveOnly: true) on suite entry. This allows receiving video
 * streams immediately when any member starts a call.
 *
 * When the user joins the video call:
 *  1. Camera + microphone stream is acquired via MediaManager.
 *  2. Active signaling room is joined with localStream.
 *  3. Offers are sent to all peers in the room.
 *  4. Video overlay is opened and tiles are rendered dynamically.
 *
 * Camera and Microphone toggling directly control track.enabled.
 * Leaving the call cleans up all tracks, connections, and listeners,
 * and restores passive reception.
 */

'use strict';

/* ── Module state ────────────────────────────────────────────── */
let _vcSuiteId      = null;
let _vcUserId       = null;
let _vcUserName     = null;
let _vcLocalStream  = null;
let _vcPassiveRoom  = null;
let _vcRoom         = null;
let _vcParticipants = {};  // { peerId: { stream, name, cameraOff } }
let _vcInitialised  = false;
let _vcInCall       = false;
let _vcMicMuted     = false;
let _vcCameraOff    = false;
let _vcPinnedPeer   = null;

/* ── Public: initVideoCall ───────────────────────────────────── */
async function initVideoCall(suiteId, userId, userName) {
  if (_vcInitialised && _vcSuiteId === suiteId) {
    console.info('[VideoCall] Already initialised for suite', suiteId);
    return;
  }
  _vcSuiteId     = suiteId;
  _vcUserId      = userId;
  _vcUserName    = userName;
  _vcInitialised = true;
  console.info(`[VideoCall] init — suite=${suiteId} user=${userId ? userId.slice(0,6) : 'anon'}`);

  if (typeof window.ensureFirebaseAuth === 'function') {
    await window.ensureFirebaseAuth(userId).catch(() => {});
  }
  await _joinVideoSignalingPassively();
}

/* ── Internal: passive join ──────────────────────────────────── */
async function _joinVideoSignalingPassively() {
  if (_vcPassiveRoom) {
    console.info('[VideoCall] Passive room already active — skipping duplicate join.');
    return;
  }
  if (!window.fsRtdb || !_vcSuiteId || !_vcUserId) {
    console.warn('[VideoCall] RTDB or suite credentials not available — passive join deferred.');
    return;
  }

  if (typeof window.ensureFirebaseAuth === 'function') {
    await window.ensureFirebaseAuth(_vcUserId).catch(() => {});
  }

  const path = 'suites/' + _vcSuiteId + '/videoSignaling';
  console.info(`[VideoCall] Joining videoSignaling passively (receiveOnly) — path=${path}`);

  try {
    _vcPassiveRoom = await RoomManager.join({
      roomPath:    path,
      myUid:       _vcUserId,
      myName:      _vcUserName,
      localStream: null,
      receiveOnly: true,
      onTrack:     _vcOnTrackPassive,
      onPeerLeft:  _vcOnPeerLeft,
    });

    if (_vcPassiveRoom) {
      console.info('[VideoCall] ✅ Passive signaling room joined. Ready to receive video.');
    }
  } catch (e) {
    console.error('[VideoCall] Passive join error:', e.message);
  }
}

/* ── Public: joinVideoCall ───────────────────────────────────── */
async function joinVideoCall() {
  if (typeof window.ensureFirebaseAuth === 'function') {
    const uid = (window.AppState && window.AppState.currentUser) ? window.AppState.currentUser.uid : _vcUserId;
    if (uid) await window.ensureFirebaseAuth(uid).catch(() => {});
  }

  if (!_vcInitialised) {
    if (window.AppState && window.AppState.currentSuite && window.AppState.currentUser) {
      await initVideoCall(window.AppState.currentSuite.id, window.AppState.currentUser.uid, window.AppState.currentUser.name);
    } else {
      if (typeof showToast === 'function') showToast('main-toast', '⚠️ Video call not ready yet.', 'dark');
      return;
    }
  }

  if (_vcInCall) {
    _showVCOverlay(true);
    return;
  }

  _updateCamBtnState(true, true);
  _setVCStatus('Requesting camera…');
  _showVCOverlay(true);

  // Acquire camera + mic stream
  _vcLocalStream = await MediaManager.getCameraAndMic();
  if (!_vcLocalStream) {
    _setVCStatus('Camera unavailable');
    _updateCamBtnState(false, false);
    _showVCOverlay(false);
    return;
  }

  console.info('[VideoCall] Camera stream acquired. Upgrading to active signaling.');
  _vcMicMuted  = false;
  _vcCameraOff = false;
  _vcInCall    = true;
  if (typeof AppState !== 'undefined') {
    AppState.camOn = true;
    AppState.activeCallState = 'video';
  }

  // Render local tile
  _renderVCLocalTile();

  // Leave passive room before joining active
  if (_vcPassiveRoom) {
    try { await _vcPassiveRoom.leave(); } catch (_) {}
    _vcPassiveRoom = null;
  }

  const path = 'suites/' + _vcSuiteId + '/videoSignaling';
  console.info(`[VideoCall] Joining videoSignaling as ACTIVE sender — path=${path}`);

  _vcRoom = await RoomManager.join({
    roomPath:    path,
    myUid:       _vcUserId,
    myName:      _vcUserName,
    localStream: _vcLocalStream,
    receiveOnly: false,
    onTrack:     _vcOnTrack,
    onPeerLeft:  _vcOnPeerLeft,
  });

  if (!_vcRoom) {
    if (typeof showToast === 'function') showToast('main-toast', '❌ Could not join video room.', 'dark');
    await _doLeaveVideoCall();
    return;
  }

  _setVCStatus('In call');
  _updateCamBtnState(true, false);
  window.addEventListener('beforeunload', cleanupVideoCall);
  console.info('[VideoCall] ✅ Active video call started.');
}

/* ── Public: leaveVideoCall ──────────────────────────────────── */
async function leaveVideoCall() {
  if (!_vcInCall) {
    _showVCOverlay(false);
    return;
  }
  await _doLeaveVideoCall();
  _joinVideoSignalingPassively();
}

/* ── Internal: full active-call teardown ─────────────────────── */
async function _doLeaveVideoCall() {
  _vcInCall = false;
  if (typeof AppState !== 'undefined') {
    AppState.camOn = false;
    if (AppState.activeCallState === 'video') AppState.activeCallState = null;
  }

  if (_vcRoom) {
    try { await _vcRoom.leave(); } catch (_) {}
    _vcRoom = null;
  }

  MediaManager.stopStream(_vcLocalStream);
  _vcLocalStream = null;

  const grid = document.getElementById('vc-grid');
  if (grid) grid.innerHTML = '';
  _vcParticipants = {};
  _vcPinnedPeer   = null;

  _showVCOverlay(false);
  _updateCamBtnState(false, false);

  window.removeEventListener('beforeunload', cleanupVideoCall);
  console.info('[VideoCall] Active call ended.');
}

/* ── Public: toggleVideoMic ──────────────────────────────────── */
function toggleVideoMic() {
  _vcMicMuted = !_vcMicMuted;
  if (_vcLocalStream) {
    _vcLocalStream.getAudioTracks().forEach(t => { t.enabled = !_vcMicMuted; });
  }
  if (typeof setVoiceMute === 'function') {
    setVoiceMute(_vcMicMuted);
  }
  _updateMicBtnState(_vcMicMuted);
  console.info(`[VideoCall] Mic ${_vcMicMuted ? 'muted' : 'unmuted'}`);
  return true;
}

/* ── Public: toggleVideoCamera ───────────────────────────────── */
async function toggleVideoCamera() {
  if (!_vcInCall) {
    await joinVideoCall();
    return;
  }

  _vcCameraOff = !_vcCameraOff;
  if (typeof AppState !== 'undefined') AppState.camOn = !_vcCameraOff;
  if (_vcLocalStream) {
    _vcLocalStream.getVideoTracks().forEach(t => { t.enabled = !_vcCameraOff; });
  }

  _updateCamBtnState(true, _vcCameraOff);
  _updateVCLocalTile();
  console.info(`[VideoCall] Camera ${_vcCameraOff ? 'off' : 'on'}`);
}

/* ── Public: pinParticipant ──────────────────────────────────── */
function pinParticipant(peerId) {
  if (_vcPinnedPeer === peerId) {
    _vcPinnedPeer = null;
    document.querySelectorAll('.vc-tile').forEach(t => t.classList.remove('pinned'));
    console.info('[VideoCall] Unpinned', peerId ? peerId.slice(0,6) : 'local');
  } else {
    _vcPinnedPeer = peerId;
    document.querySelectorAll('.vc-tile').forEach(t => t.classList.remove('pinned'));
    const safeId = peerId === 'local' ? 'local' : _vcSafeId(peerId);
    const tile = document.getElementById('vc-tile-' + safeId);
    if (tile) tile.classList.add('pinned');
    console.info('[VideoCall] Pinned', peerId ? peerId.slice(0,6) : 'local');
  }
}

/* ── Public: cleanupVideoCall ────────────────────────────────── */
async function cleanupVideoCall() {
  console.info('[VideoCall] Full cleanup (suite leave).');

  if (_vcInCall) await _doLeaveVideoCall();

  if (_vcPassiveRoom) {
    try { await _vcPassiveRoom.leave(); } catch (_) {}
    _vcPassiveRoom = null;
  }

  _vcInitialised = false;
  _vcParticipants = {};
}

/* ══════════════════════════════════════════════════════════════
   TRACK HANDLERS & TILE MANAGEMENT
   ══════════════════════════════════════════════════════════════ */

function _resolvePeerName(peerId) {
  if (window.AppState && window.AppState.currentSuite && Array.isArray(window.AppState.currentSuite.members)) {
    const member = window.AppState.currentSuite.members.find(m => (m.uid === peerId || m.id === peerId));
    if (member && member.name) return member.name;
  }
  if (window._cachedWorkspaceMembers && Array.isArray(window._cachedWorkspaceMembers)) {
    const member = window._cachedWorkspaceMembers.find(m => (m.uid === peerId || m.id === peerId));
    if (member && member.name) return member.name;
  }
  if (window._suitePresenceMap && window._suitePresenceMap[peerId] && window._suitePresenceMap[peerId].name) {
    return window._suitePresenceMap[peerId].name;
  }
  if (_vcParticipants[peerId] && _vcParticipants[peerId].name && _vcParticipants[peerId].name !== peerId) {
    return _vcParticipants[peerId].name;
  }
  return 'Member';
}

function _vcOnTrackPassive(peerId, stream, track) {
  console.info(`[VideoCall] 📹 PASSIVE onTrack ← ${peerId.slice(0,6)} (kind=${track ? track.kind : 'stream'})`);

  const peerName = _resolvePeerName(peerId);
  if (!_vcParticipants[peerId]) {
    _vcParticipants[peerId] = { stream: stream, name: peerName, cameraOff: false };
  } else {
    _vcParticipants[peerId].stream = stream;
    _vcParticipants[peerId].name = peerName;
  }

  _showVCOverlay(true);
  _setVCStatus('Receiving video…');

  _renderOrUpdateRemoteTile(peerId, stream, track);
}

function _vcOnTrack(peerId, stream, track) {
  console.info(`[VideoCall] 📹 ACTIVE onTrack ← ${peerId.slice(0,6)} (kind=${track ? track.kind : 'stream'})`);

  const peerName = _resolvePeerName(peerId);
  if (!_vcParticipants[peerId]) {
    _vcParticipants[peerId] = { stream: stream, name: peerName, cameraOff: false };
  } else {
    _vcParticipants[peerId].stream = stream;
    _vcParticipants[peerId].name = peerName;
  }

  _renderOrUpdateRemoteTile(peerId, stream, track);
}

function _renderOrUpdateRemoteTile(peerId, stream, track) {
  const grid = document.getElementById('vc-grid');
  if (!grid) return;

  const peerName = _resolvePeerName(peerId);
  const tileId = 'vc-tile-' + _vcSafeId(peerId);
  let tile = document.getElementById(tileId);

  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'vc-tile';
    tile.id = tileId;
    tile.onclick = () => pinParticipant(peerId);

    const video = document.createElement('video');
    video.autoplay    = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.srcObject   = stream;
    video.play().catch(() => {});
    tile.appendChild(video);

    const lbl = document.createElement('div');
    lbl.className = 'vc-tile-label';
    lbl.textContent = peerName;
    tile.appendChild(lbl);

    grid.appendChild(tile);
  } else {
    const video = tile.querySelector('video');
    if (video && video.srcObject !== stream) {
      video.srcObject = stream;
      video.play().catch(() => {});
    }
    const lbl = tile.querySelector('.vc-tile-label');
    if (lbl) lbl.textContent = peerName;
  }

  if (track && track.kind === 'video') {
    track.onmute = () => {
      console.info(`[VideoCall] Peer ${peerId.slice(0,6)} muted video track.`);
      const t = document.getElementById(tileId);
      if (t) {
        let av = t.querySelector('.vc-avatar-tile');
        if (!av) {
          av = _vcMakeAvatar(peerName, 'Camera Off');
          t.appendChild(av);
        }
        const v = t.querySelector('video');
        if (v) v.style.display = 'none';
      }
    };
    track.onunmute = () => {
      console.info(`[VideoCall] Peer ${peerId.slice(0,6)} unmuted video track.`);
      const t = document.getElementById(tileId);
      if (t) {
        const av = t.querySelector('.vc-avatar-tile');
        if (av) av.remove();
        const v = t.querySelector('video');
        if (v) v.style.display = 'block';
      }
    };
  }

  _updateVCGridLayout();
}

function _vcOnPeerLeft(peerId) {
  console.info(`[VideoCall] Peer left: ${peerId.slice(0,6)}`);
  delete _vcParticipants[peerId];

  const tile = document.getElementById('vc-tile-' + _vcSafeId(peerId));
  if (tile) {
    tile.style.opacity = '0';
    setTimeout(() => {
      tile.remove();
      _updateVCGridLayout();

      const grid = document.getElementById('vc-grid');
      if (grid && grid.querySelectorAll('.vc-tile').length === 0 && !_vcInCall) {
        _showVCOverlay(false);
        _setVCStatus('');
      }
    }, 200);
  }

  if (_vcPinnedPeer === peerId) _vcPinnedPeer = null;
}

/* ── Tile Rendering Helpers ──────────────────────────────────── */
function _renderVCLocalTile() {
  const grid = document.getElementById('vc-grid');
  if (!grid) return;
  const existing = document.getElementById('vc-tile-local');
  if (existing) existing.remove();

  const tile = document.createElement('div');
  tile.className = 'vc-tile';
  tile.id = 'vc-tile-local';
  tile.onclick = () => pinParticipant('local');

  if (!_vcCameraOff && _vcLocalStream) {
    const v = document.createElement('video');
    v.autoplay    = true;
    v.muted       = true;
    v.playsInline = true;
    v.srcObject   = _vcLocalStream;
    tile.appendChild(v);
  } else {
    tile.appendChild(_vcMakeAvatar(_vcUserName, 'Camera Off'));
  }

  const lbl = document.createElement('div');
  lbl.className = 'vc-tile-label';
  lbl.textContent = (_vcUserName || 'You') + ' (You)';
  tile.appendChild(lbl);

  grid.insertBefore(tile, grid.firstChild);
  _updateVCGridLayout();
}

function _updateVCLocalTile() {
  const tile = document.getElementById('vc-tile-local');
  if (!tile) return;
  tile.innerHTML = '';

  if (!_vcCameraOff && _vcLocalStream) {
    const v = document.createElement('video');
    v.autoplay = true; v.muted = true; v.playsInline = true;
    v.srcObject = _vcLocalStream;
    tile.appendChild(v);
  } else {
    tile.appendChild(_vcMakeAvatar(_vcUserName, 'Camera Off'));
  }

  const lbl = document.createElement('div');
  lbl.className = 'vc-tile-label';
  lbl.textContent = (_vcUserName || 'You') + ' (You)';
  tile.appendChild(lbl);
}

function _updateVCGridLayout() {
  const grid = document.getElementById('vc-grid');
  if (!grid) return;
  const count = grid.querySelectorAll('.vc-tile').length;
  grid.dataset.count = String(Math.min(count, 9));
  if (_vcInCall) {
    _setVCStatus(count > 1 ? count + ' participants' : 'Just you');
  }
}

function _vcMakeAvatar(name, sub) {
  const wrap = document.createElement('div');
  wrap.className = 'vc-avatar-tile';

  const av = document.createElement('div');
  av.className = 'member-avatar';
  av.textContent = (name || '?')[0].toUpperCase();
  wrap.appendChild(av);

  const n = document.createElement('div');
  n.style.fontWeight = '600';
  n.textContent = name || 'Unknown';
  wrap.appendChild(n);

  if (sub) {
    const s = document.createElement('div');
    s.style.cssText = 'font-size:0.75rem;opacity:0.75;margin-top:2px;';
    s.textContent = sub;
    wrap.appendChild(s);
  }
  return wrap;
}

/* ── UI state updaters ──────────────────────────────────────── */
function _showVCOverlay(show) {
  const el = document.getElementById('video-call-overlay');
  if (el) el.classList.toggle('hidden', !show);
  const toolbar = document.querySelector('.bottom-toolbar');
  if (toolbar) {
    if (show) {
      toolbar.style.display = 'flex';
      if (!window.AppState || window.AppState.wsCurrentState !== 'whiteboard') {
        toolbar.classList.remove('wb-auto-hidden');
        toolbar.classList.add('wb-auto-visible');
      }
    }
  }
}

function _setVCStatus(text) {
  const el = document.getElementById('vc-status');
  if (el) el.textContent = text;
}

function _updateCamBtnState(inCall, camOff) {
  const tbCam = document.getElementById('tb-btn-cam');
  if (tbCam) {
    if (!inCall) {
      tbCam.classList.remove('active-tool', 'muted');
      tbCam.style.color = 'var(--fl-text-hi, #333)';
      tbCam.title = 'Start Video Call';
    } else if (camOff) {
      tbCam.classList.add('muted');
      tbCam.style.color = '#dc3545';
      tbCam.title = 'Turn Camera On';
    } else {
      tbCam.classList.remove('muted');
      tbCam.classList.add('active-tool');
      tbCam.style.color = '#2563eb';
      tbCam.title = 'Turn Camera Off';
    }
  }
}

function _updateMicBtnState(muted) {
  const tbMic = document.getElementById('tb-btn-mic');
  if (tbMic) {
    tbMic.classList.toggle('muted', muted);
    tbMic.style.color = muted ? '#dc3545' : 'var(--fl-text-hi, #333)';
    tbMic.title = muted ? 'Unmute Microphone' : 'Mute Microphone';
  }
}

function _vcSafeId(id) {
  return (id || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

// Global window attachments
window.initVideoCall      = initVideoCall;
window.joinVideoCall      = joinVideoCall;
window.leaveVideoCall     = leaveVideoCall;
window.toggleVideoMic     = toggleVideoMic;
window.toggleVideoCamera  = toggleVideoCamera;
window.pinParticipant     = pinParticipant;
window.cleanupVideoCall   = cleanupVideoCall;
