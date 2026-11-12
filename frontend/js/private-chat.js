/* ── private-chat.js – CoLearn Private Messaging ──────────────
 *
 * Public API (module-scope):
 *   initPrivateChat(userId, userName)
 *   openPrivateConversation(peerId, peerName)
 *   closePrivateChatPanel()
 *   togglePrivateChatPanel()
 *   showConversationList()
 *   sendPrivateMessage()
 *   handlePrivateTyping()
 *   toggleEmojiPicker()
 *   clearReply()
 *   cleanupPrivateChat()
 *
 * Firestore: privateChats/{convId} + privateChats/{convId}/messages/{msgId}
 * RTDB: privateTyping/{convId}/{uid}
 */
'use strict';

var _pcUserId    = null;
var _pcUserName  = null;
var _pcConvId    = null;
var _pcPeerId    = null;
var _pcPeerName  = null;
var _pcUnsubs    = [];
var _pcMsgUnsub  = null;
var _pcTypUnsub  = null;
var _pcTypTimer  = null;
var _pcConvs     = {};
var _pcReplyTo   = null;
var _pcPanelOpen = false;
var _pcEmojiOpen = false;
var _pcCtxMenu   = null;

var PC_EMOJIS = ['😀','😂','😍','🤔','😎','😢','😄','😅','🥳','👍','👎','🙏',
                 '🔥','❤️','💯','🎉','🚀','✔️','❌','❓','⚠️','🤗','💤','⌛',
                 '📝','📚','💻','📱','🌍','👨‍💻','🌟','🤝'];

/* ══ Public Functions ════════════════════════════════════════ */

function initPrivateChat(userId, userName) {
  _pcUserId   = userId;
  _pcUserName = userName;
  _buildEmojiPicker();
  _listenAllConvs();

  console.info('[PrivateChat] init', userId);
}

function openPrivateConversation(peerId, peerName) {
  if (!_pcUserId && window.AppState && window.AppState.currentUser) {
    initPrivateChat(window.AppState.currentUser.uid, window.AppState.currentUser.name);
  }
  if (!_pcUserId && window.fsAuth && window.fsAuth.currentUser) {
    initPrivateChat(window.fsAuth.currentUser.uid, window.fsAuth.currentUser.displayName || 'User');
  }
  if (!_pcUserId) return;

  _pcPeerId   = peerId;
  _pcPeerName = peerName;
  _pcConvId   = [_pcUserId, peerId].sort().join('_');
  _pcReplyTo  = null;
  _hidePCReply();

  _pcPanelOpen = true;
  _pcShowPanel(true);

  // Close AI or group chat panel if open to prevent screen clutter
  const chatPanel = document.getElementById('chat-panel');
  if (chatPanel && chatPanel.classList.contains('open') && window.AppState) {
    window.AppState.chatOpen = false;
    chatPanel.classList.remove('open');
    const chatBtn = document.getElementById('btn-chat');
    if (chatBtn) chatBtn.classList.remove('active-tool');
  }

  var listEl = document.getElementById('pc-conversation-list');
  var convEl = document.getElementById('pc-active-conversation');
  if (listEl) listEl.style.display = 'none';
  if (convEl) convEl.style.display = 'flex';

  var nameEl = document.getElementById('pc-peer-name');
  if (nameEl) nameEl.textContent = peerName;

  var statusEl = document.getElementById('pc-peer-status');
  if (statusEl) {
    var presenceMap = window._suitePresenceMap || {};
    var isPeerOnline = !!(presenceMap[peerId] && presenceMap[peerId].online);
    statusEl.innerHTML = isPeerOnline
      ? '<span style="color:var(--fl-green, #16a34a);font-weight:600;">● Online</span>'
      : '<span style="color:var(--fl-text-muted, #64748b);">○ Offline</span>';
  }

  _listenMsgs(_pcConvId);
  _markRead(_pcConvId);
}

function closePrivateChatPanel() {
  _pcPanelOpen = false;
  _pcShowPanel(false);
  _stopMsgListener();
}

