/* ── webrtc-manager.js – Shared WebRTC Infrastructure ────────────
 *
 * Provides reusable services for ALL media features:
 *   • Voice Chat     (voice.js)
 *   • Video Call     (video-call.js)
 *   • Screen Sharing (screen-share.js)
 *
 * Services exported to window:
 *   WebRTCConfig           – ICE server configuration (STUN + TURN)
 *   PeerConnectionManager  – manages RTCPeerConnection pool
 *   MediaManager           – getUserMedia / getDisplayMedia wrappers
 *   TrackManager           – addTrack / replaceTrack helpers
 *   SignalManager          – Firebase RTDB signaling abstraction
 *   ConnectionRecovery     – ICE restart, reconnect, retry logic
 *   RoomManager            – room lifecycle (join / leave / presence)
 *
 * Load order: after firebase-client.js, before voice.js / video-call.js / screen-share.js
 */

'use strict';

/* ══════════════════════════════════════════════════════════════════
   WEBRTC CONFIGURATION
   ══════════════════════════════════════════════════════════════════ */

/**
 * Centralised ICE server configuration.
 *
 * TURN credentials are read from window.CoLearn_TURN_* constants.
 * Set these in config.js or inject them server-side before this script loads.
 *
 * Example (in config.js or a server-rendered script tag):
 *   window.CoLearn_TURN_URL        = 'turn:your.turn.server:3478';
 *   window.CoLearn_TURN_USERNAME   = 'username';
 *   window.CoLearn_TURN_CREDENTIAL = 'credential';
 *
 * When these are set, TURN will be used automatically without any
 * code changes. STUN servers remain active for direct connections.
 */
const WebRTCConfig = (function () {
  'use strict';

  // ── STUN servers (Google public, free) ────────────────────────
  const STUN_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
  ];

  // ── TURN server placeholders ──────────────────────────────────
  // Set window.CoLearn_TURN_* to enable TURN.
  // These placeholders ensure the architecture supports TURN without
  // requiring any code change later.
  const TURN_URL        = window.CoLearn_TURN_URL        || null;
  const TURN_USERNAME   = window.CoLearn_TURN_USERNAME   || null;
  const TURN_CREDENTIAL = window.CoLearn_TURN_CREDENTIAL || null;

  function buildIceServers() {
    const servers = [...STUN_SERVERS];
    if (TURN_URL && TURN_USERNAME && TURN_CREDENTIAL) {
      servers.push({
        urls:       TURN_URL,
        username:   TURN_USERNAME,
        credential: TURN_CREDENTIAL,
      });
      // Also add UDP variant if TCP was specified (and vice versa)
      if (TURN_URL.includes('?transport=tcp')) {
        servers.push({
          urls:       TURN_URL.replace('?transport=tcp', '?transport=udp'),
          username:   TURN_USERNAME,
          credential: TURN_CREDENTIAL,
        });
      }
      console.info('[WebRTCConfig] TURN server configured:', TURN_URL);
    } else {
      console.info('[WebRTCConfig] TURN not configured — using STUN only. Set window.CoLearn_TURN_* to enable TURN.');
    }
    return servers;
  }

  const ICE_SERVERS = buildIceServers();

  return {
    /** RTCConfiguration object — pass directly to new RTCPeerConnection() */
    get rtcConfig() {
      return {
        iceServers:         ICE_SERVERS,
        iceCandidatePoolSize: 10,
        bundlePolicy:       'max-bundle',
        rtcpMuxPolicy:      'require',
      };
    },

    /** Whether TURN is currently configured */
    get hasTurn() {
      return !!(TURN_URL && TURN_USERNAME && TURN_CREDENTIAL);
    },

    ICE_SERVERS,
  };
})();

window.WebRTCConfig = WebRTCConfig;


/* ══════════════════════════════════════════════════════════════════
   MEDIA MANAGER
   Wraps getUserMedia / getDisplayMedia with descriptive errors
   ══════════════════════════════════════════════════════════════════ */

