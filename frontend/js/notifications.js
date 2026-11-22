/* ── notifications.js – CoLearn Real-time Notifications ───────
 *
 * Public API (module-scope):
 *   initNotifications(userId)         – start Firestore listener (all roles)
 *   showNotification(type, data)      – display toast + update bell
 *   markNotificationRead(notifId)     – mark single notification read
 *   clearAllNotifications()           – clear all for this user
 *   cleanupNotifications()            – unsubscribe (called on leave/logout)
 *   getUnreadNotificationCount()      – returns unread count
 *   writeNotification(uid, type, data) – write notif to Firestore (global)
 *   toggleNotificationPanel(target)   – toggle dropdown ('ws' or dashboard)
 *
 * Firestore: notifications/{userId}/items/{notifId}
 *   { type, title, body, data, timestamp, read }
 */

'use strict';

var _notifUserId    = null;
var _notifUnsub     = null;
var _notifPanelOpen = false;
var _wsNotifPanelOpen = false;
var _notifications  = [];
var _notifRetryTimer = null;

var NOTIF_CONFIG = {
  screen_share_start: { icon: '📺', title: 'Screen Share Started' },
  screen_share_stop:  { icon: '📺', title: 'Screen Share Ended' },
  voice_join:         { icon: '🎤', title: 'Joined Voice' },
  voice_leave:        { icon: '🎤', title: 'Left Voice' },
  video_join:         { icon: '📹', title: 'Joined Video' },
  video_leave:        { icon: '📹', title: 'Left Video' },
  private_message:    { icon: '💬', title: 'Private Message' },
  member_removed:     { icon: '🚫', title: 'Removed from Suite' },
  suite_invitation:   { icon: '🔑', title: 'Suite Invitation' },
  member_joined:      { icon: '👋', title: 'Member Joined' },
  join_request:       { icon: '🙋', title: 'Join Request' },
  generic:            { icon: '🔔', title: 'Notification' },
};

async function initNotifications(userId) {
  if (!userId && window.AppState && window.AppState.currentUser) {
    userId = window.AppState.currentUser.uid;
  }
  if (!userId) return;

  _notifUserId = userId;

  // Request browser notification permission if not yet decided
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(function() {});
  }

  // Ensure Firebase client authentication is established before attaching snapshot listener
  if (typeof window.ensureFirebaseAuth === 'function') {
    try {
      await window.ensureFirebaseAuth(userId);
    } catch (e) {
      console.warn('[Notifications] ensureFirebaseAuth error:', e.message);
    }
  }

  if (!window.fsDb) {
    console.warn('[Notifications] Firestore not available yet. Waiting for initialization.');
    return;
  }

  _attachNotificationListener(userId);
}

function _attachNotificationListener(userId) {
  if (!window.fsDb || !userId) return;

  // If already subscribed to the same user, just refresh UI
  if (_notifUnsub && _notifUserId === userId) {
    _renderNotificationList();
    _updateBadge();
    return;
  }

  if (_notifUnsub) {
    try { _notifUnsub(); } catch (_) {}
    _notifUnsub = null;
  }

  try {
    _notifUnsub = window.fsDb
      .collection('notifications')
      .doc(userId)
      .collection('items')
      .orderBy('timestamp', 'desc')
      .limit(50)
      .onSnapshot(function(snap) {
        _notifications = [];
        snap.forEach(function(doc) {
          _notifications.push(Object.assign({ id: doc.id }, doc.data()));
        });

        // In-memory sort by timestamp descending to handle mixed formats
        _notifications.sort(function(a, b) {
          var tA = a.timestamp ? (a.timestamp.toDate ? a.timestamp.toDate().getTime() : new Date(a.timestamp).getTime()) : 0;
          var tB = b.timestamp ? (b.timestamp.toDate ? b.timestamp.toDate().getTime() : new Date(b.timestamp).getTime()) : 0;
          return tB - tA;
        });

        _renderNotificationList();
        _updateBadge();

        /* Show toast for newest unread */
        var changes = snap.docChanges();
        changes.forEach(function(change) {
          if (change.type === 'added') {
            var n = Object.assign({ id: change.doc.id }, change.doc.data());
            if (!n.read) _onNewNotification(n);
          }
        });
      }, function(err) {
        console.warn('[Notifications] Firestore listener error:', err.message);
        // If permission-denied (auth token exchange still running), retry when auth is confirmed
        if (err.code === 'permission-denied' && !_notifRetryTimer) {
          _notifRetryTimer = setTimeout(async function() {
            _notifRetryTimer = null;
            if (_notifUserId === userId) {
              if (typeof window.ensureFirebaseAuth === 'function') {
                await window.ensureFirebaseAuth(userId).catch(function() {});
              }
              _attachNotificationListener(userId);
            }
          }, 1500);
        }
      });

    console.info('[Notifications] Listening for user', userId);
  } catch (err) {
    console.warn('[Notifications] Failed to setup listener:', err.message);
  }
}

