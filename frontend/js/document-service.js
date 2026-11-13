/* ── document-service.js – CoLearn Documents with Google Drive ─────
 *
 * Replaces stub implementations with real Google Drive integration.
 * All public function signatures and HTML IDs are preserved exactly.
 *
 * Public API (module-scope, called from HTML):
 *   handleDocumentUpload()          – picks file, checks Drive, uploads
 *   renderDriveFiles(files)         – renders uploaded Drive files list
 *   renderPendingDocuments()        – renders the pending upload queue
 *   previewPendingDocument(id)      – preview a queued (not-yet-uploaded) file
 *   removePendingDocument(id)       – remove from pending queue
 *   attemptDriveUpload(id)          – upload a queued file to Drive
 *   loadSuiteDriveFiles(suiteId)    – fetch + render suite files from backend
 *   openDriveFileViewer(file)       – open Drive file in embedded viewer
 *   deleteDriveFile(fileId,suiteId) – delete a Drive file
 *   connectGoogleDrive()            – open OAuth popup
 *
 * Exposed globals:
 *   window.DocumentService   – singleton instance
 *   window.DocumentMetadata  – class
 */
'use strict';

/* ══ DocumentMetadata ════════════════════════════════════════════ */
function DocumentMetadata(opts) {
  this.id         = opts.id || ('doc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
  this.name       = opts.name || 'Unknown File';
  this.type       = opts.type || 'application/octet-stream';
  this.size       = opts.size || 0;
  this.selectedAt = opts.selectedAt || new Date();
  this.selectedBy = opts.selectedBy || 'Unknown';
  this.status     = opts.status || 'pending'; // 'pending' | 'uploading' | 'uploaded' | 'error'
  this.file       = opts.file || null;
  this.preview    = opts.preview || null;
  this.progress   = opts.progress || 0;
}

DocumentMetadata.prototype.icon = function () {
  var t = this.type;
  if (t.includes('pdf'))                                                        return '📄';
  if (t.includes('word') || t.includes('docx') || t.includes('doc'))           return '📝';
  if (t.includes('presentation') || t.includes('pptx') || t.includes('ppt'))  return '📊';
  if (t.includes('spreadsheet') || t.includes('xlsx') || t.includes('xls') || t.includes('csv')) return '📈';
  if (t.includes('image') || t.includes('png') || t.includes('jpg') || t.includes('jpeg') || t.includes('gif') || t.includes('webp')) return '🖼️';
  if (t.includes('video') || t.includes('mp4') || t.includes('mov'))          return '🎬';
  if (t.includes('audio') || t.includes('mp3') || t.includes('wav'))          return '🎵';
  if (t.includes('zip') || t.includes('compressed') || t.includes('rar'))     return '📦';
  if (t.includes('text') || t.includes('json') || t.includes('xml') || t.includes('html') || t.includes('css')) return '📃';
  return '📎';
};

DocumentMetadata.prototype.formattedSize = function () {
  var s = this.size;
  if (s < 1024)        return s + ' B';
  if (s < 1024 * 1024) return (s / 1024).toFixed(1) + ' KB';
  return (s / 1024 / 1024).toFixed(1) + ' MB';
};

DocumentMetadata.prototype.formattedTime = function () {
  var d   = this.selectedAt;
  var now = new Date();
  var diff = Math.floor((now - d) / 1000);
  if (diff < 60)    return 'Just now';
  if (diff < 3600)  return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return d.toLocaleDateString();
};

window.DocumentMetadata = DocumentMetadata;

/* ══ Upload Error Log ═══════════════════════════════════════════ */
/* Keeps the last 5 upload errors for the debug endpoint and console helper. */
var _recentUploadErrors = [];
function _logUploadError(fileName, errorMsg) {
  _recentUploadErrors.unshift({
    fileName:  fileName  || 'unknown',
    error:     errorMsg  || 'unknown error',
    at:        new Date().toISOString(),
  });
  if (_recentUploadErrors.length > 5) _recentUploadErrors.length = 5;
}
function getRecentUploadErrors() { return _recentUploadErrors.slice(); }

/* ══ UploadQueue ════════════════════════════════════════════════ */
function UploadQueue() {
  this._items    = [];
  this._onChange = null;
}
UploadQueue.prototype.add = function (doc) {
  this._items.push(doc);
  this._notify();
};
UploadQueue.prototype.remove = function (id) {
  this._items = this._items.filter(function (d) { return d.id !== id; });
  this._notify();
};
UploadQueue.prototype.get    = function (id) { return this._items.find(function (d) { return d.id === id; }) || null; };
UploadQueue.prototype.getAll = function ()   { return this._items.slice(); };
UploadQueue.prototype.clear  = function ()   { this._items = []; this._notify(); };
Object.defineProperty(UploadQueue.prototype, 'onChange', {
  set: function (fn) { this._onChange = fn; },
});
UploadQueue.prototype._notify = function () {
  if (typeof this._onChange === 'function') this._onChange(this._items);
};

/* ══ DocumentServiceClass ════════════════════════════════════════ */

/* ── Queue persistence helpers (metadata only — File binary cannot be serialized) */
var QUEUE_STORAGE_KEY = 'colearn_upload_queue';

function _saveQueueToStorage(items) {
  try {
    var serializable = items.map(function (d) {
      return {
        id: d.id, name: d.name, type: d.type, size: d.size,
        selectedAt: d.selectedAt ? d.selectedAt.toISOString() : null,
        selectedBy: d.selectedBy, status: d.status, progress: d.progress,
        suiteId: (window.AppState && window.AppState.currentSuite) ? window.AppState.currentSuite.id : null,
        needsReselect: true,  // File binary not preserved
      };
    });
    localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(serializable));
  } catch (e) { /* storage full or private mode — non-fatal */ }
}

function _loadQueueFromStorage(targetSuiteId) {
  try {
    var raw = localStorage.getItem(QUEUE_STORAGE_KEY);
    if (!raw) return [];
    var items = JSON.parse(raw);
    // Filter to items for the current suite only
    return items
      .filter(function (d) { return d.suiteId === targetSuiteId && d.status !== 'uploaded'; })
      .map(function (d) {
        var meta           = new DocumentMetadata({
          id: d.id, name: d.name, type: d.type, size: d.size,
          selectedAt: d.selectedAt ? new Date(d.selectedAt) : new Date(),
          selectedBy: d.selectedBy, status: 'error',  // needs re-select
          progress: 0, file: null,
        });
        meta.needsReselect = true;
        return meta;
      });
  } catch (e) { return []; }
}

function _clearQueueStorage() {
  try { localStorage.removeItem(QUEUE_STORAGE_KEY); } catch (e) {}
}

function DocumentServiceClass() {
  this.queue = new UploadQueue();
  var self   = this;
  this.queue.onChange = function (items) {
    _saveQueueToStorage(items);
    renderPendingDocuments();
  };

  // Supported file types (expanded for Drive)
  this.allowedExtensions = [
    'pdf','doc','docx','ppt','pptx','xls','xlsx','csv','txt',
    'zip','rar','7z','png','jpg','jpeg','gif','webp','svg',
    'mp4','mov','avi','mkv','mp3','wav',
    'c','cpp','py','java','js','ts','json','xml','html','css','sql',
    'apk','iso','md','log',
  ];
  this.maxSizeBytes = 200 * 1024 * 1024; // 200 MB
}