const MediaManager = (function () {
  'use strict';

  /**
   * Request microphone access.
   * Returns the MediaStream or null if denied/unavailable.
   * Never throws — errors are caught and toasted.
   */
  async function getMicrophone() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl:  true,
        },
        video: false,
      });
      console.info('[MediaManager] Microphone stream acquired.');
      return stream;
    } catch (err) {
      const msg = _describeMediaError(err, 'microphone');
      console.warn('[MediaManager] Microphone error:', msg);
      if (typeof showToast === 'function') {
        showToast('main-toast', `🎤 ${msg}`, 'dark');
      }
      return null;
    }
  }

  /**
   * Request camera + microphone access for video calls.
   * Returns the MediaStream or null.
   */
  async function getCameraAndMic(videoConstraints) {
    // ── Secure context check ──────────────────────────────────────────────────
    // Mobile Chrome (and all Chromium-based Android browsers) block getUserMedia
    // on non-HTTPS pages unless the origin is exactly 'localhost'.
    // window.isSecureContext === false means camera WILL be blocked.
    if (!window.isSecureContext) {
      const secureMsg = 'Camera blocked: this browser requires HTTPS (or localhost). ' +
                        'Access the app at https://… instead of http://IP:PORT.';
      console.error('[MediaManager] ❌ INSECURE CONTEXT — camera unavailable.', {
        isSecureContext: window.isSecureContext,
        protocol: location.protocol,
        hostname: location.hostname,
        ua: navigator.userAgent.slice(0, 80),
      });
      if (typeof showToast === 'function') {
        showToast('main-toast', '🔒 Camera blocked — open the app via HTTPS or localhost.', 'dark');
      }
      return null;
    }

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      console.error('[MediaManager] ❌ navigator.mediaDevices.getUserMedia not available.', navigator.userAgent.slice(0, 80));
      if (typeof showToast === 'function') {
        showToast('main-toast', '📹 Camera API not supported in this browser.', 'dark');
      }
      return null;
    }

    const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    console.info(`[MediaManager] getCameraAndMic — isMobile=${isMobile} isSecure=${window.isSecureContext}`);

    // ── Progressive constraint waterfall ─────────────────────────────────────
    // Each attempt uses progressively simpler constraints.
    // On permission denied we stop immediately — other constraints won't help.
    const AUD = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    const constraintSets = videoConstraints
      ? [{ audio: AUD, video: videoConstraints }]
      : [
          // Attempt 1: HD 720p ideal, prefer front cam on mobile
          { audio: AUD, video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, ...(isMobile ? { facingMode: 'user' } : {}) } },
          // Attempt 2: Standard 480p
          { audio: AUD, video: { width: { ideal: 640 }, height: { ideal: 480 }, ...(isMobile ? { facingMode: 'user' } : {}) } },
          // Attempt 3: facingMode only (let browser choose resolution)
          { audio: AUD, video: { facingMode: 'user' } },
          // Attempt 4: any video device, no constraints
          { audio: AUD, video: true },
          // Attempt 5: bare minimum fallback
          { audio: true, video: true },
        ];

    let lastError = null;
    for (let i = 0; i < constraintSets.length; i++) {
      const constraints = constraintSets[i];
      console.info(`[MediaManager] getCameraAndMic attempt ${i + 1}/${constraintSets.length}:`, JSON.stringify(constraints.video));
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        const vt = stream.getVideoTracks()[0];
        const at = stream.getAudioTracks()[0];
        console.info(`[MediaManager] ✅ stream acquired (attempt ${i + 1}):`,
          `video="${vt ? vt.label : 'none'}"`,
          `audio="${at ? at.label : 'none'}"`,
          vt ? JSON.stringify(vt.getSettings()) : '');
        return stream;
      } catch (err) {
        lastError = err;
        console.warn(`[MediaManager] attempt ${i + 1} failed — ${err.name}: ${err.message}`);
        // Permission denied: no point trying other constraints
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          console.error('[MediaManager] ❌ Camera permission denied — aborting waterfall.');
          if (typeof showToast === 'function') {
            showToast('main-toast', '📹 Camera access denied. Allow access in browser settings.', 'dark');
          }
          return null;
        }
      }
    }

    // All attempts exhausted
    const finalMsg = _describeMediaError(lastError, 'camera/microphone');
    console.error('[MediaManager] ❌ All getCameraAndMic attempts failed. Last error:', lastError);
    if (typeof showToast === 'function') {
      showToast('main-toast', `📹 ${finalMsg}`, 'dark');
    }
    return null;
  }

  /**
   * Request screen capture for screen sharing.
   * Returns the MediaStream or null if cancelled/denied.
   */
  async function getDisplayMedia() {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: 'monitor',
          frameRate:      { ideal: 30, max: 60 },
          width:          { ideal: 1920 },
          height:         { ideal: 1080 },
        },
        audio: false,
      });
      console.info('[MediaManager] Display stream acquired.');
      return stream;
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        console.info('[MediaManager] Screen share cancelled by user.');
      } else {
        const msg = _describeMediaError(err, 'screen');
        console.warn('[MediaManager] Screen capture error:', msg);
        if (typeof showToast === 'function') {
          showToast('main-toast', `📺 ${msg}`, 'dark');
        }
      }
      return null;
    }
  }

  /**
   * Create a silent audio track (1-second silence oscillator).
   * Used as a fallback when microphone access is denied so that
   * RTCPeerConnection always has a sender track.
   */
  function createSilentAudioTrack() {
    try {
      const ctx         = new (window.AudioContext || window.webkitAudioContext)();
      const oscillator  = ctx.createOscillator();
      const dst         = oscillator.connect(ctx.createMediaStreamDestination());
      oscillator.start();
      const track = dst.stream.getAudioTracks()[0];
      track.enabled = false; // mute it — just a placeholder
      console.info('[MediaManager] Silent audio track created as mic fallback.');
      return { track, ctx };
    } catch (e) {
      console.warn('[MediaManager] Could not create silent track:', e.message);
      return null;
    }
  }

  /**
   * Create a black video track placeholder (for camera-off state).
   */
  function createBlackVideoTrack(width, height) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width  = width  || 320;
      canvas.height = height || 240;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const stream = canvas.captureStream(1);
      return stream.getVideoTracks()[0] || null;
    } catch (e) {
      console.warn('[MediaManager] Could not create black video track:', e.message);
      return null;
    }
  }

  /** Stop all tracks in a MediaStream safely */
  function stopStream(stream) {
    if (!stream) return;
    try {
      stream.getTracks().forEach(t => {
        try { t.stop(); } catch (_) {}
      });
    } catch (_) {}
  }

  /** Human-readable media error description */
  function _describeMediaError(err, device) {
    switch (err.name) {
      case 'NotAllowedError':
      case 'PermissionDeniedError':
        return `${device} access denied. Please allow access in browser settings.`;
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return `No ${device} found. Please connect a device.`;
      case 'NotReadableError':
      case 'TrackStartError':
        return `${device} is in use by another application.`;
      case 'OverconstrainedError':
        return `${device} does not support the requested settings.`;
      case 'AbortError':
        return `${device} access was aborted.`;
      default:
        return `Could not access ${device}: ${err.message}`;
    }
  }

  return { getMicrophone, getCameraAndMic, getDisplayMedia, createSilentAudioTrack, createBlackVideoTrack, stopStream };
})();

