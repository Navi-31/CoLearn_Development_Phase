/* ── screen-share.js – CoLearn Screen Sharing ─────────────────
 *
 * Provides reliable screen capture and real-time viewing via WebRTC.
 *
 * PRESENTER:
 *   startScreenShare() -> acquires display media -> writes active presenter to RTDB
 *   -> joins screenSignaling as active sender -> sends screen stream to viewers.
 *   Stream track 'ended' event (native browser UI stop) automatically triggers stopScreenShare().
 *
 * VIEWER:
 *   RTDB listener watches suites/{suiteId}/screenShare/active.
 *   When active presenter detected -> joins screenSignaling as receiveOnly -> receives stream.
 *   When presenter stops -> overlay hidden, room left cleanly.
 */

'use strict';

/* ── Module state ────────────────────────────────────────────── */
var _ssSuiteId      = null;
var _ssUserId       = null;
var _ssUserName     = null;
var _ssStream       = null;   // presenter's MediaStream
var _ssRoom         = null;   // RoomManager room handle (presenter OR viewer)
var _ssRtdbRef      = null;   // RTDB ref for onDisconnect cleanup
var _ssRtdbListener = null;   // RTDB value listener ref
var _ssInitialised  = false;
var _ssIsPresenting = false;
var _ssFsTimer      = null;

/* ── Public: initScreenShare ─────────────────────────────────── */
function initScreenShare(suiteId, userId, userName) {
  _ssSuiteId     = suiteId;
  _ssUserId      = userId;
  _ssUserName    = userName;
  _ssInitialised = true;
  _listenForActiveSS();
  _initScreenShareFullscreenHandlers();
  console.info('[ScreenShare] Initialised — suite=' + suiteId + ' user=' + (userId ? userId.slice(0,6) : 'anon'));
}

/* ── Public: startScreenShare ────────────────────────────────── */
async function startScreenShare() {
  if (!_ssInitialised) {
    if (window.AppState && window.AppState.currentSuite && window.AppState.currentUser) {
      initScreenShare(window.AppState.currentSuite.id, window.AppState.currentUser.uid, window.AppState.currentUser.name);
    } else {
      if (typeof showToast === 'function') showToast('main-toast', '⚠️ Screen share not ready.', 'dark');
      return;
    }
  }

  // Prevent duplicate streams: if already presenting, clean up prior stream first
  if (_ssIsPresenting || _ssStream) {
    await stopScreenShare();
  }

  // ── Check if another presenter is active ────────────────────
  if (window.fsDb && _ssSuiteId) {
    try {
      var doc = await window.fsDb.collection('screenSharing').doc(_ssSuiteId).get();
      if (doc.exists && doc.data().isSharing && doc.data().presenterUid !== _ssUserId) {
        var pName = doc.data().presenterName || 'Someone';
        console.info('[ScreenShare] Suite busy — presenter:', pName);
        var busyEl = document.getElementById('ss-busy-presenter');
        if (busyEl) busyEl.textContent = pName;
        if (typeof openModal === 'function') openModal('modal-screen-share-busy');
        return;
      }
    } catch (e) {
      console.warn('[ScreenShare] Busy check warning:', e.message);
    }
  }

  // ── Acquire screen stream ──────────────────────────────────
  console.info('[ScreenShare] Requesting display media…');
  console.log('[ScreenRTC] starting screen share');
  _ssStream = await MediaManager.getDisplayMedia();
  if (!_ssStream) {
    console.info('[ScreenShare] Display media cancelled or denied.');
    return;
  }
  console.info('[ScreenShare] ✅ Screen stream acquired.');

  _ssIsPresenting = true;
  _ssUpdateBtn(true);

  // ── Write to Firestore ─────────────────────────────────────
  if (window.fsDb && _ssSuiteId) {
    try {
      await window.fsDb.collection('screenSharing').doc(_ssSuiteId).set({
        isSharing:     true,
        presenterUid:  _ssUserId,
        presenterName: _ssUserName,
        startedAt:     firebase.firestore.FieldValue.serverTimestamp(),
        suiteId:       _ssSuiteId,
      });
    } catch (e) {
      console.warn('[ScreenShare] Firestore write error:', e.message);
    }
  }

  // ── Write to RTDB ──────────────────────────────────────────
  if (window.fsRtdb && _ssSuiteId) {
    try {
      _ssRtdbRef = window.fsRtdb.ref('suites/' + _ssSuiteId + '/screenShare/active');
      await _ssRtdbRef.set({
        presenterUid:  _ssUserId,
        presenterName: _ssUserName,
        startedAt:     Date.now(),
      });
      _ssRtdbRef.onDisconnect().remove();
    } catch (e) {
      console.warn('[ScreenShare] RTDB write error:', e.message);
    }
  }

  // ── Join signaling room as ACTIVE presenter ────────────────
  console.info('[ScreenShare] Joining screenSignaling as presenter…');
  _ssRoom = await RoomManager.join({
    roomPath:    'suites/' + _ssSuiteId + '/screenSignaling',
    myUid:       _ssUserId,
    myName:      _ssUserName,
    localStream: _ssStream,
    receiveOnly: false,
    onTrack:     function(peerId, stream) {},
    onPeerLeft:  function(peerId) {
      console.info('[ScreenShare] Viewer left:', peerId.slice(0,6));
    },
  });

  _ssUpdateIndicator(true, _ssUserName, true);

  // Only show overlay if user is not on whiteboard
  if (!window.AppState || window.AppState.wsCurrentState !== 'whiteboard') {
    _ssShowOverlay(true, _ssUserName, true);
  }

  // Auto-stop when stream track ends (e.g. user clicks browser "Stop sharing" bar)
  var vt = _ssStream.getVideoTracks()[0];
  if (vt) {
    vt.onended = function() {
      console.info('[ScreenShare] Native stream track ended — stopping share.');
      stopScreenShare();
    };
  }

  console.info('[ScreenShare] ✅ Screen sharing started.');
}