// Global listener for auth readiness
window.addEventListener('firebaseAuthReady', function(e) {
  var readyUid = e.detail && e.detail.uid;
  var targetUid = readyUid || _notifUserId || (window.AppState && window.AppState.currentUser && window.AppState.currentUser.uid);
  if (targetUid) {
    _notifUserId = targetUid;
    _attachNotificationListener(targetUid);
  }
});

function showNotification(type, data) {
  if (!_notifUserId || !window.fsDb) return;
  var cfg = NOTIF_CONFIG[type] || NOTIF_CONFIG.generic;
  var body = (data && data.body) || cfg.title;
  writeNotification(_notifUserId, type, {
    title: cfg.title,
    body:  body,
    data:  data,
  });
}

function markNotificationRead(notifId) {
  if (!_notifUserId || !window.fsDb || !notifId) return;

  // Optimistically mark as read in local memory
  var local = _notifications.find(function(n) { return n.id === notifId; });
  if (local) local.read = true;
  _renderNotificationList();
  _updateBadge();

  window.fsDb
    .collection('notifications').doc(_notifUserId)
    .collection('items').doc(notifId)
    .update({ read: true })
    .catch(function() {});
}

function clearAllNotifications() {
  if (!_notifUserId || !window.fsDb) return;
  var batch = window.fsDb.batch();
  _notifications.forEach(function(n) {
    var ref = window.fsDb.collection('notifications').doc(_notifUserId)
                         .collection('items').doc(n.id);
    batch.delete(ref);
  });
  _notifications = [];
  _renderNotificationList();
  _updateBadge();
  batch.commit().catch(function() {});
}

function cleanupNotifications() {
  if (_notifUnsub) { try { _notifUnsub(); } catch (_) {} _notifUnsub = null; }
  _notifications    = [];
  _notifUserId      = null;
  _notifPanelOpen   = false;
  _wsNotifPanelOpen = false;
  _updateBadge();
  _renderNotificationList();
}

function getUnreadNotificationCount() {
  return _notifications.filter(function(n) { return !n.read; }).length;
}

function toggleNotificationPanel(target) {
  var isWs = target === 'ws' || (!target && window.AppState && window.AppState.currentView === 'view-workspace');

  if (isWs) {
    _wsNotifPanelOpen = !_wsNotifPanelOpen;
    var wsPanel = document.getElementById('ws-notification-dropdown');
    if (wsPanel) wsPanel.classList.toggle('hidden', !_wsNotifPanelOpen);
    if (_wsNotifPanelOpen) {
      setTimeout(function() {
        _notifications.filter(function(n) { return !n.read; }).slice(0, 10).forEach(function(n) {
          markNotificationRead(n.id);
        });
      }, 1500);
    }
  } else {
    _notifPanelOpen = !_notifPanelOpen;
    var dashPanel = document.getElementById('notification-dropdown');
    if (dashPanel) dashPanel.classList.toggle('hidden', !_notifPanelOpen);
    if (_notifPanelOpen) {
      setTimeout(function() {
        _notifications.filter(function(n) { return !n.read; }).slice(0, 10).forEach(function(n) {
          markNotificationRead(n.id);
        });
      }, 1500);
    }
  }
}

/* ── Global: writeNotification ───────────────────────────────── */
window.writeNotification = function(targetUserId, type, data) {
  if (!window.fsDb || !targetUserId) return;
  var cfg = NOTIF_CONFIG[type] || NOTIF_CONFIG.generic;
  data = data || {};
  window.fsDb
    .collection('notifications').doc(targetUserId)
    .collection('items').add({
      type:      type,
      title:     data.title || cfg.title,
      body:      data.body  || '',
      icon:      cfg.icon,
      data:      data.data  || {},
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      read:      false,
    }).catch(function(e) {
      console.warn('[Notifications] writeNotification error:', e.message);
    });
};