window.MediaManager = MediaManager;


/* ══════════════════════════════════════════════════════════════════
   TRACK MANAGER
   Handles addTrack / replaceTrack on RTCPeerConnection objects
   ══════════════════════════════════════════════════════════════════ */

const TrackManager = (function () {
  'use strict';

  /**
   * Add all tracks from a stream to a peer connection.
   * @param {RTCPeerConnection} pc
   * @param {MediaStream} stream
   */
  function addStreamToPeer(pc, stream) {
    if (!pc || !stream) return;
    stream.getTracks().forEach(track => {
      try {
        pc.addTrack(track, stream);
      } catch (e) {
        console.warn('[TrackManager] addTrack error:', e.message);
      }
    });
  }

  /**
   * Replace the video track on all senders of a peer connection.
   * Used for screen share → camera transition without reconnecting.
   * @param {RTCPeerConnection} pc
   * @param {MediaStreamTrack} newTrack — null to remove video
   */
  async function replaceVideoTrack(pc, newTrack) {
    if (!pc) return;
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (sender) {
      try {
        await sender.replaceTrack(newTrack);
        console.info('[TrackManager] Video track replaced.');
      } catch (e) {
        console.warn('[TrackManager] replaceTrack error:', e.message);
      }
    } else if (newTrack) {
      try {
        pc.addTrack(newTrack);
      } catch (e) {
        console.warn('[TrackManager] addTrack (video) error:', e.message);
      }
    }
  }

  /**
   * Replace the audio track on all senders.
   * @param {RTCPeerConnection} pc
   * @param {MediaStreamTrack} newTrack
   */
  async function replaceAudioTrack(pc, newTrack) {
    if (!pc) return;
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'audio');
    if (sender) {
      try {
        await sender.replaceTrack(newTrack);
        console.info('[TrackManager] Audio track replaced.');
      } catch (e) {
        console.warn('[TrackManager] replaceAudioTrack error:', e.message);
      }
    } else if (newTrack) {
      try {
        pc.addTrack(newTrack);
      } catch (e) {
        console.warn('[TrackManager] addTrack (audio) error:', e.message);
      }
    }
  }

  /**
   * Mute or unmute the audio sender on a peer connection.
   */
  function setAudioEnabled(pc, enabled) {
    if (!pc) return;
    pc.getSenders().forEach(sender => {
      if (sender.track && sender.track.kind === 'audio') {
        sender.track.enabled = enabled;
      }
    });
  }

  /**
   * Enable or disable the video sender.
   */
  function setVideoEnabled(pc, enabled) {
    if (!pc) return;
    pc.getSenders().forEach(sender => {
      if (sender.track && sender.track.kind === 'video') {
        sender.track.enabled = enabled;
      }
    });
  }

  return { addStreamToPeer, replaceVideoTrack, replaceAudioTrack, setAudioEnabled, setVideoEnabled };
})();

window.TrackManager = TrackManager;


/* ══════════════════════════════════════════════════════════════════
   SIGNAL MANAGER
   WebSocket signaling abstraction — replaces Firebase RTDB signaling
   ══════════════════════════════════════════════════════════════════ */