/* ── Public: stopScreenShare ─────────────────────────────────── */
async function stopScreenShare() {
  if (!_ssIsPresenting && !_ssStream && !_ssRoom) {
    _ssShowOverlay(false);
    _ssUpdateIndicator(false);
    _ssUpdateBtn(false);
    return;
  }

  console.info('[ScreenShare] Stopping screen share…');
  _ssIsPresenting = false;
  _ssUpdateBtn(false);
  _ssUpdateIndicator(false);

  // Exit fullscreen if active
  if (document.fullscreenElement) {
    try { document.exitFullscreen().catch(function() {}); } catch (_) {}
  }

  if (_ssStream) {
    MediaManager.stopStream(_ssStream);
    _ssStream = null;
  }

  if (_ssRtdbRef) {
    try { await _ssRtdbRef.remove(); } catch (_) {}
    _ssRtdbRef = null;
  }

  if (window.fsDb && _ssSuiteId) {
    try { await window.fsDb.collection('screenSharing').doc(_ssSuiteId).delete(); } catch (_) {}
  }

  if (_ssRoom) {
    try { await _ssRoom.leave(); } catch (_) {}
    _ssRoom = null;
  }

  var video = document.getElementById('screen-share-video');
  if (video) {
    try {
      video.pause();
      video.srcObject = null;
    } catch (_) {}
  }

  _ssShowOverlay(false);
  console.info('[ScreenShare] ✅ Screen sharing stopped.');
}

/* ── Public: cleanupScreenShare ──────────────────────────────── */
async function cleanupScreenShare() {
  console.info('[ScreenShare] Cleanup (suite leave).');

  if (_ssRtdbListener && window.fsRtdb && _ssSuiteId) {
    try {
      window.fsRtdb.ref('suites/' + _ssSuiteId + '/screenShare/active').off('value', _ssRtdbListener);
    } catch (_) {}
    _ssRtdbListener = null;
  }

  if (_ssIsPresenting) {
    await stopScreenShare();
  } else if (_ssRoom) {
    try { await _ssRoom.leave(); } catch (_) {}
    _ssRoom = null;
  }

  _ssShowOverlay(false);
  _ssUpdateIndicator(false);
  _ssInitialised = false;
}