DocumentServiceClass.prototype.selectFile = function () {
  return new Promise(function (resolve) {
    var input  = document.createElement('input');
    input.type = 'file';
    // Accept everything — Drive takes all file types
    input.accept = '*/*';
    input.onchange = function (e) { resolve(e.target.files[0] || null); };
    input.click();
    window.addEventListener('focus', function cb() {
      setTimeout(function () { if (!input.files.length) resolve(null); }, 400);
      window.removeEventListener('focus', cb);
    }, { once: true });
  });
};

DocumentServiceClass.prototype.validateFile = function (file) {
  if (!file) return { valid: false, error: 'No file selected.' };
  if (file.size > this.maxSizeBytes) {
    return {
      valid: false,
      error: 'File too large. Maximum: 200 MB. Selected: ' + (file.size / 1024 / 1024).toFixed(1) + ' MB',
    };
  }
  return { valid: true };
};

DocumentServiceClass.prototype.queueUpload = function (file, selectedBy) {
  var meta = new DocumentMetadata({
    name: file.name, type: file.type, size: file.size,
    selectedAt: new Date(), selectedBy: selectedBy || 'You',
    status: 'pending', file: file,
  });
  this.queue.add(meta);
  return meta;
};

DocumentServiceClass.prototype.previewDocument = function (docMeta) {
  if (!docMeta || !docMeta.file) return;
  var url = URL.createObjectURL(docMeta.file);
  window.open(url, '_blank');
  setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
};

DocumentServiceClass.prototype.initialize = function () { return this; };

/* ── Singleton ─────────────────────────────────────────────────── */
window.DocumentService = new DocumentServiceClass();

/* ══ Drive OAuth connection state ════════════════════════════════ */
var _driveConnected = null; // null=unknown, true=connected, false=not connected
var _driveEmail     = '';

async function _checkDriveStatus() {
  if (!window.AppState || !window.AppState.currentUser) return false;
  try {
    var data = await API.getDriveStatus();
    _driveConnected = data.connected === true;
    _driveEmail     = data.googleEmail || '';
    _updateDriveStatusBadge();
    return _driveConnected;
  } catch (e) {
    _driveConnected = false;
    return false;
  }
}

function _updateDriveStatusBadge() {
  if (window.DocumentService) {
    window.DocumentService.driveConnected = _driveConnected;
  }
  var badge      = document.getElementById('drive-status-badge');
  var homeBadge  = document.getElementById('drive-status-badge-home');
  var emailEl    = document.getElementById('drive-connected-email');
  var banner     = document.getElementById('drive-connect-banner');
  var homeBanner = document.getElementById('drive-connect-banner-home');

  if (_driveConnected) {
    if (badge) {
      badge.style.display = 'flex';
      badge.style.color   = 'var(--c-green)';
      badge.innerHTML     = '✅ Connected' + (_driveEmail ? ' · ' + escapeHtml(_driveEmail) : '');
    }
    if (homeBadge) {
      homeBadge.style.display = 'flex';
      homeBadge.style.color   = 'var(--c-green)';
      homeBadge.innerHTML     = '✅ Connected' + (_driveEmail ? ' · ' + escapeHtml(_driveEmail) : '');
    }
    if (emailEl) emailEl.textContent = _driveEmail;
    if (banner) banner.style.display = 'none';
    if (homeBanner) homeBanner.style.display = 'none';
  } else {
    if (badge) {
      badge.style.color = 'var(--c-slate)';
      badge.innerHTML   = '⚠️ Not connected';
    }
    if (homeBadge) {
      homeBadge.style.color = 'var(--c-slate)';
      homeBadge.innerHTML   = '⚠️ Not connected';
    }
    if (banner) banner.style.display = 'flex';
    if (homeBanner) homeBanner.style.display = 'flex';
  }
}

/* ══ Connect Google Drive (OAuth popup) ══════════════════════════ */
async function connectGoogleDrive() {
  var btn = document.getElementById('btn-connect-drive');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Connecting…'; }

  try {
    var data = await API.getDriveAuthUrl();
    if (!data.success) {
      if (data.error === 'DRIVE_NOT_CONFIGURED') {
        showToast('main-toast',
          '⚙️ Google Drive not configured — add real credentials to backend/.env and restart the server.',
          'dark');
        console.error('[Drive] Server says:', data.message);
      } else {
        showToast('main-toast', '⚠️ Could not get auth URL: ' + (data.error || 'Unknown error'), 'dark');
      }
      return;
    }
    if (!data.url) {
      showToast('main-toast', '⚠️ Auth URL missing from server response.', 'dark');
      return;
    }

    // Open OAuth consent as a popup (no redirect inside main window)
    var popup = window.open(data.url, 'drive_oauth', 'width=500,height=640,scrollbars=yes,resizable=yes');

    // postMessage handler — popup sends this on success OR failure
    function handleOAuthMessage(event) {
      if (!event.data || event.data.type !== 'drive_oauth') return;
      window.removeEventListener('message', handleOAuthMessage);
      clearInterval(popupCheck); // stop the fallback checker
      if (popup && !popup.closed) popup.close();

      if (event.data.success) {
        _driveConnected = true;
        _updateDriveStatusBadge();
        _checkDriveStatus(); // fetches email + updates badge
        showToast('main-toast', '✅ Google Drive connected! Resuming upload…', 'dark');
        _resumePendingUploads(); // ← auto-start all queued files
      } else {
        showToast('main-toast', '⚠️ Drive connection failed: ' + (event.data.message || 'Unknown error'), 'dark');
      }
    }
    window.addEventListener('message', handleOAuthMessage);

    // Fallback: user closed popup manually without postMessage
    var popupCheck = setInterval(function () {
      if (popup && popup.closed) {
        clearInterval(popupCheck);
        window.removeEventListener('message', handleOAuthMessage);
        // Re-check in case they completed auth then manually closed the window
        _checkDriveStatus().then(function (connected) {
          if (connected) {
            showToast('main-toast', '✅ Google Drive connected! Resuming upload…', 'dark');
            _resumePendingUploads(); // ← also auto-start here
          }
        });
      }
    }, 800);

  } catch (e) {
    showToast('main-toast', '⚠️ ' + e.message, 'dark');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔗 Connect Google Drive'; }
  }
}

/* ══ handleDocumentUpload – entry point from "Upload Document" btn ═ */
async function handleDocumentUpload() {
  var btn = document.getElementById('btn-upload-document');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Selecting…'; }

  try {
    var file = await window.DocumentService.selectFile();
    if (!file) return;

    var validation = window.DocumentService.validateFile(file);
    if (!validation.valid) {
      showToast('main-toast', '⚠️ ' + validation.error, 'dark');
      return;
    }

    // Check Drive connection (lazy-load status)
    if (_driveConnected === null) {
      await _checkDriveStatus();
    }

    var user = (window.AppState && window.AppState.currentUser) ? window.AppState.currentUser.name : 'You';

    if (!_driveConnected) {
      // Queue file and prompt to connect Drive
      window.DocumentService.queueUpload(file, user);
      _showDriveConnectPrompt(file.name);
      return;
    }

    // Queue it + auto-start upload
    var meta = window.DocumentService.queueUpload(file, user);
    showToast('main-toast', '☁️ Uploading "' + file.name + '" to Google Drive…', 'dark');
    // Use setTimeout so the card renders before upload starts
    setTimeout(function () { attemptDriveUpload(meta.id); }, 100);

  } catch (e) {
    console.error('[DocumentService] upload error:', e.message);
    showToast('main-toast', '⚠️ Could not open file picker.', 'dark');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '➕ Upload Document'; }
  }
}