const SignalManager = (function () {
  'use strict';

  /**
   * Create a SignalManager instance for a specific room.
   *
   * @param {string} basePath  Path, e.g. 'suites/{id}/videoSignaling'
   * @param {string} myUid     Current user's UID
   * @returns {Object}         Signal manager instance
   */
  function create(basePath, myUid) {
    const peerJoinedCallbacks = [];
    const peerLeftCallbacks   = [];
    const offerCallbacks      = [];
    const answerCallbacks     = [];
    const iceCallbacks        = [];

    const knownPeers = {}; // { [uid]: { uid, online: true, ... } }

    const suiteId = (basePath.split('/')[1] || '').trim();

    let ws = null;
    let isConnected = false;
    const sendQueue = [];

    function _getWsUrl() {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = window.location.host;
      return `${proto}//${host}/ws/video`;
    }

    function _connectWs() {
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return;
      }

      const url = _getWsUrl();
      console.info(`[SignalManager] Connecting to WebSocket: ${url} (room=${suiteId})`);
      ws = new WebSocket(url);

      ws.onopen = () => {
        console.info(`[SignalManager] WebSocket connected to ${url}`);
        isConnected = true;

        // Send join message
        _sendRaw({
          type: 'join',
          roomId: suiteId,
          uid: myUid,
        });

        // Flush any queued messages
        while (sendQueue.length > 0) {
          const msg = sendQueue.shift();
          _sendRaw(msg);
        }
      };

      ws.onmessage = async (event) => {
        try {
          const msg = JSON.parse(event.data);
          const { type, uid, fromUid, sdp, candidate } = msg;

          if (type === 'peer-joined') {
            const peerId = uid;
            if (peerId && peerId !== myUid) {
              const peerData = { uid: peerId, online: true };
              knownPeers[peerId] = peerData;
              peerJoinedCallbacks.forEach(cb => {
                try { cb(peerId, peerData); } catch (err) { console.error('[SignalManager] peerJoined callback error:', err); }
              });
            }
          } else if (type === 'peer-left') {
            const peerId = uid;
            if (peerId && peerId !== myUid) {
              delete knownPeers[peerId];
              peerLeftCallbacks.forEach(cb => {
                try { cb(peerId); } catch (err) { console.error('[SignalManager] peerLeft callback error:', err); }
              });
            }
          } else if (type === 'offer') {
            if (fromUid && sdp) {
              for (const cb of offerCallbacks) {
                try { await cb(fromUid, { type: 'offer', sdp }); } catch (err) { console.error('[SignalManager] offer callback error:', err); }
              }
            }
          } else if (type === 'answer') {
            if (fromUid && sdp) {
              for (const cb of answerCallbacks) {
                try { await cb(fromUid, { type: 'answer', sdp }); } catch (err) { console.error('[SignalManager] answer callback error:', err); }
              }
            }
          } else if (type === 'ice-candidate') {
            if (fromUid && candidate) {
              for (const cb of iceCallbacks) {
                try { await cb(fromUid, candidate); } catch (err) { console.error('[SignalManager] ice candidate callback error:', err); }
              }
            }
          }
        } catch (err) {
          console.error('[SignalManager] Failed to handle WebSocket message:', err);
        }
      };

      ws.onclose = () => {
        console.info('[SignalManager] WebSocket closed');
        isConnected = false;
      };

      ws.onerror = (err) => {
        console.error('[SignalManager] WebSocket error:', err);
      };
    }

    function _sendRaw(msgObj) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msgObj));
      } else {
        sendQueue.push(msgObj);
        if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
          _connectWs();
        }
      }
    }

    /** Send offer via WebSocket */
    async function sendOffer(targetUid, sdpObj) {
      _sendRaw({
        type: 'offer',
        targetUid,
        sdp: sdpObj.sdp,
      });
    }

    /** Send answer via WebSocket */
    async function sendAnswer(targetUid, sdpObj) {
      _sendRaw({
        type: 'answer',
        targetUid,
        sdp: sdpObj.sdp,
      });
    }

    /** Send ICE candidate via WebSocket */
    async function sendIceCandidate(targetUid, candidate) {
      _sendRaw({
        type: 'ice-candidate',
        targetUid,
        candidate: candidate.toJSON ? candidate.toJSON() : candidate,
      });
    }

    /** Announce presence (establishes WS connection and joins room) */
    async function announcePresence(data) {
      _connectWs();
      return true;
    }

    /** Remove own presence */
    async function removePresence() {
      if (ws) {
        try { ws.close(); } catch (_) {}
        ws = null;
      }
      isConnected = false;
    }

    /** Listen for new peers joining */
    function onPeerJoined(callback) {
      peerJoinedCallbacks.push(callback);
    }

    /** Listen for peers leaving */
    function onPeerLeft(callback) {
      peerLeftCallbacks.push(callback);
    }

    /** Listen for incoming offers */
    function onOffer(callback) {
      offerCallbacks.push(callback);
    }

    /** Listen for incoming answers */
    function onAnswer(callback) {
      answerCallbacks.push(callback);
    }

    /** Listen for incoming ICE candidates */
    function onIceCandidate(callback) {
      iceCallbacks.push(callback);
    }

    /** Read current presence list (returns locally known peers) */
    async function getPresence() {
      return { ...knownPeers };
    }

    /** Clean up callbacks and close WS */
    function cleanup() {
      peerJoinedCallbacks.length = 0;
      peerLeftCallbacks.length   = 0;
      offerCallbacks.length      = 0;
      answerCallbacks.length     = 0;
      iceCallbacks.length        = 0;
      sendQueue.length           = 0;
      if (ws) {
        try { ws.close(); } catch (_) {}
        ws = null;
      }
      isConnected = false;
    }

    return {
      sendOffer, sendAnswer, sendIceCandidate,
      announcePresence, removePresence,
      onPeerJoined, onPeerLeft,
      onOffer, onAnswer, onIceCandidate,
      getPresence,
      cleanup,
    };
  }

  return { create };
})();

window.SignalManager = SignalManager;


/* ══════════════════════════════════════════════════════════════════
   PEER CONNECTION MANAGER
   Manages the pool of RTCPeerConnection objects using Perfect Negotiation
   ══════════════════════════════════════════════════════════════════ */