function togglePrivateChatPanel() {
  if (_pcPanelOpen) { closePrivateChatPanel(); } else { _pcPanelOpen = true; _pcShowPanel(true); }
}

function showConversationList() {
  _stopMsgListener();
  _pcPeerId = _pcPeerName = _pcConvId = null;
  var listEl = document.getElementById('pc-conversation-list');
  var convEl = document.getElementById('pc-active-conversation');
  if (listEl) listEl.style.display = 'flex';
  if (convEl) convEl.style.display = 'none';
}

// Reconnect listeners if Firebase auth completes
window.addEventListener('firebaseAuthReady', function(e) {
  var uid = e.detail && e.detail.uid;
  if (uid && (!_pcUserId || _pcUserId === uid)) {
    _pcUserId = uid;
    if (window.AppState && window.AppState.currentUser) {
      _pcUserName = window.AppState.currentUser.name || _pcUserName;
    }
    _listenAllConvs();
    if (_pcConvId) {
      _listenMsgs(_pcConvId);
    }
  }
});

async function sendPrivateMessage() {
  console.log('[PC] PRIVATE_SEND_CLICK fired');
  var input = document.getElementById('pc-message-input');
  if (!input) {
    console.error('[PC] FAIL: Input #pc-message-input not found in DOM.');
    return;
  }
  var text = (input.value || '').trim();
  if (!text) {
    console.log('[PC] Empty text, ignoring.');
    return;
  }
  console.log('[PC] Step 1: text="' + text + '"');

  // Ensure current user credentials without clearing input
  if (!_pcUserId && window.AppState && window.AppState.currentUser) {
    _pcUserId   = window.AppState.currentUser.uid;
    _pcUserName = window.AppState.currentUser.name || 'User';
    console.log('[PC] Got userId from AppState:', _pcUserId);
  }
  if (!_pcUserId && window.fsAuth && window.fsAuth.currentUser) {
    _pcUserId   = window.fsAuth.currentUser.uid;
    _pcUserName = window.fsAuth.currentUser.displayName || 'User';
    console.log('[PC] Got userId from fsAuth:', _pcUserId);
  }
  if (!_pcUserId) {
    console.error('[PC] FAIL: User not authenticated. AppState:', !!window.AppState, 'fsAuth:', !!(window.fsAuth && window.fsAuth.currentUser));
    if (typeof showToast === 'function') showToast('main-toast', 'Please log in to send messages.', 'dark');
    return;
  }

  // Ensure recipient and conversation ID
  if (!_pcPeerId) {
    console.error('[PC] FAIL: No recipient (_pcPeerId is null).');
    if (typeof showToast === 'function') showToast('main-toast', 'Please select a conversation first.', 'dark');
    return;
  }

  if (!_pcConvId) {
    _pcConvId = [_pcUserId, _pcPeerId].sort().join('_');
  }
  console.log('[PC] Step 2: userId=' + _pcUserId + ' peerId=' + _pcPeerId + ' convId=' + _pcConvId);

  if (!window.fsDb) {
    console.error('[PC] FAIL: window.fsDb is', window.fsDb);
    if (typeof showToast === 'function') showToast('main-toast', 'Chat database not connected.', 'dark');
    return;
  }
  console.log('[PC] Step 3: fsDb available');

  try {
    // If Client SDK auth is missing or mismatched, authenticate with backend token first
    if (window.fsAuth && (!window.fsAuth.currentUser || window.fsAuth.currentUser.uid !== _pcUserId)) {
      console.log('[PC] Step 3b: Authenticating Firebase client for', _pcUserId);
      if (typeof window.authenticateFirebaseClient === 'function') {
        try {
          await window.authenticateFirebaseClient(_pcUserId);
          console.log('[PC] Step 3b: Firebase client auth result, currentUser:', window.fsAuth.currentUser ? window.fsAuth.currentUser.uid : 'null');
        } catch (authErr) {
          console.warn('[PC] Step 3b: Firebase client auth error:', authErr.message);
        }
      }
    }

    var msgData = {
      text: text,
      senderUid: String(_pcUserId),
      senderName: String(_pcUserName || 'User'),
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      read: false,
      deleted: false,
    };

    if (_pcReplyTo && _pcReplyTo.id) {
      msgData.replyTo = {
        id: String(_pcReplyTo.id),
        text: String(_pcReplyTo.text || '').substring(0, 80)
      };
    }

    var convRef = window.fsDb.collection('privateChats').doc(_pcConvId);
    var participantNames = {};
    participantNames[String(_pcUserId)] = String(_pcUserName || 'User');
    participantNames[String(_pcPeerId)] = String(_pcPeerName || 'Member');

    // 1. Ensure conversation metadata document exists in Firestore
    console.log('[PC] Step 4: Writing conversation metadata to privateChats/' + _pcConvId + '...');
    await convRef.set({
      participants: [String(_pcUserId), String(_pcPeerId)],
      participantNames: participantNames,
      lastMessage: text.substring(0, 60),
      lastMessageAt: firebase.firestore.FieldValue.serverTimestamp(),
      lastSenderId: String(_pcUserId),
    }, { merge: true });
    console.log('[PC] Step 4: Conversation metadata written OK');

    // 2. Add the message to the conversation's messages subcollection
    console.log('[PC] Step 5: Adding message to messages subcollection...');
    var msgRef = await convRef.collection('messages').add(msgData);
    console.log('[PC] Step 5: Message added OK, id=' + msgRef.id);

    // 3. Increment unread counter for the peer (non-critical)
    try {
      var unreadUpdate = {};
      unreadUpdate['unreadCount.' + String(_pcPeerId)] = firebase.firestore.FieldValue.increment(1);
      unreadUpdate['unreadCount.' + String(_pcUserId)] = 0;
      await convRef.update(unreadUpdate);
      console.log('[PC] Step 6: Unread counters updated OK');
    } catch (unreadErr) {
      console.warn('[PC] Step 6: Unread counter update failed (non-critical):', unreadErr.message);
    }

    // 4. SUCCESS: Now safely clear input and active reply preview
    console.log('[PC] Step 7: SUCCESS - clearing input');
    input.value = '';
    input.focus();
    _pcReplyTo = null;
    _hidePCReply();
    _clearTyping();

    // 5. Ensure real-time message listener is attached
    if (!_pcMsgUnsub) {
      console.log('[PC] Step 8: Attaching message listener');
      _listenMsgs(_pcConvId);
    }

    // 6. Send notification to peer if handler exists
    if (typeof writeNotification === 'function') {
      writeNotification(_pcPeerId, 'private_message', {
        title: (_pcUserName || 'Someone') + ' sent you a message',
        body: text.substring(0, 60),
        data: { fromUid: _pcUserId, fromName: _pcUserName || 'User' },
      });
    }
  } catch (e) {
    // If sending fails: KEEP the typed message in input so nothing is lost!
    console.error('[PC] SEND FAILED at some step:', e.message, e.code, e);
    if (typeof showToast === 'function') {
      showToast('main-toast', 'Could not send message: ' + (e.code || e.message || 'Error'), 'dark');
    }
  }
}