function _showDriveConnectPrompt(fileName) {
  showToast('main-toast', '🔗 Connect Google Drive to upload "' + fileName + '"', 'dark');
  var banner = document.getElementById('drive-connect-banner');
  if (banner) {
    banner.style.display = 'flex';
    banner.style.animation = 'pulse 0.6s ease 3';
  }
}

/* ══ _resumePendingUploads – auto-start all queued files after OAuth ═══
 *
 * ROOT CAUSE FIX for "No active suite" toast:
 *   This function is called by connectGoogleDrive() immediately after OAuth
 *   succeeds. If the user opened the Drive consent popup from the DASHBOARD
 *   (not the workspace), AppState.currentSuite is null at that moment.
 *   Every queued file then hits the _currentSuiteId() === null guard inside
 *   attemptDriveUpload() and shows the "No active suite" toast.
 *
 *   Fix: guard here, before any upload is attempted. Files will be
 *   auto-started when the user enters the workspace (loadSuiteDriveFiles
 *   restores the queue and Drive is already connected).
 */
function _resumePendingUploads() {
  // ── Suite guard ──────────────────────────────────────────────────────────
  if (!_currentSuiteId()) {
    console.log('[DocumentService] _resumePendingUploads: no active suite — uploads deferred until workspace entry.');
    return; // Files will auto-upload when workspace loads (Drive is now connected).
  }
  // ────────────────────────────────────────────────────────────────────────

  // Only upload items that actually have a File binary (not needsReselect stubs)
  var pending = window.DocumentService.queue.getAll().filter(function (d) {
    return (d.status === 'pending' || d.status === 'error') && !d.needsReselect && d.file;
  });

  if (!pending.length) return;

  // Stagger uploads slightly so progress bars don't conflict visually
  pending.forEach(function (doc, i) {
    setTimeout(function () {
      if ((doc.status === 'pending' || doc.status === 'error') && !doc.needsReselect && doc.file) {
        showToast('main-toast', '☁️ Uploading "' + doc.name + '" to Google Drive…', 'dark');
        attemptDriveUpload(doc.id);
      }
    }, i * 400);
  });
}

/* ══ attemptDriveUpload – upload a queued file to Google Drive ════ */
async function attemptDriveUpload(id) {
  var doc = window.DocumentService.queue.get(id);
  if (!doc) {
    showToast('main-toast', '⚠️ File not found in queue.', 'dark');
    return;
  }

  var suiteId = _currentSuiteId();
  if (!suiteId && window.AppState && window.AppState.currentSuite) {
    suiteId = window.AppState.currentSuite.id || window.AppState.currentSuite.suiteId;
  }
  if (!suiteId && typeof localStorage !== 'undefined') {
    try {
      var raw = localStorage.getItem('fs_suite');
      if (raw) {
        var s = JSON.parse(raw);
        if (s) suiteId = s.id || s.suiteId;
      }
    } catch (e) {}
  }
  if (!suiteId && doc && doc.suiteId) {
    suiteId = doc.suiteId;
  }

  if (!suiteId) {
    showToast('main-toast', '⚠️ No active suite. Please join a suite first.', 'dark');
    return;
  }

  // Check Drive connection
  if (!_driveConnected) {
    _showDriveConnectPrompt(doc.name);
    return;
  }

  var userProfile = (window.AppState && window.AppState.currentUser)
    ? window.AppState.currentUser
    : (typeof localStorage !== 'undefined' && localStorage.getItem('fs_user') ? (JSON.parse(localStorage.getItem('fs_user') || '{}')) : null);
  var uid = userProfile ? (userProfile.uid || userProfile.id || '') : ((typeof window !== 'undefined' && window.fsAuth && window.fsAuth.currentUser) ? window.fsAuth.currentUser.uid : '');
  var authToken = userProfile ? (userProfile.token || userProfile.idToken || userProfile.accessToken || userProfile.uid) : '';
  if (!authToken && typeof window !== 'undefined' && window.fsAuth && window.fsAuth.currentUser) {
    authToken = window.fsAuth.currentUser.uid || '';
  }

  // No file binary — item needs re-selection
  if (doc.needsReselect || !doc.file) {
    doc.status = 'error';
    _updatePendingCard(doc.id, 'error', 0, 'File lost on navigation — please re-upload');
    showToast('main-toast', '⚠️ Please re-upload "' + doc.name + '" — file was not preserved across navigation.', 'dark');
    return;
  }

  // Immediately update local file state from 'Pending' to 'Uploading' upon triggering API
  doc.status   = 'uploading';
  doc.progress = doc.progress || 0;
  _updatePendingCard(doc.id, 'uploading', doc.progress);

  // Optimistic List Update: Add file object in "Uploading" status via unshift() immediately to local documents state array
  if (!_driveFilesBySuite[suiteId]) _driveFilesBySuite[suiteId] = [];
  var nowISO = new Date().toISOString();
  var placeholderObj = {
    id: doc.id,
    fileName: doc.name || (doc.file ? doc.file.name : 'Uploading...'),
    mimeType: doc.file ? doc.file.type : doc.type,
    fileSize: doc.file ? doc.file.size : doc.size,
    uploadedAt: nowISO,
    createdAt: nowISO,
    timestamp: Date.now(),
    uploadedByName: (userProfile ? userProfile.name : 'You') || 'You',
    status: 'uploading',
    progress: doc.progress || 0,
    suiteId: suiteId,
    _isPlaceholder: true
  };

  var existingIdx = _driveFilesBySuite[suiteId].findIndex(function (f) { return f.id === doc.id; });
  if (existingIdx !== -1) {
    _driveFilesBySuite[suiteId][existingIdx] = placeholderObj;
  } else {
    _driveFilesBySuite[suiteId].unshift(placeholderObj);
  }
  renderDriveFiles(_driveFilesBySuite[suiteId], suiteId);

  // Build FormData with suiteId payload
  var formData = new FormData();
  formData.append('file',    doc.file);
  formData.append('suiteId', suiteId);
  if (uid) formData.append('uid', uid);

  // Use XHR for upload progress
  var xhr = new XMLHttpRequest();
  doc._xhr = xhr;

  // Pause and resume methods bound to doc object
  doc.pause = function () {
    if (doc.status === 'uploading' && doc._xhr) {
      doc._xhr.abort();
      doc.status = 'paused';
      _updatePendingCard(id, 'paused', doc.progress);
    }
  };

  doc.resume = function () {
    if (doc.status === 'paused') {
      attemptDriveUpload(id);
    }
  };

  xhr.upload.onprogress = function (e) {
    if (e.lengthComputable) {
      var pct = Math.round((e.loaded / e.total) * 100);
      doc.progress = pct;
      _updatePendingCard(id, 'uploading', pct);
    }
  };

  xhr.onabort = function () {
    console.log('[DocumentService] Upload paused/aborted for doc:', id);
  };

  xhr.onload = function () {
    if (doc.status === 'paused') return;
    var result;
    try { result = JSON.parse(xhr.responseText); } catch (e) { result = {}; }

    if ((xhr.status === 200 || xhr.status === 201) && result.success) {
      doc.status   = 'uploaded';
      doc.progress = 100;
      _updatePendingCard(id, 'uploaded', 100);
      showToast('main-toast', '✅ "' + doc.name + '" uploaded to Google Drive!', 'dark');

      // State Reconciliation: Replace "Uploading" placeholder object with real object returned from server
      var serverFile = result.file;
      var currentSuite = suiteId || _currentSuiteId();
      if (serverFile && currentSuite) {
        if (!_driveFilesBySuite[currentSuite]) _driveFilesBySuite[currentSuite] = [];
        var idx = _driveFilesBySuite[currentSuite].findIndex(function (f) {
          return f.id === doc.id || f.id === serverFile.id || (f.driveFileId && f.driveFileId === serverFile.driveFileId);
        });
        if (idx !== -1) {
          _driveFilesBySuite[currentSuite][idx] = serverFile;
        } else {
          _driveFilesBySuite[currentSuite].unshift(serverFile);
        }
        if (!_driveRegistryBySuite[currentSuite]) _driveRegistryBySuite[currentSuite] = {};
        _driveRegistryBySuite[currentSuite][serverFile.id] = serverFile;
        renderDriveFiles(_driveFilesBySuite[currentSuite], currentSuite);
      } else if (result.file) {
        addDriveFileToList(result.file);
      }

      if (currentSuite) {
        loadSuiteDriveFiles(currentSuite);
      }
      // Remove from queue after a short delay
      setTimeout(function () {
        window.DocumentService.queue.remove(id);
      }, 2000);
    } else if (result.error === 'DRIVE_NOT_CONNECTED') {
      doc.status = 'error';
      _updatePendingCard(id, 'error', 0, 'Drive not connected');
      _driveConnected = false;
      _updateDriveStatusBadge();
      _showDriveConnectPrompt(doc.name);
    } else {
      doc.status = 'error';
      var errMsg = (result && result.error) ? result.error : 'Upload failed';
      _updatePendingCard(id, 'error', 0, errMsg);
      _logUploadError(doc.name, errMsg);
      showToast('main-toast', '⚠️ Upload failed: ' + errMsg, 'dark');
    }
  };

  xhr.onerror = function () {
    if (doc.status === 'paused') return;
    doc.status = 'error';
    _updatePendingCard(doc.id, 'error', 0, 'Network error');
    _logUploadError(doc.name, 'Network error');
    showToast('main-toast', '⚠️ Upload failed: Network error. Will retry once…', 'dark');
    // Auto-retry once after 3 seconds — only if file binary still present
    if (!doc._retried && doc.file) {
      doc._retried = true;
      setTimeout(function () { attemptDriveUpload(doc.id); }, 3000);
    }
  };

  xhr.ontimeout = function () {
    if (doc.status === 'paused') return;
    doc.status = 'error';
    _updatePendingCard(doc.id, 'error', 0, 'Timed out');
    _logUploadError(doc.name, 'Upload timed out');
    showToast('main-toast', '⚠️ Upload timed out. Please try again.', 'dark');
  };

  var apiBase = (typeof CONFIG !== 'undefined' && CONFIG.API_BASE) ? CONFIG.API_BASE : '';
  if (window.CONFIG && window.CONFIG.IS_PRODUCTION && !apiBase) {
    doc.status = 'error';
    _updatePendingCard(doc.id, 'error', 0, 'Unconfigured API');
    _logUploadError(doc.name, 'Production backend URL is not configured');
    showToast('main-toast', '⚠️ Production backend URL is not configured.', 'dark');
    return;
  }
  xhr.open('POST', apiBase + '/api/drive/upload');
  if (window.CONFIG && window.CONFIG.IS_CROSS_ORIGIN) {
    xhr.withCredentials = true;
  }
  if (uid) xhr.setRequestHeader('X-FS-UID', uid);
  if (suiteId) xhr.setRequestHeader('X-Suite-ID', suiteId);
  if (authToken) {
    xhr.setRequestHeader('Authorization', 'Bearer ' + authToken);
  }
  xhr.timeout = 5 * 60 * 1000; // 5 min timeout for large files
  xhr.send(formData);
}