const PeerConnectionManager = (function () {
  'use strict';

  /**
   * Create a PeerConnectionManager for one room/session.
   *
   * @param {Object} opts
   * @param {string}        opts.myUid        – current user's Firebase UID
   * @param {MediaStream}   opts.localStream  – stream to send (null = receive-only)
   * @param {SignalManager} opts.signal       – SignalManager instance for this room
   * @param {Function}      opts.onTrack      – callback(peerId, stream, track) when remote track arrives
   * @param {Function}      opts.onPeerLeft   – callback(peerId) when peer disconnects
   * @param {boolean}       opts.receiveOnly  – if true, never initiate offers (passive viewer mode)
   */
  function create(opts) {
    const { myUid, signal, onTrack, onPeerLeft } = opts;
    const isScreen   = opts.isScreen || (opts.roomPath && opts.roomPath.includes('screen')) || false;
    let _stream      = opts.localStream || null;
    let _receiveOnly = opts.receiveOnly || false;

    const peerConnections               = {};  // { peerId: RTCPeerConnection }
    const iceCandidateQueues            = {};  // { peerId: RTCIceCandidate[] }
    const makingOffer                   = {};  // { peerId: boolean }
    const ignoreOffer                   = {};  // { peerId: boolean }
    const isSettingRemoteAnswerPending  = {};  // { peerId: boolean }
    const remoteStreams                 = {};  // { peerId: MediaStream }

    // Perfect negotiation: the peer with the lexicographically lower UID is "polite"
    function _isPolite(peerId) {
      return myUid < peerId;
    }

    /** Get existing or create new RTCPeerConnection for a peer */
    function _getOrCreatePC(peerId) {
      if (peerConnections[peerId]) {
        return peerConnections[peerId];
      }

      const pc = new RTCPeerConnection(WebRTCConfig.rtcConfig);
      console.log(`[RTC] PC created peer=${peerId}`);
      peerConnections[peerId] = pc;
      if (!iceCandidateQueues[peerId]) {
        iceCandidateQueues[peerId] = [];
      }
      makingOffer[peerId]                  = false;
      ignoreOffer[peerId]                  = false;
      isSettingRemoteAnswerPending[peerId] = false;

      // ── Add local stream tracks ──────────────────────────────
      if (_stream) {
        _stream.getTracks().forEach(track => {
          try {
            pc.addTrack(track, _stream);
            if (isScreen) {
              console.log(`[RTC] screen track added peer=${peerId} kind=${track.kind}`);
              console.log(`[ScreenRTC] replacing/adding screen track peer=${peerId}`);
              console.log(`[ScreenRTC] screen track sender peer=${peerId}`);
            } else {
              console.log(`[RTC] local camera track added peer=${peerId} kind=${track.kind}`);
            }
            console.log(`[RTC] sender track peer=${peerId} kind=${track.kind}`);
          } catch (e) {
            console.warn(`[PCM:${myUid.slice(0,6)}] addTrack error:`, e.message);
          }
        });
        console.info(`[PCM:${myUid.slice(0,6)}] addedTracks(${_stream.getTracks().map(t=>t.kind).join(',')}) → ${peerId.slice(0,6)}`);
      }

      // ── Remote track handler ─────────────────────────────────
      pc.ontrack = event => {
        let stream = event.streams && event.streams[0] ? event.streams[0] : null;
        if (!stream) {
          if (!remoteStreams[peerId]) {
            remoteStreams[peerId] = new MediaStream();
          }
          remoteStreams[peerId].addTrack(event.track);
          stream = remoteStreams[peerId];
        }
        console.log(`[RTC] REMOTE TRACK peer=${peerId} kind=${event.track.kind} stream=${stream ? stream.id : 'none'}`);
        if (isScreen) {
          console.log(`[ScreenRTC] remote screen track peer=${peerId}`);
        }
        console.log(`[VideoDebug] remote track from=${peerId}`);
        console.info(`[PCM:${myUid.slice(0,6)}] ✅ ontrack ← ${peerId.slice(0,6)} kind=${event.track.kind}`);
        if (typeof onTrack === 'function') {
          onTrack(peerId, stream, event.track);
        }
      };

      // ── ICE candidate handler ────────────────────────────────
      pc.onicecandidate = event => {
        if (!event.candidate) return;
        console.log(`[RTC] ICE sent peer=${peerId}`);
        signal.sendIceCandidate(peerId, event.candidate).catch(e => {
          console.warn(`[PCM:${myUid.slice(0,6)}] sendIceCandidate error:`, e.message);
        });
      };

      // ── Connection state monitoring ──────────────────────────
      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        console.log(`[RTC] connection peer=${peerId} state=${state}`);
        console.log(`[VideoDebug] connection state=${state}`);
        console.info(`[PCM:${myUid.slice(0,6)}] connState(${peerId.slice(0,6)}): ${state}`);
        if (state === 'failed') {
          console.warn(`[PCM:${myUid.slice(0,6)}] Connection FAILED for ${peerId.slice(0,6)} — triggering ICE restart`);
          ConnectionRecovery.restartIce(pc, peerId, myUid, signal);
        }
        if (state === 'closed' || state === 'disconnected') {
          if (typeof onPeerLeft === 'function') {
            setTimeout(() => {
              if (pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
                console.info(`[PCM:${myUid.slice(0,6)}] Peer ${peerId.slice(0,6)} left (grace period expired)`);
                onPeerLeft(peerId);
              }
            }, 5000);
          }
        }
      };

      // ── ICE gathering state ──────────────────────────────────
      pc.onicegatheringstatechange = () => {
        console.info(`[PCM:${myUid.slice(0,6)}] iceGather(${peerId.slice(0,6)}): ${pc.iceGatheringState}`);
      };
      pc.oniceconnectionstatechange = () => {
        console.info(`[PCM:${myUid.slice(0,6)}] iceConn(${peerId.slice(0,6)}): ${pc.iceConnectionState}`);
      };

      // ── Perfect Negotiation: onnegotiationneeded ─────────────
      pc.onnegotiationneeded = async () => {
        if (_receiveOnly) {
          console.info(`[PCM:${myUid.slice(0,6)}] onnegotiationneeded suppressed (receiveOnly) for ${peerId.slice(0,6)}`);
          return;
        }
        console.info(`[PCM:${myUid.slice(0,6)}] onnegotiationneeded → creating offer for ${peerId.slice(0,6)}`);
        try {
          makingOffer[peerId] = true;
          await pc.setLocalDescription();
          console.log(`[RTC] offer created peer=${peerId}`);
          console.log(`[VideoDebug] sending offer to=${peerId}`);
          await signal.sendOffer(peerId, { sdp: pc.localDescription.sdp, type: pc.localDescription.type });
          console.info(`[PCM:${myUid.slice(0,6)}] ✅ offer sent → ${peerId.slice(0,6)}`);
        } catch (e) {
          console.warn(`[PCM:${myUid.slice(0,6)}] onnegotiationneeded error (${peerId.slice(0,6)}):`, e.message);
        } finally {
          makingOffer[peerId] = false;
        }
      };

      return pc;
    }

    /**
     * Initiate a connection to a peer.
     * Uses Perfect Negotiation.
     */
    async function connectToPeer(peerId) {
      if (peerConnections[peerId]) {
        const s = peerConnections[peerId].connectionState;
        if (s === 'connected' || s === 'connecting') {
          console.info(`[PCM:${myUid.slice(0,6)}] connectToPeer(${peerId.slice(0,6)}): already ${s} — skipping`);
          return;
        }
      }

      console.info(`[PCM:${myUid.slice(0,6)}] connectToPeer → ${peerId.slice(0,6)} (receiveOnly=${_receiveOnly})`);
      _getOrCreatePC(peerId);
    }

    /**
     * Handle an incoming offer (W3C Perfect Negotiation).
     */
    async function handleOffer(fromPeerId, offerData) {
      console.log(`[RTC] offer received peer=${fromPeerId}`);
      console.log(`[VideoDebug] received offer from=${fromPeerId}`);
      const pc = _getOrCreatePC(fromPeerId);
      const isPolite = _isPolite(fromPeerId);

      const offerCollision = makingOffer[fromPeerId] || (pc.signalingState !== 'stable');

      ignoreOffer[fromPeerId] = !isPolite && offerCollision;
      if (ignoreOffer[fromPeerId]) {
        console.info(`[PCM:${myUid.slice(0,6)}] Offer collision — impolite, ignoring colliding offer from ${fromPeerId.slice(0,6)}`);
        return;
      }

      if (offerCollision) {
        console.info(`[PCM:${myUid.slice(0,6)}] Offer collision — polite, rolling back for ${fromPeerId.slice(0,6)}`);
        try {
          await pc.setLocalDescription({ type: 'rollback' });
        } catch (e) {
          console.warn(`[PCM:${myUid.slice(0,6)}] rollback warning:`, e.message);
        }
      }

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(offerData));
        ignoreOffer[fromPeerId] = false;
        await _flushIceQueue(fromPeerId);

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        console.log(`[RTC] answer created peer=${fromPeerId}`);
        console.log(`[VideoDebug] sending answer to=${fromPeerId}`);
        await signal.sendAnswer(fromPeerId, { sdp: answer.sdp, type: answer.type });
        console.info(`[PCM:${myUid.slice(0,6)}] ✅ Answer sent to ${fromPeerId.slice(0,6)}`);
      } catch (e) {
        console.error(`[PCM:${myUid.slice(0,6)}] handleOffer error (${fromPeerId.slice(0,6)}):`, e.message);
      }
    }

    /**
     * Handle an incoming answer.
     */
    async function handleAnswer(fromPeerId, answerData) {
      console.log(`[RTC] answer received peer=${fromPeerId}`);
      console.log(`[VideoDebug] received answer from=${fromPeerId}`);
      const pc = peerConnections[fromPeerId];
      if (!pc) {
        console.warn(`[PCM:${myUid.slice(0,6)}] No PC for answer from ${fromPeerId.slice(0,6)}`);
        return;
      }
      if (pc.signalingState !== 'have-local-offer') {
        console.warn(`[PCM:${myUid.slice(0,6)}] Answer in unexpected state (${pc.signalingState}) from ${fromPeerId.slice(0,6)}`);
        return;
      }
      try {
        isSettingRemoteAnswerPending[fromPeerId] = true;
        await pc.setRemoteDescription(new RTCSessionDescription(answerData));
        ignoreOffer[fromPeerId] = false;
        await _flushIceQueue(fromPeerId);
        console.info(`[PCM:${myUid.slice(0,6)}] ✅ Remote description (answer) set for ${fromPeerId.slice(0,6)}`);
      } catch (e) {
        console.error(`[PCM:${myUid.slice(0,6)}] handleAnswer error (${fromPeerId.slice(0,6)}):`, e.message);
      } finally {
        isSettingRemoteAnswerPending[fromPeerId] = false;
      }
    }

    /**
     * Handle an incoming ICE candidate.
     * Queues it if remote description not yet set or PC not yet initialized.
     */
    async function handleIceCandidate(fromPeerId, candidateData) {
      console.log(`[RTC] ICE received peer=${fromPeerId}`);
      const pc = peerConnections[fromPeerId];
      const candidate = new RTCIceCandidate(candidateData);

      if (!pc || !pc.remoteDescription || !pc.remoteDescription.type) {
        if (!iceCandidateQueues[fromPeerId]) iceCandidateQueues[fromPeerId] = [];
        iceCandidateQueues[fromPeerId].push(candidate);
        console.info(`[PCM:${myUid.slice(0,6)}] Queued ICE candidate for ${fromPeerId.slice(0,6)} (total: ${iceCandidateQueues[fromPeerId].length})`);
        return;
      }

      try {
        await pc.addIceCandidate(candidate);
      } catch (e) {
        if (!ignoreOffer[fromPeerId] && !e.message.includes('ICE') && !e.message.includes('candidate')) {
          console.warn(`[PCM:${myUid.slice(0,6)}] addIceCandidate error (${fromPeerId.slice(0,6)}):`, e.message);
        }
      }
    }

    /** Flush queued ICE candidates after remote description is set */
    async function _flushIceQueue(peerId) {
      const queue = iceCandidateQueues[peerId];
      const pc    = peerConnections[peerId];
      if (!pc || !pc.remoteDescription || !pc.remoteDescription.type || !queue || queue.length === 0) return;

      const candidates = [...queue];
      iceCandidateQueues[peerId] = [];
      console.info(`[PCM:${myUid.slice(0,6)}] Flushing ${candidates.length} queued ICE candidate(s) for ${peerId.slice(0,6)}`);

      for (const candidate of candidates) {
        try {
          await pc.addIceCandidate(candidate);
        } catch (e) {
          console.warn(`[PCM:${myUid.slice(0,6)}] Queued ICE flush error (${peerId.slice(0,6)}):`, e.message);
        }
      }
    }

    /** Close and remove a single peer connection */
    function closePeer(peerId) {
      if (peerConnections[peerId]) {
        try { peerConnections[peerId].close(); } catch (_) {}
        delete peerConnections[peerId];
      }
      delete iceCandidateQueues[peerId];
      delete makingOffer[peerId];
      delete ignoreOffer[peerId];
      delete isSettingRemoteAnswerPending[peerId];
      delete remoteStreams[peerId];
    }

    /** Close all peer connections */
    function closeAll() {
      Object.keys(peerConnections).forEach(closePeer);
    }

    /** Replace the local stream on all existing peer connections (track swap, no renegotiation) */
    async function replaceLocalStream(newStream) {
      _stream = newStream;
      for (const [peerId, pc] of Object.entries(peerConnections)) {
        const senders = pc.getSenders();
        for (const sender of senders) {
          if (!sender.track) continue;
          const newTrack = newStream
            ? newStream.getTracks().find(t => t.kind === sender.track.kind)
            : null;
          if (newTrack) {
            try {
              await sender.replaceTrack(newTrack);
              console.info(`[PCM] replaceTrack(${newTrack.kind}) → ${peerId.slice(0,6)}`);
            } catch (e) {
              console.warn(`[PCM] replaceTrack error (${peerId.slice(0,6)}):`, e.message);
            }
          }
        }
      }
    }

    /**
     * Add tracks from a new local stream to all existing peer connections.
     * Used when upgrading from passive (receive-only) to active (sending) mode.
     * Each addTrack() triggers onnegotiationneeded → a new offer is sent to each peer.
     */
    async function addLocalStream(newStream) {
      _stream = newStream;
      const peerList = Object.keys(peerConnections);
      console.info(`[PCM] addLocalStream: adding ${newStream.getTracks().length} track(s) to ${peerList.length} peer(s)`);
      for (const peerId of peerList) {
        const pc = peerConnections[peerId];
        if (!pc || pc.connectionState === 'closed') continue;
        newStream.getTracks().forEach(track => {
          try {
            pc.addTrack(track, newStream);
            console.info(`[PCM] addTrack(${track.kind}) → ${peerId.slice(0,6)}`);
          } catch (e) {
            // InvalidStateError means track already added — safe to ignore
            if (!e.message.includes('already')) {
              console.warn(`[PCM] addTrack error (${peerId.slice(0,6)}):`, e.message);
            }
          }
        });
      }
    }

    /**
     * Upgrade this PCM from receive-only to active sender mode.
     * Clears _receiveOnly so onnegotiationneeded will now send offers,
     * then adds the new local stream to all existing peer connections.
     * This triggers renegotiation with each peer — no reconnection needed.
     */
    async function upgradeToActive(newStream) {
      console.info(`[PCM] upgradeToActive: clearing receiveOnly, adding stream to ${Object.keys(peerConnections).length} peer(s)`);
      _receiveOnly = false;
      if (newStream) await addLocalStream(newStream);
    }

    /** Get a specific peer connection */
    function getPeer(peerId) {
      return peerConnections[peerId] || null;
    }

    /** Get all current peer IDs */
    function getPeerIds() {
      return Object.keys(peerConnections);
    }

    return {
      connectToPeer,
      handleOffer,
      handleAnswer,
      handleIceCandidate,
      closePeer,
      closeAll,
      replaceLocalStream,
      addLocalStream,
      upgradeToActive,
      getPeer,
      getPeerIds,
    };
  }

  return { create };
})();