function handlePrivateTyping() {
  if (!_pcConvId || !_pcUserId || !window.fsRtdb) return;
  window.fsRtdb.ref('privateTyping/' + _pcConvId + '/' + _pcUserId).set({ typing: true, name: _pcUserName });
  clearTimeout(_pcTypTimer);
  _pcTypTimer = setTimeout(_clearTyping, 3000);
}

function toggleEmojiPicker() {
  _pcEmojiOpen = !_pcEmojiOpen;
  var p = document.getElementById('pc-emoji-picker');
  if (p) p.classList.toggle('hidden', !_pcEmojiOpen);
}

function clearReply() {
  _pcReplyTo = null;
  _hidePCReply();
}

function cleanupPrivateChat() {
  _pcUnsubs.forEach(function(fn) { try { fn(); } catch (_) {} });
  _pcUnsubs = [];
  _stopMsgListener();
  _clearTyping();
  if (_pcCtxMenu) { try { _pcCtxMenu.remove(); } catch (_) {} _pcCtxMenu = null; }
  _pcUserId = _pcUserName = _pcConvId = _pcPeerId = _pcPeerName = null;
  _pcPanelOpen = false;
  _pcShowPanel(false);
}

/* ══ Internal ════════════════════════════════════════════════ */

function _listenAllConvs() {
  if (!window.fsDb || !_pcUserId) {
    console.warn('[PC] _listenAllConvs: Cannot listen. fsDb:', !!window.fsDb, '_pcUserId:', _pcUserId);
    return;
  }
  console.log('[PC] _listenAllConvs: Setting up listener for user', _pcUserId);
  // Note: Omit orderBy in Firestore query to avoid requiring composite indexes on participants array-contains
  var unsub = window.fsDb
    .collection('privateChats')
    .where('participants', 'array-contains', _pcUserId)
    .limit(50)
    .onSnapshot(function(snap) {
      _pcConvs = {};
      snap.forEach(function(doc) { _pcConvs[doc.id] = Object.assign({ id: doc.id }, doc.data()); });
      console.log('[PC] _listenAllConvs: Got', Object.keys(_pcConvs).length, 'conversations');
      _renderConvList();
      _updatePCBadge();
    }, function(err) {
      console.error('[PC] _listenAllConvs ERROR:', err.code, err.message);
    });
  _pcUnsubs.push(unsub);
}