/* ── Pause / Resume upload helpers ─────────────────────────────── */
function pauseUpload(id) {
  var doc = window.DocumentService && window.DocumentService.queue.get(id);
  if (doc) {
    if (typeof doc.pause === 'function') {
      doc.pause();
    } else if (doc._xhr) {
      doc._xhr.abort();
      doc.status = 'paused';
      _updatePendingCard(id, 'paused', doc.progress || 0);
    }
  }
}

function resumeUpload(id) {
  var doc = window.DocumentService && window.DocumentService.queue.get(id);
  if (doc) {
    if (typeof doc.resume === 'function') {
      doc.resume();
    } else {
      attemptDriveUpload(id);
    }
  }
}
window.pauseUpload = pauseUpload;
window.resumeUpload = resumeUpload;

/* ── Update a pending card's visual state ───────────────────────── */
function _updatePendingCard(id, status, progress, errorMsg) {
  var card = document.getElementById('doc-card-' + id);
  if (!card) return;

  var badgeEl    = card.querySelector('.doc-pending-badge');
  var progressEl = card.querySelector('.doc-progress-bar');
  var fillEl     = card.querySelector('.doc-progress-fill');
  var uploadBtn  = card.querySelector('.doc-action-upload');
  var actionBtns = card.querySelectorAll('.doc-action-btn');

  var normStatus = (status || '').toLowerCase();

  if (normStatus === 'uploading') {
    if (badgeEl)    badgeEl.innerHTML  = '⬆️ Uploading… ' + (progress || 0) + '%';
    if (progressEl) progressEl.style.display = 'block';
    if (fillEl)     fillEl.style.width = (progress || 0) + '%';
    if (uploadBtn) {
      uploadBtn.disabled  = false;
      uploadBtn.style.display = 'inline-block';
      uploadBtn.innerHTML = '⏸️';
      uploadBtn.title     = 'Pause upload';
      uploadBtn.onclick   = function () { pauseUpload(id); };
    }

  } else if (normStatus === 'paused') {
    if (badgeEl)    badgeEl.innerHTML  = '⏸️ Paused (' + (progress || 0) + '%)';
    if (progressEl) progressEl.style.display = 'block';
    if (fillEl)     fillEl.style.width = (progress || 0) + '%';
    if (uploadBtn) {
      uploadBtn.disabled  = false;
      uploadBtn.style.display = 'inline-block';
      uploadBtn.innerHTML = '▶️';
      uploadBtn.title     = 'Resume upload';
      uploadBtn.onclick   = function () { resumeUpload(id); };
    }

  } else if (normStatus === 'uploaded') {
    if (badgeEl)    { badgeEl.innerHTML = '✅ Uploaded to Drive'; badgeEl.style.background = '#d4edda'; badgeEl.style.color = '#155724'; }
    if (progressEl) progressEl.style.display = 'none';
    if (fillEl)     fillEl.style.width = '100%';
    if (uploadBtn)  uploadBtn.style.display = 'none';
    actionBtns.forEach(function (b) { b.disabled = false; });

  } else if (normStatus === 'error') {
    if (badgeEl)    { badgeEl.innerHTML = '❌ ' + (errorMsg || 'Upload failed'); badgeEl.style.background = '#f8d7da'; badgeEl.style.color = '#721c24'; }
    if (progressEl) progressEl.style.display = 'none';
    if (uploadBtn) {
      uploadBtn.disabled  = false;
      uploadBtn.style.display = 'inline-block';
      uploadBtn.innerHTML = '🔄';
      uploadBtn.title     = 'Retry upload';
      uploadBtn.onclick   = function () { attemptDriveUpload(id); };
    }
  }
}

