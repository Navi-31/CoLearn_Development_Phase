/* ── voice.js – CoLearn Voice Chat ────────────────────────────
 *
 * Provides real-time microphone voice chat using WebRTC and RTDB signaling.
 * Coordinates with video-call.js so that microphone muting applies
 * uniformly across all audio senders.
 *
 * Default State:
 *   - Microphone starts OFF by default.
 *   - Entering a suite does NOT auto-request or enable the microphone.
 *   - Starting a voice call starts with microphone OFF until the user
 *     explicitly turns it ON.
 */

'use strict';

/* ── Module state ─────────────────────────────────────────────── */
let _voiceSuiteId       = null;
let _voiceUserId        = null;
let _voiceUserName      = null;
let _localStream        = null;     // MediaStream from mic
let _silentCtx          = null;     // AudioContext for silent track
let _room               = null;     // { signal, pcm, leave() } from RoomManager
let _audioElements      = {};       // { peerId: HTMLAudioElement }
let _analyserNodes      = {};       // { peerId: { analyser, source, rafId } }
let _voiceInitialised   = false;
let _voiceActive        = false;    // Whether user is in a voice call session
let _voiceMuted         = true;     // Microphone starts OFF (muted) by default
let _pendingAutoplay    = [];       // audio elements blocked by autoplay policy
let _autoplayUnlocked   = false;

/* ── Public: initVoice ───────────────────────────────────────── */
/**
 * Initializes voice module credentials for the suite.
 * Does NOT acquire the microphone or turn it on (mic is OFF by default).
 */
function initVoice(suiteId, userId, userName) {
  if (!suiteId || !userId) {
    console.warn('[Voice] Suite ID or credentials missing — voice deferred.');
    return;
  }

  _voiceSuiteId     = suiteId;
  _voiceUserId      = userId;
  _voiceUserName    = userName;
  _voiceInitialised = true;
  _voiceActive      = false;
  _voiceMuted       = true; // Starts OFF by default

  window._voiceInitialised = true;
  window._voiceActive      = false;
  window._voiceMuted       = true;

  if (typeof AppState !== 'undefined') {
    AppState.micOn = false;
  }

  _showVoiceStatus('muted');
  console.info(`[Voice] Initialised config for suite ${suiteId} (Microphone is OFF by default).`);
}

/* ── Public: startVoiceCall ──────────────────────────────────── */
/**
 * Starts a voice call session.
 * Connects to voice signaling with microphone OFF by default.
 */
async function startVoiceCall() {
  if (!_voiceInitialised) {
    if (window.AppState && window.AppState.currentSuite && window.AppState.currentUser) {
      initVoice(window.AppState.currentSuite.id, window.AppState.currentUser.uid, window.AppState.currentUser.name);
    } else {
      if (typeof showToast === 'function') showToast('main-toast', '⚠️ Voice chat not ready.', 'dark');
      return;
    }
  }

  if (_voiceActive) {
    if (typeof showToast === 'function') showToast('main-toast', '📞 Voice session already active.', 'dark');
    return;
  }

  _voiceActive = true;
  _voiceMuted  = true; // Start with mic OFF
  window._voiceActive = true;
  window._voiceMuted  = true;

  if (typeof AppState !== 'undefined') {
    AppState.activeCallState = 'voice';
    AppState.micOn = false;
  }

  await _ensureVoiceRoom();
  _showVoiceStatus('muted');

  if (typeof showToast === 'function') {
    showToast('main-toast', '📞 Voice session active (Microphone is OFF). Click Mic to unmute.', 'dark');
  }
}

/* ── Public: endVoiceCall ────────────────────────────────────── */
/**
 * Ends the active voice call session.
 * Stops microphone tracks, leaves signaling, and resets state without leaving the suite.
 */
async function endVoiceCall() {
  console.info('[Voice] Ending voice call session...');
  _voiceActive = false;
  _voiceMuted  = true;
  window._voiceActive = false;
  window._voiceMuted  = true;

  if (typeof AppState !== 'undefined') {
    if (AppState.activeCallState === 'voice') {
      AppState.activeCallState = null;
    }
    AppState.micOn = false;
  }

  cleanupVoice();

  if (typeof showToast === 'function') {
    showToast('main-toast', '📞 Voice call ended.', 'dark');
  }
}

/* ── Internal: Ensure voice signaling room is joined ─────────── */
async function _ensureVoiceRoom() {
  if (_room || !window.fsRtdb || !_voiceSuiteId || !_voiceUserId) return _room;

  console.info(`[Voice] Joining voiceSignaling room for suite ${_voiceSuiteId}...`);
  try {
    _room = await RoomManager.join({
      roomPath:    `suites/${_voiceSuiteId}/voiceSignaling`,
      myUid:       _voiceUserId,
      myName:      _voiceUserName,
      localStream: _localStream,
      onTrack:     _handleRemoteTrack,
      onPeerLeft:  _handlePeerLeft,
    });

    _setupAutoplayUnlock();
    window.addEventListener('beforeunload', cleanupVoice);
    console.info('[Voice] ✅ Joined voiceSignaling room.');
  } catch (e) {
    console.warn('[Voice] Failed to join voice room:', e.message);
  }
  return _room;
}