function _listenMsgs(convId) {
  _stopMsgListener();
  if (!window.fsDb || !convId) return;

  console.log('[PC] _listenMsgs: Listening to messages in', convId);
  _pcMsgUnsub = window.fsDb
    .collection('privateChats').doc(convId)
    .collection('messages')
    .orderBy('timestamp', 'asc')
    .limit(100)
    .onSnapshot(function(snap) {
      console.log('[PC] _listenMsgs: Got', snap.size, 'messages');
      _renderMsgs(snap);
    }, function(err) {
      console.error('[PC] _listenMsgs ERROR:', err.code, err.message);
    });

  if (window.fsRtdb && _pcPeerId) {
    var ref = window.fsRtdb.ref('privateTyping/' + convId + '/' + _pcPeerId);
    ref.on('value', function(snap) {
      var d = snap.val();
      var el = document.getElementById('pc-typing-indicator');
      if (el) el.textContent = (d && d.typing) ? (d.name || 'Peer') + ' is typing…' : '';
    });
    _pcTypUnsub = function() { ref.off(); };
  }
}

function _stopMsgListener() {
  if (_pcMsgUnsub) { try { _pcMsgUnsub(); } catch (_) {} _pcMsgUnsub = null; }
  if (_pcTypUnsub) { try { _pcTypUnsub(); } catch (_) {} _pcTypUnsub = null; }
  var ind = document.getElementById('pc-typing-indicator');
  if (ind) ind.textContent = '';
}

function _renderMsgs(snap) {
  var c = document.getElementById('pc-messages');
  if (!c) return;
  c.innerHTML = '';

  if (!snap || snap.empty) {
    c.innerHTML = '<div style="padding:2rem 1rem;text-align:center;color:var(--fl-text-muted,#94a3b8);font-size:0.85rem;"><div style="font-size:1.8rem;margin-bottom:0.4rem;">💬</div>No messages yet. Send a message to start chatting!</div>';
    return;
  }

  var currentUid = _pcUserId || (window.AppState && window.AppState.currentUser ? window.AppState.currentUser.uid : (window.fsAuth && window.fsAuth.currentUser ? window.fsAuth.currentUser.uid : ''));

  snap.forEach(function(doc) {
    var msg = Object.assign({ id: doc.id }, doc.data());
    var own = String(msg.senderUid) === String(currentUid);
    var el = document.createElement('div');
    el.className = 'pc-bubble ' + (own ? 'own' : 'other') + (msg.deleted ? ' deleted' : '');
    el.dataset.msgId = msg.id;

    var h = '';
    if (!own) h += '<div class="pc-bubble-sender">' + escapeHtml(msg.senderName || '') + '</div>';
    if (msg.replyTo && msg.replyTo.text) {
      h += '<div class="pc-reply-context">↩ ' + escapeHtml(msg.replyTo.text) + '</div>';
    }
    h += '<div>' + (msg.deleted ? '<em>This message was deleted</em>' : escapeHtml(msg.text || '')) + '</div>';
    
    var tsStr = 'Just now';
    if (msg.timestamp) {
      var d = msg.timestamp.toDate ? msg.timestamp.toDate() : new Date(msg.timestamp);
      if (d instanceof Date && !isNaN(d.getTime())) {
        tsStr = _fmtTime(d);
      }
    }
    h += '<span class="pc-bubble-time">' + tsStr + '</span>';
    if (own && msg.read) h += '<span class="pc-bubble-seen">Seen</span>';

    el.innerHTML = h;
    el.addEventListener('contextmenu', function(e) { e.preventDefault(); _showMsgCtx(e, msg, own); });
    c.appendChild(el);
  });
  c.scrollTop = c.scrollHeight;
}