/* ══ renderPendingDocuments – renders the upload queue ══════════ */
function renderPendingDocuments() {
  var list    = document.getElementById('pending-docs-list');
  var emptyEl = document.getElementById('pending-docs-empty');
  if (!list) return;

  var docs = window.DocumentService.queue.getAll();

  // Remove existing pending cards only (not Drive file cards)
  var pendingCards = list.querySelectorAll('.doc-pending-card:not(.drive-file-card)');
  pendingCards.forEach(function (c) { c.remove(); });

  if (!docs.length) {
    // Only show empty state if there are also no Drive files
    var driveCards = list.querySelectorAll('.drive-file-card');
    if (emptyEl) emptyEl.style.display = driveCards.length ? 'none' : 'block';
    return;
  }

  if (emptyEl) emptyEl.style.display = 'none';

  docs.forEach(function (doc) {
    if (typeof DocumentRenderer !== 'undefined' && DocumentRenderer.renderPendingUploadCard) {
      list.appendChild(DocumentRenderer.renderPendingUploadCard(doc));
    }
  });
}

function previewPendingDocument(id) {
  var doc = window.DocumentService.queue.get(id);
  if (doc) window.DocumentService.previewDocument(doc);
  else showToast('main-toast', '⚠️ Document not found.', 'dark');
}

function removePendingDocument(id) {
  var card = document.getElementById('doc-card-' + id);
  if (card) {
    card.style.transition = 'opacity 0.25s, transform 0.25s';
    card.style.opacity    = '0';
    card.style.transform  = 'translateX(-12px)';
    setTimeout(function () { window.DocumentService.queue.remove(id); }, 250);
  } else {
    window.DocumentService.queue.remove(id);
  }
}

/**
 * reSelectFile – called when user clicks 📂 on a needsReselect card.
 *
 * WHY: File binaries cannot survive a page refresh (browsers block it for
 * security). When the queue is restored from localStorage, items are marked
 * needsReselect=true. Clicking 📂 opens the file picker so the user can
 * re-supply the binary, after which the upload proceeds normally.
 *
 * @param {string} id – DocumentMetadata id of the queued item.
 */
async function reSelectFile(id) {
  var doc = window.DocumentService && window.DocumentService.queue.get(id);
  if (!doc) return;

  // Open native file picker
  var newFile = await window.DocumentService.selectFile();
  if (!newFile) return; // user cancelled — leave card as-is

  // Replace the stale item with the new file
  doc.file          = newFile;
  doc.name          = newFile.name;
  doc.type          = newFile.type;
  doc.size          = newFile.size;
  doc.needsReselect = false;
  doc.status        = 'pending';
  doc.progress      = 0;
  delete doc._retried;

  // Re-render card to reflect new state
  renderPendingDocuments();

  // Auto-upload immediately if Drive is connected and a suite is active
  if (_driveConnected && _currentSuiteId()) {
    showToast('main-toast', '☁️ Uploading "' + newFile.name + '" to Google Drive…', 'dark');
    setTimeout(function () { attemptDriveUpload(id); }, 100);
  } else if (!_driveConnected) {
    _showDriveConnectPrompt(newFile.name);
  }
}

/* ══ Drive Files List – per-suite isolated storage ════════════════════
   ARCHITECTURE:
   • Every cached file list is keyed by suiteId.
   • The canonical suite ID is ALWAYS read from AppState.currentSuite.id.
   • _activeSuiteId was removed — it was a shadow variable that could diverge.
   • _firestoreFileUnsubscribe is the Firestore onSnapshot cleanup fn.
     It subscribes AFTER the REST fetch completes (skips initial snapshot)
     so it only handles NEW changes — no duplicate render on subscribe.
   ════════════════════════════════════════════════════════════ */

// Per-suite caches — keyed by suiteId
var _driveFilesBySuite    = {};  // suiteId → [file, ...]
var _driveRegistryBySuite = {};  // suiteId → { id: file, ... }

// Firestore realtime fallback listener (supplement to SSE)
var _firestoreFileUnsubscribe = null;

/** Returns the suiteId that should currently be displayed (from AppState or session context). */
function _currentSuiteId() {
  if (window.AppState && window.AppState.currentSuite && window.AppState.currentSuite.id) {
    return window.AppState.currentSuite.id;
  }
  try {
    if (typeof localStorage !== 'undefined') {
      var raw = localStorage.getItem('fs_suite');
      if (raw) {
        var s = JSON.parse(raw);
        if (s && s.id) return s.id;
      }
    }
  } catch (e) {}
  return null;
}

// Convenience getters using the canonical suite ID
function _activeCache()    { var id = _currentSuiteId(); return id ? (_driveFilesBySuite[id]    || []) : []; }
function _activeRegistry() { var id = _currentSuiteId(); return id ? (_driveRegistryBySuite[id] || {}) : {}; }

/**
 * Subscribe to Firestore realtime updates for a suite's files collection.
 *
 * WHY: SSE (EventSource) auto-reconnects, but there is a gap during network
 * interruptions where new uploads from other members won't appear in real-time.
 * Firestore onSnapshot reconnects seamlessly and fills that gap.
 *
 * ISOLATION: Validates suiteId on every snapshot callback. Unsubscribes
 * automatically if the user switches suites mid-stream.
 *
 * DEDUPLICATION: skips the initial snapshot (REST API already loaded the files).
 * Only processes change events after the first snapshot fires.
 *
 * @param {string} suiteId – the suite to subscribe to.
 */
function _subscribeFirestoreFiles(suiteId) {
  _unsubscribeFirestoreFiles(); // always clean up any previous listener
  if (!suiteId || typeof window.fsDb === 'undefined') return;

  var isInitial = true; // skip first snapshot — REST API already populated the list
  try {
    var filesRef = window.fsDb
      .collection('suites').doc(suiteId)
      .collection('files')
      .orderBy('uploadedAt', 'desc')
      .limit(100);

    _firestoreFileUnsubscribe = filesRef.onSnapshot(function (snapshot) {
      // Suite isolation guard
      if (_currentSuiteId() !== suiteId) {
        _unsubscribeFirestoreFiles();
        return;
      }
      if (isInitial) {
        isInitial = false;
        return; // REST API already rendered these — skip initial snapshot
      }
      snapshot.docChanges().forEach(function (change) {
        var file = Object.assign({ id: change.doc.id }, change.doc.data());
        if (change.type === 'added') {
          addDriveFileToList(file); // handles deduplication internally
        } else if (change.type === 'removed') {
          removeDriveFileFromList(file.id);
        }
        // 'modified' ignored — no in-place edit flow currently
      });
    }, function (err) {
      console.warn('[DocumentService] Firestore file listener error:', err.message);
    });
  } catch (e) {
    console.warn('[DocumentService] Could not subscribe to Firestore files:', e.message);
  }
}

function _unsubscribeFirestoreFiles() {
  if (_firestoreFileUnsubscribe) {
    try { _firestoreFileUnsubscribe(); } catch (_) {}
    _firestoreFileUnsubscribe = null;
  }
}

/** Returns counts of active listeners for the debug helper and debug endpoint. */
function getListenerCount() {
  var sseInfo = typeof getSseListenerInfo === 'function' ? getSseListenerInfo() : { connected: false, reconnectCount: 0 };
  var fsLive  = _firestoreFileUnsubscribe ? 1 : 0;
  return {
    sse:           sseInfo.connected ? 1 : 0,
    sseReconnects: sseInfo.reconnectCount || 0,
    firestore:     fsLive,
    total:         (sseInfo.connected ? 1 : 0) + fsLive,
  };
}