/* ── Public: setVoiceMute ────────────────────────────────────── */
/**
 * Sets the microphone mute state.
 * When muted: track.enabled = false.
 * When unmuted: track.enabled = true.
 */
function setVoiceMute(muted) {
  _voiceMuted = muted;
  window._voiceMuted = muted;

  if (_localStream) {
    _localStream.getAudioTracks().forEach(t => {
      t.enabled = !muted;
    });
  }

  if (typeof _vcLocalStream !== 'undefined' && _vcLocalStream) {
    _vcLocalStream.getAudioTracks().forEach(t => {
      t.enabled = !muted;
    });
  }

  if (typeof AppState !== 'undefined') {
    AppState.micOn = !muted;
  }

  _showVoiceStatus(muted ? 'muted' : 'active');
  console.info(`[Voice] Microphone ${muted ? 'MUTED (OFF)' : 'UNMUTED (ON)'} (track.enabled=${!muted})`);
}

/* ── Public: toggleMic ────────────────────────────────────────── */
/**
 * Toggles the microphone ON or OFF upon explicit user interaction.
 */
async function toggleMic() {
  // If in video call, delegate to video call's mic control
  if (typeof _vcInCall !== 'undefined' && _vcInCall) {
    if (typeof toggleVideoMic === 'function') {
      return toggleVideoMic();
    }
  }

  // If currently muted (OFF), user wants to turn it ON
  if (_voiceMuted) {
    // Acquire microphone stream if not yet acquired
    if (!_localStream) {
      console.info('[Voice] Requesting microphone access on user click...');
      _localStream = await MediaManager.getMicrophone();

      if (!_localStream) {
        _voiceMuted = true;
        window._voiceMuted = true;
        if (typeof AppState !== 'undefined') AppState.micOn = false;
        _showVoiceStatus('denied');
        return;
      }
    }

    _voiceMuted  = false;
    _voiceActive = true;
    window._voiceMuted  = false;
    window._voiceActive = true;

    _localStream.getAudioTracks().forEach(t => { t.enabled = true; });

    if (typeof _vcLocalStream !== 'undefined' && _vcLocalStream) {
      _vcLocalStream.getAudioTracks().forEach(t => { t.enabled = true; });
    }

    if (typeof AppState !== 'undefined') {
      AppState.micOn = true;
      if (!AppState.activeCallState) AppState.activeCallState = 'voice';
    }

    await _ensureVoiceRoom();

    _showVoiceStatus('active');
    console.info('[Voice] ✅ Microphone turned ON.');
  } else {
    // Currently ON -> Turn it OFF
    setVoiceMute(true);
    console.info('[Voice] ✅ Microphone turned OFF.');
  }
}

/* ── Public: cleanupVoice ────────────────────────────────────── */
/**
 * Stops all microphone tracks, leaves signaling, and resets voice module.
 */
function cleanupVoice() {
  _voiceActive = false;
  _voiceMuted  = true;
  window._voiceActive = false;
  window._voiceMuted  = true;

  console.info('[Voice] Cleaning up voice session...');

  if (_room) {
    try { _room.leave().catch(() => {}); } catch (_) {}
    _room = null;
  }

  Object.values(_analyserNodes).forEach(({ source, analyser, rafId }) => {
    try { cancelAnimationFrame(rafId); } catch (_) {}
    try { source.disconnect(); } catch (_) {}
    try { analyser.disconnect(); } catch (_) {}
  });
  _analyserNodes = {};

  Object.entries(_audioElements).forEach(([, el]) => {
    try { el.pause(); el.srcObject = null; el.remove(); } catch (_) {}
  });
  _audioElements = {};

  if (_localStream) {
    MediaManager.stopStream(_localStream);
    _localStream = null;
  }

  if (_silentCtx) {
    try { _silentCtx.close(); } catch (_) {}
    _silentCtx = null;
  }

  _pendingAutoplay = [];
  _autoplayUnlocked = false;

  if (typeof AppState !== 'undefined') {
    AppState.micOn = false;
  }

  _showVoiceStatus('muted');
  window.removeEventListener('beforeunload', cleanupVoice);
  console.info('[Voice] ✅ Voice cleanup complete.');
}

/* ── Remote track handler ────────────────────────────────────── */
function _handleRemoteTrack(peerId, stream) {
  console.info(`[Voice] Remote audio track received from ${peerId.slice(0,6)}`);

  let audio = _audioElements[peerId];
  if (!audio) {
    audio = document.createElement('audio');
    audio.id        = `voice-audio-${_vcSafeId(peerId)}`;
    audio.autoplay  = true;
    audio.controls  = false;
    audio.style.display = 'none';
    document.body.appendChild(audio);
    _audioElements[peerId] = audio;
  }

  if (audio.srcObject !== stream) {
    audio.srcObject = stream;
  }

  const playPromise = audio.play();
  if (playPromise !== undefined) {
    playPromise.catch(err => {
      if (err.name === 'NotAllowedError') {
        console.warn(`[Voice] Autoplay blocked for ${peerId.slice(0,6)} — queued for unlock`);
        _pendingAutoplay.push(audio);
        _showAutoplayPrompt();
      }
    });
  }

  _setupSpeakingDetection(peerId, stream);
}