window.PeerConnectionManager = PeerConnectionManager;


/* ══════════════════════════════════════════════════════════════════
   CONNECTION RECOVERY
   ICE restart, reconnection, exponential backoff
   ══════════════════════════════════════════════════════════════════ */

const ConnectionRecovery = (function () {
  'use strict';

  const _retryTimers = {};
  const MAX_RETRIES  = 5;

  /**
   * Attempt ICE restart for a peer that disconnected/failed.
   * Uses exponential backoff.
   */
  function restartIce(pc, peerId, myUid, signal) {
    const retryCount = _retryTimers[peerId] ? _retryTimers[peerId].count || 0 : 0;
    if (retryCount >= MAX_RETRIES) {
      console.warn(`[ConnectionRecovery] Max retries reached for ${peerId}`);
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, retryCount), 16000);
    console.info(`[ConnectionRecovery] Scheduling ICE restart for ${peerId} in ${delay}ms (attempt ${retryCount + 1})`);

    if (_retryTimers[peerId] && _retryTimers[peerId].timer) {
      clearTimeout(_retryTimers[peerId].timer);
    }

    _retryTimers[peerId] = {
      count: retryCount + 1,
      timer: setTimeout(async () => {
        if (!pc || pc.connectionState === 'connected') return;
        try {
          if (pc.restartIce) {
            pc.restartIce();
            console.info(`[ConnectionRecovery] ICE restart triggered for ${peerId}`);
          }
        } catch (e) {
          console.warn(`[ConnectionRecovery] ICE restart failed (${peerId}):`, e.message);
        }
      }, delay),
    };
  }

  /** Clear retry timers for a peer */
  function clearRetries(peerId) {
    if (_retryTimers[peerId]) {
      clearTimeout(_retryTimers[peerId].timer);
      delete _retryTimers[peerId];
    }
  }

  /** Clear all retry timers */
  function clearAll() {
    Object.keys(_retryTimers).forEach(clearRetries);
  }

  /**
   * Monitor network reconnection and trigger recovery.
   * Calls onReconnect() when internet is restored.
   */
  function watchNetworkReconnect(onReconnect) {
    window.addEventListener('online', onReconnect);
    return () => window.removeEventListener('online', onReconnect);
  }

  return { restartIce, clearRetries, clearAll, watchNetworkReconnect };
})();