/**
 * Call this when switching suites.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.preserveQueue=false]
 *   true  → keep pending queue (workspace navigation — same suite)
 *   false → wipe queue fully (leaveSuite — intentional exit)
 */
function clearSuiteDocState(opts) {
  var preserveQueue = opts && opts.preserveQueue === true;

  // Unsubscribe Firestore listener before clearing state
  _unsubscribeFirestoreFiles();

  // Clear rendered Drive file cards immediately (no stale data flicker)
  renderDriveFiles([], _currentSuiteId());

  // Prune stale suite caches (keep only the current suite's data)
  var currentId = _currentSuiteId();
  if (currentId) {
    var keys = Object.keys(_driveFilesBySuite);
    keys.forEach(function (k) {
      if (k !== currentId) {
        delete _driveFilesBySuite[k];
        delete _driveRegistryBySuite[k];
      }
    });
  }

  // Clear upload queue only when fully leaving the suite
  if (!preserveQueue && window.DocumentService && window.DocumentService.queue) {
    window.DocumentService.queue.clear();
    _clearQueueStorage();
  }

  // Reset viewer to placeholder
  _resetDocViewer();
}

/** Wipe the document viewer back to its default placeholder state */
function _resetDocViewer() {
  ['drive-embed-viewer','drive-img-viewer','drive-video-viewer','drive-audio-viewer','drive-file-actions']
    .forEach(function (id) { var el = document.getElementById(id); if (el) el.remove(); });
  var placeholder = document.getElementById('doc-viewer-placeholder');
  if (placeholder) { placeholder.style.display = 'block'; placeholder.innerHTML = ''; }
  var iconEl = document.getElementById('doc-type-icon');
  var nameEl = document.getElementById('doc-file-name');
  var metaEl = document.getElementById('doc-file-meta');
  if (iconEl) iconEl.textContent = '📄';
  if (nameEl) nameEl.textContent = 'Select a document';
  if (metaEl) metaEl.textContent = '';
}

/**
 * Fetch Drive files for a specific suite and render them.
 *
 * Sequence:
 *  1. Restore any persisted queue items (needsReselect stubs) from localStorage.
 *  2. Clear stale rendered cards immediately (no flicker).
 *  3. Fetch files from REST API.
 *  4. Race-condition guard: discard if suite changed mid-fetch.
 *  5. Render files, build per-suite registry.
 *  6. Subscribe Firestore onSnapshot AFTER REST render — skips initial snapshot
 *     to avoid duplicate rendering; only handles subsequent additions/removals.
 */
async function loadSuiteDriveFiles(suiteId) {
  if (!suiteId) return;

  // Initialize caches for this suite if needed
  if (!_driveFilesBySuite[suiteId])    _driveFilesBySuite[suiteId]    = [];
  if (!_driveRegistryBySuite[suiteId]) _driveRegistryBySuite[suiteId] = {};
  renderDriveFiles(_driveFilesBySuite[suiteId], suiteId); // render existing cached files instantly to prevent list disappearing

  // Restore persisted queue items for this suite (metadata only, needsReselect=true)
  var restored = _loadQueueFromStorage(suiteId);
  if (restored.length && window.DocumentService) {
    restored.forEach(function (meta) {
      if (!window.DocumentService.queue.get(meta.id)) {
        window.DocumentService.queue.add(meta);
      }
    });
  }

  try {
    var data = await API.getDriveFiles(suiteId);

    // Race-condition guard: ignore if the user switched suites during the fetch
    if (_currentSuiteId() !== suiteId) {
      console.log('[DocumentService] Suite changed during fetch, discarding stale response for', suiteId);
      return;
    }

    if (data && data.success && Array.isArray(data.files)) {
      _driveFilesBySuite[suiteId] = data.files;
      var reg = {};
      data.files.forEach(function (f) { reg[f.id] = f; });
      _driveRegistryBySuite[suiteId] = reg;
      renderDriveFiles(data.files, suiteId); // explicit suiteId — no stale closure
    }
  } catch (e) {
    console.warn('[DocumentService] loadSuiteDriveFiles error:', e.message);
  }

  // Subscribe Firestore realtime listener AFTER REST fetch + render.
  // Skips initial snapshot to avoid re-rendering files we just fetched.
  _subscribeFirestoreFiles(suiteId);

  // Fluent file grid hook — update categorized view if file-grid.js is loaded
  if (typeof renderFileGrid === 'function') {
    renderFileGrid(_driveFilesBySuite[suiteId] || []);
  }
}

/* ══ Memoized function to group documents by fileType ══════════════ */
var _memoizedGroupedCache = { ref: null, result: null };

function getGroupedDocuments(documents) {
  var docs = Array.isArray(documents) ? documents : [];
  if (_memoizedGroupedCache.ref === docs && _memoizedGroupedCache.result) {
    return _memoizedGroupedCache.result;
  }

  var grouped = {};
  docs.forEach(function (doc) {
    var fileType = doc.fileType;
    if (!fileType) {
      var mime = (doc.mimeType || doc.type || '').toLowerCase();
      var name = (doc.fileName || doc.name || '').toLowerCase();
      if (mime.includes('pdf') || name.endsWith('.pdf')) fileType = 'pdf';
      else if (mime.includes('image') || name.match(/\.(png|jpg|jpeg|gif|webp|svg|bmp)$/)) fileType = 'image';
      else if (mime.includes('video') || name.match(/\.(mp4|webm|mov|avi|mkv)$/)) fileType = 'video';
      else if (mime.includes('audio') || name.match(/\.(mp3|wav|ogg|m4a|flac)$/)) fileType = 'audio';
      else if (mime.includes('word') || mime.includes('document') || name.match(/\.(doc|docx|txt|rtf|md)$/)) fileType = 'document';
      else if (mime.includes('spreadsheet') || mime.includes('excel') || name.match(/\.(xls|xlsx|csv)$/)) fileType = 'spreadsheet';
      else if (mime.includes('presentation') || mime.includes('powerpoint') || name.match(/\.(ppt|pptx)$/)) fileType = 'presentation';
      else if (mime.includes('zip') || mime.includes('compressed') || name.match(/\.(zip|tar|gz|rar|7z)$/)) fileType = 'archive';
      else fileType = 'other';
    }
    if (!grouped[fileType]) grouped[fileType] = [];
    grouped[fileType].push(doc);
  });

  _memoizedGroupedCache.ref = docs;
  _memoizedGroupedCache.result = grouped;
  return grouped;
}
if (typeof window !== 'undefined') {
  window.getGroupedDocuments = getGroupedDocuments;
}

/* ══ Helper to sort documents by createdAt / timestamp descending ══ */
function _getDocTimestamp(doc) {
  if (!doc) return 0;
  var ts = doc.createdAt || doc.timestamp || doc.uploadedAt || doc.selectedAt;
  if (!ts) return 0;
  if (typeof ts === 'number') return ts;
  if (ts.toDate && typeof ts.toDate === 'function') return ts.toDate().getTime();
  var parsed = new Date(ts).getTime();
  return isNaN(parsed) ? 0 : parsed;
}

function _sortDocsDescending(files) {
  if (!Array.isArray(files)) return [];
  return files.slice().sort(function (a, b) {
    return _getDocTimestamp(b) - _getDocTimestamp(a);
  });
}

/**
 * Render Drive files into #pending-docs-list alongside pending cards.
 *
 * STALE CLOSURE FIX: suiteId is now an explicit parameter.
 * Previously it was read from AppState inside this function. If the suite
 * changed between a fetch starting and this render completing, the delete
 * button onclick could reference the wrong suiteId.
 *
 * @param {Array}  files   – array of Firestore file metadata objects.
 * @param {string} suiteId – the suite these files belong to (explicit, not from AppState).
 */