function _showMsgCtx(e, msg, own) {
  if (_pcCtxMenu) _pcCtxMenu.remove();
  var m = document.createElement('div');
  m.className = 'msg-context-menu';

  var x = Math.min(e.clientX, window.innerWidth - 160);
  var y = Math.min(e.clientY, window.innerHeight - 120);
  m.style.cssText = 'position:fixed;left:' + x + 'px;top:' + y + 'px;z-index:9999;';

  function item(icon, label, cls, fn) {
    var i = document.createElement('div');
    i.className = 'msg-context-item' + (cls ? ' ' + cls : '');
    i.innerHTML = icon + ' ' + label;
    i.onclick = function() { m.remove(); _pcCtxMenu = null; fn(); };
    m.appendChild(i);
  }

  item('📎', 'Reply', '', function() { _setReply(msg); });
  item('📋', 'Copy', '', function() {
    try { navigator.clipboard.writeText(msg.text || ''); } catch (_) {}
    showToast('main-toast', '✓ Copied', 'dark');
  });
  if (own && !msg.deleted) {
    item('🗑️', 'Delete', 'danger', function() { _deleteMsg(msg.id); });
  }

  document.body.appendChild(m);
  _pcCtxMenu = m;
  setTimeout(function() {
    document.addEventListener('click', function cb() { if (m.parentNode) m.remove(); _pcCtxMenu = null; document.removeEventListener('click', cb); });
  }, 10);
}

function _deleteMsg(id) {
  if (!_pcConvId || !window.fsDb) return;
  window.fsDb.collection('privateChats').doc(_pcConvId).collection('messages').doc(id)
    .update({ deleted: true }).catch(function() {});
}

function _setReply(msg) {
  _pcReplyTo = msg;
  var p = document.getElementById('pc-reply-preview');
  var t = document.getElementById('pc-reply-text');
  if (p) p.style.display = 'block';
  if (t) t.textContent = (msg.text || '').substring(0, 80);
  var inp = document.getElementById('pc-message-input');
  if (inp) inp.focus();
}

function _hidePCReply() {
  var p = document.getElementById('pc-reply-preview');
  var t = document.getElementById('pc-reply-text');
  if (p) p.style.display = 'none';
  if (t) t.textContent = '';
}