/* ── Internal: RTDB listener for active screen share ────────── */
function _listenForActiveSS() {
  if (!window.fsRtdb || !_ssSuiteId) {
    return;
  }

  var ref = window.fsRtdb.ref('suites/' + _ssSuiteId + '/screenShare/active');

  _ssRtdbListener = ref.on('value', function(snap) {
    var data = snap.val();

    if (data && data.presenterUid && data.presenterUid !== _ssUserId) {
      console.info('[ScreenShare] Active presenter detected:', data.presenterName);
      _ssUpdateIndicator(true, data.presenterName, false);
      _ssShowOverlay(true, data.presenterName, false);

      if (!_ssRoom) {
        RoomManager.join({
          roomPath:    'suites/' + _ssSuiteId + '/screenSignaling',
          myUid:       _ssUserId,
          myName:      _ssUserName,
          localStream: null,
          receiveOnly: true,
          onTrack:     _ssOnTrack,
          onPeerLeft:  function(peerId) {
            console.info('[ScreenShare] Presenter left:', peerId.slice(0,6));
            _ssUpdateIndicator(false);
            _ssShowOverlay(false);
          },
        }).then(function(r) {
          _ssRoom = r;
          console.info('[ScreenShare] ✅ Viewer joined screenSignaling.');
        }).catch(function(e) {
          console.error('[ScreenShare] Viewer join error:', e.message);
        });
      }
    } else if (!data && !_ssIsPresenting) {
      console.info('[ScreenShare] Active share ended — hiding overlay.');
      _ssUpdateIndicator(false);
      _ssShowOverlay(false);
      if (_ssRoom) {
        _ssRoom.leave().catch(function() {});
        _ssRoom = null;
      }
    }
  });
}

/* ── Track received (viewer side) ────────────────────────────── */
function _ssOnTrack(peerId, stream) {
  console.log('[ScreenRTC] remote screen track peer=' + peerId);
  console.info('[ScreenShare] ✅ Screen stream received from', peerId.slice(0,6));
  var video = document.getElementById('screen-share-video');
  if (video) {
    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }
    video.play().catch(function(e) {
      console.warn('[ScreenShare] Autoplay error:', e.name);
    });
  }
}

/* ── Indicator UI Helper ─────────────────────────────────────── */
function _ssUpdateIndicator(show, presenterName, isOwner) {
  var pill = document.getElementById('ws-screen-share-pill');
  var textEl = document.getElementById('ws-ss-indicator-text');
  var nameEl = document.getElementById('ss-presenter-name');

  var text = '';
  if (isOwner) {
    text = 'You are sharing your screen';
  } else if (presenterName) {
    text = presenterName + ' is sharing their screen';
  } else {
    text = 'Screen sharing is active';
  }

  if (nameEl && show) {
    nameEl.textContent = text;
  }

  if (pill) {
    if (show) {
      if (textEl) textEl.textContent = text;
      pill.classList.add('visible');
    } else {
      pill.classList.remove('visible');
    }
  }
}

/* ── Overlay UI ──────────────────────────────────────────────── */
function _ssShowOverlay(show, presenterName, isOwner) {
  var overlay = document.getElementById('screen-share-overlay');
  if (!overlay) return;
  overlay.classList.toggle('hidden', !show);

  if (show) {
    _ssUpdateIndicator(true, presenterName, isOwner);
    var stopBtn = document.getElementById('btn-stop-screen-share');
    if (stopBtn) stopBtn.style.display = isOwner ? 'inline-flex' : 'none';
  } else {
    var video = document.getElementById('screen-share-video');
    if (video) {
      try {
        video.pause();
        video.srcObject = null;
      } catch (_) {}
    }
  }
}