function renderDriveFiles(files, suiteId) {
  // Fallback for call sites that don't pass suiteId (backward compat)
  var resolvedSuiteId = suiteId || _currentSuiteId() || '';

  var list    = document.getElementById('pending-docs-list');
  var emptyEl = document.getElementById('pending-docs-empty');
  if (!list) return;

  // Remove existing drive file cards AND category headers
  var existing = list.querySelectorAll('.drive-file-card, .drive-category-header');
  existing.forEach(function (c) { c.remove(); });

  if (!files || !files.length) {
    var pendingCards = list.querySelectorAll('.doc-pending-card:not(.drive-file-card)');
    if (emptyEl) emptyEl.style.display = pendingCards.length ? 'none' : 'block';
    return;
  }

  if (emptyEl) emptyEl.style.display = 'none';

  var uid      = (window.AppState && window.AppState.currentUser)  ? window.AppState.currentUser.uid : '';
  var ownerUid = (window.AppState && window.AppState.currentSuite) ? window.AppState.currentSuite.ownerUid : '';

  // Sort documents array by createdAt/timestamp in descending order so recent files stay at top
  var sortedFiles = _sortDocsDescending(files);

  // Render documents grouped by fileType using memoized getGroupedDocuments
  var grouped = getGroupedDocuments(sortedFiles);
  
  Object.keys(grouped).forEach(function (fileType) {
    var groupFiles = grouped[fileType];
    if (!groupFiles || !groupFiles.length) return;

    if (typeof DocumentRenderer !== 'undefined' && DocumentRenderer.renderCategoryHeader) {
      list.appendChild(DocumentRenderer.renderCategoryHeader(fileType));
    }

    groupFiles.forEach(function (file) {
      if (resolvedSuiteId) {
        if (!_driveRegistryBySuite[resolvedSuiteId]) _driveRegistryBySuite[resolvedSuiteId] = {};
        _driveRegistryBySuite[resolvedSuiteId][file.id] = file;
      }

      var canDelete = (file.ownerUid === uid || uid === ownerUid);

      if (typeof DocumentRenderer !== 'undefined' && DocumentRenderer.renderDocumentCard) {
        list.appendChild(DocumentRenderer.renderDocumentCard(file, canDelete, resolvedSuiteId));
      }
    });
  });
}

/* Add a single new Drive file to the list (from SSE event)
   ISOLATION: only adds the file if its suiteId matches the ACTIVE suite.
   Prevents files from Suite A appearing in Suite B's view. */
function addDriveFileToList(file) {
  if (!file || !file.id) return;

  // ── Suite isolation guard ──────────────────────────────────────────
  var activeSuite = window.AppState && window.AppState.currentSuite;
  if (!activeSuite || !activeSuite.id) return; // no active suite
  if (file.suiteId && file.suiteId !== activeSuite.id) {
    // File belongs to a different suite — silently ignore
    console.log('[DocumentService] SSE file_added ignored: belongs to suite', file.suiteId, 'not active', activeSuite.id);
    return;
  }
  // ──────────────────────────────────────────────────────────────────

  // Avoid duplicates
  var existing = document.getElementById('drive-file-' + file.id);
  if (existing) return;

  // Add to the per-suite cache
  var suiteId = activeSuite.id;
  if (!_driveFilesBySuite[suiteId])    _driveFilesBySuite[suiteId]    = [];
  if (!_driveRegistryBySuite[suiteId]) _driveRegistryBySuite[suiteId] = {};
  _driveFilesBySuite[suiteId].unshift(file);
  _driveRegistryBySuite[suiteId][file.id] = file;

  var list = document.getElementById('pending-docs-list');
  if (list && typeof DocumentRenderer !== 'undefined' && DocumentRenderer.renderDocumentCard) {
    // Determine category without using cached array to avoid mutating global grouped ref incorrectly
    var grouped = getGroupedDocuments([file]);
    var fileType = Object.keys(grouped)[0] || 'other';
    var uid = (window.AppState && window.AppState.currentUser) ? window.AppState.currentUser.uid : '';
    var ownerUid = activeSuite.ownerUid || '';
    var canDelete = (file.ownerUid === uid || uid === ownerUid);
    
    var card = DocumentRenderer.renderDocumentCard(file, canDelete, suiteId);

    // Find the category header
    var header = list.querySelector('.drive-category-header[data-category="' + fileType + '"]');
    if (!header) {
      header = DocumentRenderer.renderCategoryHeader(fileType);
      var firstFile = list.querySelector('.drive-category-header, .drive-file-card');
      if (firstFile) {
        list.insertBefore(header, firstFile);
      } else {
        list.appendChild(header);
      }
    }
    
    // Insert card immediately after the header (since it's newest, it goes at the top of its category)
    if (header.nextSibling) {
      list.insertBefore(card, header.nextSibling);
    } else {
      list.appendChild(card);
    }
    
    var emptyEl = document.getElementById('pending-docs-empty');
    if (emptyEl) emptyEl.style.display = 'none';
  } else {
    // Fallback if DocumentRenderer not available
    renderDriveFiles(_driveFilesBySuite[suiteId], suiteId);
  }

  // Flash new-file highlight
  setTimeout(function () {
    var card = document.getElementById('drive-file-' + file.id);
    if (card) {
      card.style.animation = 'slideInUp 0.4s ease';
      card.style.border    = '1.5px solid var(--c-green)';
      setTimeout(function () { card.style.border = ''; }, 3000);
    }
  }, 100);
}

/* Remove a Drive file card from the list (from SSE event)
   ISOLATION: only removes from the active suite's cache. */
function removeDriveFileFromList(fileId) {
  // ── Suite isolation guard ──────────────────────────────────────────
  var activeSuite = window.AppState && window.AppState.currentSuite;
  if (!activeSuite || !activeSuite.id) return;
  var suiteId = activeSuite.id;
  // ──────────────────────────────────────────────────────────────────

  if (_driveFilesBySuite[suiteId]) {
    _driveFilesBySuite[suiteId] = _driveFilesBySuite[suiteId].filter(function (f) { return f.id !== fileId; });
  }
  if (_driveRegistryBySuite[suiteId]) {
    delete _driveRegistryBySuite[suiteId][fileId];
  }

  var card = document.getElementById('drive-file-' + fileId);
  if (card) {
    var fileType = card.dataset.fileType;
    card.style.transition = 'opacity 0.3s, transform 0.3s';
    card.style.opacity    = '0';
    card.style.transform  = 'translateX(-20px)';
    setTimeout(function () {
      card.remove();
      var list = document.getElementById('pending-docs-list');
      
      // Cleanup header if empty
      if (list && fileType) {
        var header = list.querySelector('.drive-category-header[data-category="' + fileType + '"]');
        if (header) {
          var sibling = header.nextElementSibling;
          var hasItems = false;
          while (sibling && !sibling.classList.contains('drive-category-header')) {
            if (sibling.classList.contains('drive-file-card')) {
              hasItems = true; break;
            }
            sibling = sibling.nextElementSibling;
          }
          if (!hasItems) header.remove();
        }
      }

      if (list && !list.querySelector('.drive-file-card, .doc-pending-card')) {
        var emptyEl = document.getElementById('pending-docs-empty');
        if (emptyEl) emptyEl.style.display = 'block';
      }
    }, 320);
  }
}