/* ── Peer left handler ───────────────────────────────────────── */
function _handlePeerLeft(peerId) {
  const audio = _audioElements[peerId];
  if (audio) {
    try { audio.pause(); audio.srcObject = null; audio.remove(); } catch (_) {}
    delete _audioElements[peerId];
  }

  const analyserData = _analyserNodes[peerId];
  if (analyserData) {
    cancelAnimationFrame(analyserData.rafId);
    try { analyserData.source.disconnect(); } catch (_) {}
    try { analyserData.analyser.disconnect(); } catch (_) {}
    delete _analyserNodes[peerId];
  }

  _setSpeakingIndicator(peerId, false);
}

/* ── Speaking detection ──────────────────────────────────────── */
function _setupSpeakingDetection(peerId, stream) {
  if (_analyserNodes[peerId]) {
    cancelAnimationFrame(_analyserNodes[peerId].rafId);
    try { _analyserNodes[peerId].source.disconnect(); } catch (_) {}
  }

  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;

    const source = audioCtx.createMediaStreamSource(stream);
    source.connect(analyser);

    const data = new Uint8Array(analyser.frequencyBinCount);
    let isSpeaking = false;

    function check() {
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((s, v) => s + v, 0) / data.length;
      const nowSpeaking = avg > 14;

      if (nowSpeaking !== isSpeaking) {
        isSpeaking = nowSpeaking;
        _setSpeakingIndicator(peerId, isSpeaking);
      }

      _analyserNodes[peerId] = { ...(_analyserNodes[peerId] || {}), rafId: requestAnimationFrame(check) };
    }

    const rafId = requestAnimationFrame(check);
    _analyserNodes[peerId] = { source, analyser, rafId };
  } catch (e) {
    console.warn(`[Voice] Speaking detection failed for ${peerId.slice(0,6)}:`, e.message);
  }
}

function _setSpeakingIndicator(peerId, isSpeaking) {
  try {
    const card = document.querySelector(`.member-card[data-uid="${CSS.escape(peerId)}"]`);
    if (card) {
      if (isSpeaking) {
        card.style.borderColor = '#28a745';
        card.style.boxShadow   = '0 0 0 2px rgba(40,167,69,0.35)';
      } else {
        card.style.borderColor = '';
        card.style.boxShadow   = '';
      }
    }
  } catch (_) {}
}

/* ── Voice status in toolbar button ──────────────────────────── */
function _showVoiceStatus(state) {
  const tbMic = document.getElementById('tb-btn-mic');
  const btn = document.getElementById('btn-mic');

  if (tbMic) {
    if (state === 'active') {
      tbMic.classList.remove('muted');
      tbMic.classList.add('active-tool');
      tbMic.style.color = '#2563eb';
      tbMic.title = 'Turn Microphone OFF (Mute)';
    } else if (state === 'denied' || state === 'unavailable') {
      tbMic.classList.add('muted');
      tbMic.classList.remove('active-tool');
      tbMic.style.color = '#dc3545';
      tbMic.title = 'Microphone Permission Denied';
    } else { // muted or idle (OFF)
      tbMic.classList.add('muted');
      tbMic.classList.remove('active-tool');
      tbMic.style.color = '#dc3545';
      tbMic.title = 'Turn Microphone ON (Unmute)';
    }
  }

  if (btn) {
    if (state === 'active') {
      btn.classList.remove('muted');
      btn.innerHTML = '<span class="taskbar-icon">🎤</span>Mic ON';
    } else {
      btn.classList.add('muted');
      btn.innerHTML = '<span class="taskbar-icon">🔇</span>Mic OFF';
    }
  }
}

/* ── Autoplay unlock ─────────────────────────────────────────── */
function _setupAutoplayUnlock() {
  const unlock = () => {
    if (_autoplayUnlocked) return;
    _autoplayUnlocked = true;
    _pendingAutoplay.forEach(audio => {
      audio.play().catch(() => {});
    });
    _pendingAutoplay = [];
    document.removeEventListener('click', unlock);
    document.removeEventListener('keydown', unlock);
    document.removeEventListener('touchstart', unlock);
  };

  document.addEventListener('click',      unlock, { once: true });
  document.addEventListener('keydown',    unlock, { once: true });
  document.addEventListener('touchstart', unlock, { once: true });
}

function _showAutoplayPrompt() {
  if (typeof showToast === 'function') {
    showToast('main-toast', '🔊 Click anywhere to enable audio', 'dark');
  }
}

function _vcSafeId(id) {
  return (id || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

// Global window attachments
window.initVoice         = initVoice;
window.startVoiceCall    = startVoiceCall;
window.endVoiceCall      = endVoiceCall;
window.setVoiceMute      = setVoiceMute;
window.toggleMic         = toggleMic;
window.cleanupVoice      = cleanupVoice;
window.leaveVoiceSession = endVoiceCall;
window.stopVoice         = endVoiceCall;