/* ── Internal ────────────────────────────────────────────────── */
function _onNewNotification(n) {
  /* Show toast */
  var icon = n.icon || (NOTIF_CONFIG[n.type] || {}).icon || '🔔';
  if (typeof showToast === 'function') {
    showToast('main-toast', icon + ' ' + (n.title || '') + (n.body ? ': ' + n.body : ''), 'dark');
  }
  /* Browser notification for private messages, suite invites, and join requests */
  if ((n.type === 'private_message' || n.type === 'suite_invitation' || n.type === 'join_request') &&
      'Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification('CoLearn - ' + (n.title || ''), {
        body: n.body || '',
        icon: '/favicon.ico',
      });
    } catch (_) {}
  }
}

function _updateBadge() {
  var count = getUnreadNotificationCount();
  var badges = [
    document.getElementById('notification-count'),
    document.getElementById('ws-notification-count')
  ];

  badges.forEach(function(badge) {
    if (!badge) return;
    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.style.display = 'flex';
      badge.classList.remove('hidden');
    } else {
      badge.style.display = 'none';
      badge.classList.add('hidden');
    }
  });
}

function _renderNotificationList() {
  var lists = [
    document.getElementById('notification-list'),
    document.getElementById('ws-notification-list')
  ];

  var html = '';
  if (!_notifications.length) {
    html = '<div style="padding:1.5rem;text-align:center;color:#587D90;font-size:0.85rem;">No notifications</div>';
  } else {
    html = _notifications.slice(0, 30).map(function(n) {
      var cfg = NOTIF_CONFIG[n.type] || NOTIF_CONFIG.generic;
      var icon = n.icon || cfg.icon;
      var time = n.timestamp ? _formatNotifTime(n.timestamp.toDate ? n.timestamp.toDate() : new Date(n.timestamp)) : '';
      return '<div class="notif-item' + (n.read ? '' : ' unread') + '" onclick="_handleNotificationClick(\'' + n.id + '\')">' +
             '<div class="notif-icon">' + escapeHtml(icon) + '</div>' +
             '<div class="notif-body">' +
               '<div class="notif-title">' + escapeHtml(n.title || cfg.title) + '</div>' +
               (n.body ? '<div class="notif-text">' + escapeHtml(n.body) + '</div>' : '') +
               '<div class="notif-time">' + time + '</div>' +
             '</div>' +
             '</div>';
    }).join('');
  }

  lists.forEach(function(list) {
    if (list) list.innerHTML = html;
  });
}

function _handleNotificationClick(notifId) {
  var n = _notifications.find(function(item) { return item.id === notifId; });
  markNotificationRead(notifId);
  if (!n) return;

  // Actionable clicks
  if (n.type === 'private_message' && n.data && n.data.senderUid) {
    if (typeof openPrivateChat === 'function') {
      openPrivateChat(n.data.senderUid, n.data.senderName || 'Peer');
    }
  } else if (n.type === 'join_request' && n.data && n.data.suiteId) {
    if (typeof setWSState === 'function') {
      setWSState('invite');
    }
  }
}

function _formatNotifTime(date) {
  if (!date || isNaN(date.getTime())) return '';
  var now  = new Date();
  var diff = Math.floor((now - date) / 1000);
  if (diff < 60)   return 'Just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return date.toLocaleDateString();
}

/* Close notification panel when clicking outside */
document.addEventListener('click', function(e) {
  var wrapDash = document.getElementById('notification-bell-wrap');
  var wrapWs   = document.getElementById('ws-notification-bell-wrap');

  if (_notifPanelOpen && wrapDash && !wrapDash.contains(e.target)) {
    _notifPanelOpen = false;
    var dashPanel = document.getElementById('notification-dropdown');
    if (dashPanel) dashPanel.classList.add('hidden');
  }

  if (_wsNotifPanelOpen && wrapWs && !wrapWs.contains(e.target)) {
    _wsNotifPanelOpen = false;
    var wsPanel = document.getElementById('ws-notification-dropdown');
    if (wsPanel) wsPanel.classList.add('hidden');
  }
});

window.initNotifications        = initNotifications;
window.showNotification        = showNotification;
window.markNotificationRead     = markNotificationRead;
window.clearAllNotifications    = clearAllNotifications;
window.cleanupNotifications     = cleanupNotifications;
window.getUnreadNotificationCount = getUnreadNotificationCount;
window.toggleNotificationPanel  = toggleNotificationPanel;
window._handleNotificationClick = _handleNotificationClick;