/* ══ openDriveFileById – safe entry-point called by onclick ════════ */
// Looks up the file from the active suite's registry.
function openDriveFileById(fileId) {
  var registry = _activeRegistry();
  var file = registry[fileId];
  if (!file) {
    showToast('main-toast', '⚠️ File not found. Try refreshing.', 'dark');
    return;
  }
  openDriveFileViewer(file);
}

/* ══ openDriveFileViewer – embedded viewer in existing doc-viewer ═ */
function openDriveFileViewer(file) {
  // Accept both plain objects and JSON strings
  if (typeof file === 'string') {
    try { file = JSON.parse(file); } catch (e) {
      showToast('main-toast', '⚠️ Could not open file.', 'dark');
      return;
    }
  }
  if (!file) { showToast('main-toast', '⚠️ File data missing.', 'dark'); return; }

  // Use the new DocumentRenderer helper for the Document Overlay
  if (typeof DocumentRenderer !== 'undefined' && DocumentRenderer.renderDocumentOverlay) {
    DocumentRenderer.renderDocumentOverlay(file);
  } else {
    showToast('main-toast', '⚠️ Document Renderer not loaded.', 'dark');
  }
}

/* ══ deleteDriveFile ════════════════════════════════════════════ */
async function deleteDriveFile(fileId, suiteId) {
  if (!confirm('Delete this file? It will be removed from Drive and the suite.')) return;

  var card = document.getElementById('drive-file-' + fileId);
  if (card) { card.style.opacity = '0.5'; }

  try {
    var data = await API.deleteDriveFile(fileId, suiteId);
    if (data && data.success) {
      showToast('main-toast', '✅ File deleted.', 'dark');
      removeDriveFileFromList(fileId);
    } else {
      if (card) card.style.opacity = '1';
      showToast('main-toast', '⚠️ ' + (data && data.error ? data.error : 'Could not delete file.'), 'dark');
    }
  } catch (e) {
    if (card) card.style.opacity = '1';
    showToast('main-toast', '⚠️ Delete failed: ' + e.message, 'dark');
  }
}

/* ══ Helper: file icon from MIME ════════════════════════════════ */
function _getDriveFileIcon(mimeType, fileName) {
  var m = (mimeType || '').toLowerCase();
  var n = (fileName  || '').toLowerCase();
  if (m.includes('pdf') || n.endsWith('.pdf'))                                 return '📄';
  if (m.includes('word') || n.match(/\.(doc|docx)$/))                          return '📝';
  if (m.includes('presentation') || n.match(/\.(ppt|pptx)$/))                 return '📊';
  if (m.includes('spreadsheet') || m.includes('csv') || n.match(/\.(xls|xlsx|csv)$/)) return '📈';
  if (m.includes('image') || n.match(/\.(png|jpg|jpeg|gif|webp|svg|bmp)$/))   return '🖼️';
  if (m.includes('video') || n.match(/\.(mp4|mov|avi|mkv)$/))                 return '🎬';
  if (m.includes('audio') || n.match(/\.(mp3|wav|ogg|flac)$/))                return '🎵';
  if (m.includes('zip') || n.match(/\.(zip|rar|7z|tar|gz)$/))                 return '📦';
  if (m.includes('text') || n.match(/\.(txt|md|log|py|js|ts|java|c|cpp|html|css|json|xml|sql)$/)) return '📃';
  return '📎';
}

function _formatFileSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024)        return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function _formatDate(isoStr) {
  if (!isoStr) return '';
  try {
    return new Date(isoStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch (e) { return isoStr.slice(0, 10); }
}

/* ══ CoLearnDebug — browser console diagnostic helper ══════════════
 *
 * Usage (browser DevTools console):
 *   CoLearnDebug.getDocumentStatus()   → full doc subsystem snapshot
 *   CoLearnDebug.getRecentErrors()     → last 5 upload errors
 *   CoLearnDebug.getListeners()        → SSE + Firestore listener counts
 *
 * This is a DEVELOPER tool. It is safe to ship in production because
 * it only reads existing state — it does not modify anything.
 * ════════════════════════════════════════════════════════════════ */
window.CoLearnDebug = window.CoLearnDebug || {};

window.CoLearnDebug.getDocumentStatus = function () {
  var suiteId = _currentSuiteId();
  var q = window.DocumentService ? window.DocumentService.queue.getAll() : [];
  return {
    activeSuiteId:  suiteId,
    driveConnected: _driveConnected,
    driveEmail:     typeof _driveEmail !== 'undefined' ? _driveEmail : 'N/A',
    queue: {
      size:  q.length,
      items: q.map(function (d) {
        return {
          id:           d.id,
          name:         d.name,
          status:       d.status,
          needsReselect: !!d.needsReselect,
          hasFile:       !!d.file,
        };
      }),
    },
    cache: {
      suiteKeys: Object.keys(_driveFilesBySuite),
      activeSuiteFileCount: suiteId ? (_driveFilesBySuite[suiteId] || []).length : 0,
    },
    listeners:    getListenerCount(),
    recentErrors: getRecentUploadErrors(),
    appState: {
      currentSuiteId:   window.AppState && window.AppState.currentSuite ? window.AppState.currentSuite.id   : null,
      currentSuiteName: window.AppState && window.AppState.currentSuite ? window.AppState.currentSuite.name : null,
      currentUserUid:   window.AppState && window.AppState.currentUser  ? window.AppState.currentUser.uid   : null,
    },
  };
};

window.CoLearnDebug.getRecentErrors = getRecentUploadErrors;
window.CoLearnDebug.getListeners    = getListenerCount;



// Drag and Drop Upload logic
function _initDragAndDrop() {
  var dropZone = document.getElementById('docs-card-container');
  if (!dropZone) return;

  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(function(eventName) {
    dropZone.addEventListener(eventName, preventDefaults, false);
  });

  function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  ['dragenter', 'dragover'].forEach(function(eventName) {
    dropZone.addEventListener(eventName, function() {
      dropZone.classList.add('drag-over');
    }, false);
  });

  ['dragleave', 'drop'].forEach(function(eventName) {
    dropZone.addEventListener(eventName, function() {
      dropZone.classList.remove('drag-over');
    }, false);
  });

  dropZone.addEventListener('drop', async function(e) {
    var dt = e.dataTransfer;
    var files = dt.files;
    
    if (files && files.length > 0) {
      // Check Drive connection (lazy-load status)
      if (_driveConnected === null) {
        await _checkDriveStatus();
      }

      var user = (window.AppState && window.AppState.currentUser) ? window.AppState.currentUser.name : 'You';

      for (var i = 0; i < files.length; i++) {
        var file = files[i];
        
        var validation = window.DocumentService.validateFile(file);
        if (!validation.valid) {
          showToast('main-toast', '❌ ' + validation.error, 'dark');
          continue;
        }

        if (!_driveConnected) {
          // Queue file and prompt to connect Drive
          window.DocumentService.queueUpload(file, user);
          _showDriveConnectPrompt(file.name);
          break; // Stop queuing more files until connected
        }

        // Queue it + auto-start upload
        (function(currentFile) {
          var meta = window.DocumentService.queueUpload(currentFile, user);
          showToast('main-toast', '☁️ Uploading "' + currentFile.name + '" to Google Drive…', 'dark');
          setTimeout(function () { attemptDriveUpload(meta.id); }, 100 * (i + 1));
        })(file);
      }
    }
  }, false);
}

// Initialize on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _initDragAndDrop);
} else {
  _initDragAndDrop();
}