window.ConnectionRecovery = ConnectionRecovery;


/* ══════════════════════════════════════════════════════════════════
   ROOM MANAGER
   High-level room lifecycle: join, leave, presence
   ══════════════════════════════════════════════════════════════════ */

const RoomManager = (function () {
  'use strict';

  /**
   * Join a WebRTC room.
   * Announces presence, sets up signaling, connects to existing peers.
   *
   * @param {Object} opts
   * @param {string}               opts.roomPath     – RTDB base path
   * @param {string}               opts.suiteId
   * @param {string}               opts.myUid
   * @param {string}               opts.myName
   * @param {MediaStream|null}     opts.localStream
   * @param {Function}             opts.onTrack      – (peerId, stream, track)
   * @param {Function}             opts.onPeerLeft   – (peerId)
   * @returns {Object} { signal, pcm, leave() }
   */
  async function join(opts) {
    const { roomPath, myUid, myName, localStream, onTrack, onPeerLeft, receiveOnly } = opts;
    const _ro = receiveOnly || false;

    // Ensure Firebase Auth is ready before accessing room
    if (typeof window.ensureFirebaseAuth === 'function') {
      await window.ensureFirebaseAuth(myUid).catch(() => {});
    }

    const suiteId = (roomPath.split('/')[1] || '').trim();
    console.log(`[VideoDebug] suiteId=${suiteId}`);
    console.log(`[VideoDebug] currentUid=${myUid}`);
    console.log(`[VideoDebug] signaling path=${roomPath}`);

    const signal = SignalManager.create(roomPath, myUid);

    const pcm = PeerConnectionManager.create({
      myUid,
      localStream,
      signal,
      roomPath,
      isScreen: roomPath.includes('screen'),
      onTrack,
      receiveOnly: _ro,
      onPeerLeft: (peerId) => {
        ConnectionRecovery.clearRetries(peerId);
        if (typeof onPeerLeft === 'function') onPeerLeft(peerId);
      },
    });

    // Set up incoming signal handlers
    signal.onOffer(async (fromUid, offerData) => {
      console.info(`[RoomManager] ← offer from ${fromUid.slice(0,6)}`);
      await pcm.handleOffer(fromUid, offerData);
    });

    signal.onAnswer(async (fromUid, answerData) => {
      console.info(`[RoomManager] ← answer from ${fromUid.slice(0,6)}`);
      await pcm.handleAnswer(fromUid, answerData);
    });

    signal.onIceCandidate(async (fromUid, candidateData) => {
      console.log(`[VideoDebug] received ICE from=${fromUid}`);
      await pcm.handleIceCandidate(fromUid, candidateData);
    });

    signal.onPeerJoined((peerId, peerData) => {
      console.log(`[VideoDebug] peer discovered=${peerId}`);
      console.info(`[RoomManager] peer joined: ${peerData.name || peerId} (receiveOnly=${_ro})`);
      if (!_ro) {
        // Active participants initiate connections to new peers.
        // Receive-only participants wait for the active peer's offer.
        console.log(`[VideoDebug] connectToPeer=${peerId}`);
        pcm.connectToPeer(peerId);
      }
    });

    signal.onPeerLeft((peerId) => {
      console.info(`[RoomManager] peer left: ${peerId.slice(0,6)}`);
      pcm.closePeer(peerId);
      if (typeof onPeerLeft === 'function') onPeerLeft(peerId);
    });

    // Announce our presence.
    // For active peers: this triggers onPeerJoined on all existing peers → they connectToPeer(us).
    // For passive peers: this allows active peers (who joined later) to find us and send offers.
    console.log(`[VideoDebug] writing own presence`);
    await signal.announcePresence({ uid: myUid, name: myName });
    console.info(`[RoomManager] presence announced in ${roomPath}`);

    // Connect to peers already in the room (active mode only).
    // Note: onPeerJoined (child_added) also fires for existing children, but connectToPeer
    // is idempotent ('new'/'connecting'/'connected' states are all guarded), so the loop
    // is kept for explicit ordering guarantees on slow networks.
    if (!_ro) {
      const existing = await signal.getPresence();
      const existingPeerIds = Object.keys(existing).filter(id => id !== myUid && existing[id] && existing[id].online);
      console.log(`[VideoDebug] existing peers=${JSON.stringify(existingPeerIds)}`);
      for (const peerId of existingPeerIds) {
        console.log(`[VideoDebug] peer discovered=${peerId}`);
        console.log(`[VideoDebug] connectToPeer=${peerId}`);
        await pcm.connectToPeer(peerId);
      }
    }

    // Network reconnect recovery
    const stopNetworkWatch = ConnectionRecovery.watchNetworkReconnect(async () => {
      console.info('[RoomManager] Network reconnected — re-announcing presence');
      await signal.announcePresence({ uid: myUid, name: myName });
    });

    async function leave() {
      stopNetworkWatch();
      ConnectionRecovery.clearAll();
      await signal.removePresence();
      signal.cleanup();
      pcm.closeAll();
    }

    return { signal, pcm, leave };
  }

  return { join };
})();

window.RoomManager = RoomManager;

console.info('[CoLearn] WebRTC Manager loaded. TURN:', WebRTCConfig.hasTurn ? 'configured' : 'not configured (STUN only)');