/* ── Fullscreen Support & Controls Auto-Hide ─────────────────── */
function toggleScreenShareFullscreen() {
  var overlay = document.getElementById('screen-share-overlay');
  if (!overlay) return;

  if (!document.fullscreenElement) {
    if (overlay.requestFullscreen) {
      overlay.requestFullscreen().catch(function(e) {
        console.warn('[ScreenShare] Fullscreen error:', e.message);
      });
    } else if (overlay.webkitRequestFullscreen) {
      overlay.webkitRequestFullscreen();
    }
  } else {
    if (document.exitFullscreen) {
      document.exitFullscreen().catch(function() {});
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
  }
}

function _ssShowFsControls() {
  var header = document.getElementById('screen-share-header');
  if (header) {
    header.style.opacity = '1';
    header.style.pointerEvents = 'auto';
  }
  if (_ssFsTimer) {
    clearTimeout(_ssFsTimer);
    _ssFsTimer = null;
  }
  if (document.fullscreenElement) {
    _ssFsTimer = setTimeout(function() {
      if (document.fullscreenElement && header) {
        header.style.opacity = '0';
        header.style.pointerEvents = 'none';
      }
    }, 3000);
  }
}

var _ssFsHandlersSetup = false;
function _initScreenShareFullscreenHandlers() {
  if (_ssFsHandlersSetup) return;
  _ssFsHandlersSetup = true;

  var overlay = document.getElementById('screen-share-overlay');
  if (!overlay) return;

  overlay.addEventListener('mousemove', function() {
    if (document.fullscreenElement) {
      _ssShowFsControls();
    }
  }, { passive: true });

  overlay.addEventListener('touchstart', function() {
    if (document.fullscreenElement) {
      _ssShowFsControls();
    }
  }, { passive: true });

  document.addEventListener('fullscreenchange', function() {
    var fsBtn = document.getElementById('btn-fullscreen-screen-share');
    var header = document.getElementById('screen-share-header');
    if (document.fullscreenElement && (document.fullscreenElement === overlay || overlay.contains(document.fullscreenElement))) {
      if (fsBtn) fsBtn.innerHTML = '⛶ Exit Fullscreen';
      _ssShowFsControls();
    } else {
      if (fsBtn) fsBtn.innerHTML = '⛶ Fullscreen';
      if (_ssFsTimer) {
        clearTimeout(_ssFsTimer);
        _ssFsTimer = null;
      }
      if (header) {
        header.style.opacity = '1';
        header.style.pointerEvents = 'auto';
      }
    }
  });
}

/* ── Toolbar button state ─────────────────────────────────────── */
function _ssUpdateBtn(active) {
  var tbBtn = document.getElementById('tb-btn-screen-share');
  if (tbBtn) {
    if (active) {
      tbBtn.title = 'Stop Screen Share';
      tbBtn.style.color = '#dc3545';
      tbBtn.classList.add('active-tool');
    } else {
      tbBtn.title = 'Screen Share';
      tbBtn.style.color = 'var(--fl-text-hi, #333)';
      tbBtn.classList.remove('active-tool');
    }
  }

  var btn = document.getElementById('btn-screen-share');
  if (btn) {
    if (active) {
      btn.classList.add('active-tool');
      btn.innerHTML = '<span class="taskbar-icon">📺</span>Sharing';
    } else {
      btn.classList.remove('active-tool');
      btn.innerHTML = '<span class="taskbar-icon">📺</span>Screen';
    }
  }
}

// Global window attachments
window.initScreenShare               = initScreenShare;
window.startScreenShare              = startScreenShare;
window.stopScreenShare               = stopScreenShare;
window.cleanupScreenShare            = cleanupScreenShare;
window.toggleScreenShareFullscreen   = toggleScreenShareFullscreen;

// Auto-initialize fullscreen handlers when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _initScreenShareFullscreenHandlers);
} else {
  _initScreenShareFullscreenHandlers();
}