function _renderConvList() {
  var c = document.getElementById('pc-conversation-list');
  if (!c) return;
  var list = Object.values(_pcConvs).sort(function(a, b) {
    var aTime = a.lastMessageAt ? (a.lastMessageAt.toDate ? a.lastMessageAt.toDate().getTime() : new Date(a.lastMessageAt).getTime()) : 0;
    var bTime = b.lastMessageAt ? (b.lastMessageAt.toDate ? b.lastMessageAt.toDate().getTime() : new Date(b.lastMessageAt).getTime()) : 0;
    return bTime - aTime;
  });
  if (!list.length) {
    c.innerHTML = '<div style="padding:1rem;text-align:center;color:var(--c-slate);font-size:0.85rem;"><div style="font-size:1.5rem;">✉️</div>No conversations yet</div>';
    return;
  }
  c.innerHTML = list.map(function(conv) {
    var otherId   = (conv.participants || []).find(function(p) { return p !== _pcUserId; }) || '';
    var otherName = ((conv.participantNames || {})[otherId]) || 'Unknown';
    var unread    = ((conv.unreadCount || {})[_pcUserId] || 0);
    var last      = (conv.lastMessage || '').substring(0, 28);
    var safeId    = (otherId || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
    var safeName  = (otherName || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
    return '<div class="pc-conv-item" onclick="openPrivateConversation(\'' + safeId + '\',\'' + safeName + '\')">' +
           '<div class="pc-conv-avatar">' + escapeHtml(otherName[0] ? otherName[0].toUpperCase() : '?') + '</div>' +
           '<div class="pc-conv-info"><div class="pc-conv-name">' + escapeHtml(otherName) + '</div>' +
           '<div class="pc-conv-last">' + escapeHtml(last) + '</div></div>' +
           (unread ? '<div class="pc-unread-dot">' + unread + '</div>' : '') +
           '</div>';
  }).join('');
}

function _markRead(convId) {
  if (!window.fsDb || !convId || !_pcUserId) return;
  var upd = {}; upd['unreadCount.' + _pcUserId] = 0;
  window.fsDb.collection('privateChats').doc(convId).update(upd).catch(function() {});
  window.fsDb.collection('privateChats').doc(convId).collection('messages')
    .where('read', '==', false)
    .get().then(function(snap) {
      var b = window.fsDb.batch();
      var count = 0;
      snap.forEach(function(d) {
        var data = d.data();
        if (data.senderUid && String(data.senderUid) !== String(_pcUserId)) {
          b.update(d.ref, { read: true });
          count++;
        }
      });
      if (count > 0) b.commit().catch(function() {});
    }).catch(function() {});
}

function _updatePCBadge() {
  var total = 0;
  Object.values(_pcConvs).forEach(function(c) { total += ((c.unreadCount || {})[_pcUserId] || 0); });
  var badge = document.getElementById('pc-unread-badge');
  if (!badge) return;
  if (total > 0) { badge.textContent = String(Math.min(total, 99)); badge.style.display = 'flex'; }
  else { badge.style.display = 'none'; }
}

function _clearTyping() {
  clearTimeout(_pcTypTimer);
  if (!window.fsRtdb || !_pcConvId || !_pcUserId) return;
  window.fsRtdb.ref('privateTyping/' + _pcConvId + '/' + _pcUserId).remove().catch(function() {});
}

function _pcShowPanel(show) {
  var p = document.getElementById('private-chat-panel');
  if (p) p.classList.toggle('hidden', !show);
}

function _buildEmojiPicker() {
  var p = document.getElementById('pc-emoji-picker');
  if (!p) return;
  p.innerHTML = PC_EMOJIS.map(function(e) {
    return '<button class="pc-emoji-btn" onclick="insertEmoji(\'' + e + '\')" type="button">' + e + '</button>';
  }).join('');
}

window.insertEmoji = function(emoji) {
  var inp = document.getElementById('pc-message-input');
  if (inp) { inp.value += emoji; inp.focus(); }
  _pcEmojiOpen = false;
  var p = document.getElementById('pc-emoji-picker');
  if (p) p.classList.add('hidden');
};

function _fmtTime(date) {
  if (!date) return '';
  var now = new Date();
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Window attachments
window.initPrivateChat          = initPrivateChat;
window.openPrivateConversation  = openPrivateConversation;
window.closePrivateChatPanel    = closePrivateChatPanel;
window.togglePrivateChatPanel   = togglePrivateChatPanel;
window.showConversationList     = showConversationList;
window.sendPrivateMessage       = sendPrivateMessage;
window.handlePrivateTyping      = handlePrivateTyping;
window.toggleEmojiPicker        = toggleEmojiPicker;
window.clearReply               = clearReply;
window.cleanupPrivateChat       = cleanupPrivateChat;
