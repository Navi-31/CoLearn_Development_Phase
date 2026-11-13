'use strict';
/**
 * file-grid.js – CoLearn Suite Document File System
 * ─────────────────────────────────────────────────────────────────
 * Renders a Windows Explorer-style categorized file grid in #ws-state-invite.
 * Hooks into existing document-service.js data (zero modifications to that file).
 * 
 * Categories: PDF · DOCX · PPTX · Images · Other
 * 
 * Functions exposed to window:
 *   openCategoryModal(cat)
 *   closeCategoryModal()
 *   renameDriveFile(fileId, suiteId)
 *   fileGridInit()
 */

/* ═══════════════════════════════════════════════════════════════
   CONSTANTS & STATE
   ═══════════════════════════════════════════════════════════════ */

const FL_CATS = {
  pdf:   { label: 'PDF Documents',   icon: '📄', ext: ['pdf'],                      color: '#dc2626' },
  docx:  { label: 'Word Documents',  icon: '📝', ext: ['doc', 'docx'],              color: '#2563eb' },
  pptx:  { label: 'Presentations',   icon: '📊', ext: ['ppt', 'pptx'],             color: '#ea580c' },
  image: { label: 'Images',          icon: '🖼️',  ext: ['jpg','jpeg','png','gif','webp','bmp','svg'], color: '#7c3aed' },
  other: { label: 'Other Files',     icon: '📁', ext: [],                            color: '#475569' },
};

// Local rename overrides: { firestoreFileId: 'Display Name' }
// Stored per-suite in localStorage as colearn_renames_{suiteId}
let _flRenames = {};
let _flCurrentFiles = [];
let _flCurrentSuiteId = null;
let _flCurrentModalCat = null;

/* ═══════════════════════════════════════════════════════════════
   INITIALISATION — called from initWorkspace() or after file load
   ═══════════════════════════════════════════════════════════════ */

function fileGridInit() {
  _ensureCategoryGridContainer();
  _ensureModalDOM();
  _flCurrentSuiteId = AppState.currentSuite && AppState.currentSuite.id;
  _loadLocalRenames(_flCurrentSuiteId);

  // Hook: observe #pending-docs-list mutations to auto-refresh grid
  // when document-service.js updates the list
  const pendingList = document.getElementById('pending-docs-list');
  if (pendingList && !pendingList._flObserving) {
    pendingList._flObserving = true;
    const mo = new MutationObserver(() => {
      // Re-render grid when document-service.js updates the list
      renderFileGrid(_flCurrentFiles);
    });
    mo.observe(pendingList, { childList: true, subtree: true });
  }
}

/* ═══════════════════════════════════════════════════════════════
   MAIN RENDER
   ═══════════════════════════════════════════════════════════════ */

/**
 * Called after files are loaded. Accepts the same `files` array
 * that document-service.js uses for #pending-docs-list.
 */
function renderFileGrid(files) {
  _flCurrentFiles = files || [];
  _flCurrentSuiteId = AppState.currentSuite && AppState.currentSuite.id;

  const grid = document.getElementById('ws-file-category-grid');
  if (!grid) return;

  // Show/hide home-state Drive connect banner
  const driveConnected = (typeof _driveConnected !== 'undefined' && _driveConnected === true) || (window.DocumentService && window.DocumentService.driveConnected === true);
  const homeBanner = document.getElementById('drive-connect-banner-home');
  if (homeBanner) {
    homeBanner.style.display = driveConnected ? 'none' : 'flex';
  }
  // Mirror the docs-state drive-status-badge into the home-state badge
  const docsBadge = document.getElementById('drive-status-badge');
  const homeBadge = document.getElementById('drive-status-badge-home');
  if (docsBadge && homeBadge) {
    homeBadge.innerHTML = docsBadge.innerHTML;
  }

  // Sort newest first
  const sorted = [..._flCurrentFiles].sort((a, b) => {
    return new Date(b.uploadedAt || 0) - new Date(a.uploadedAt || 0);
  });

  const categorized = _categorizeFiles(sorted);

  // Build 2-column category card grid
  let html = '';
  const catKeys = Object.keys(FL_CATS);

  for (const cat of catKeys) {
    const catFiles = categorized[cat] || [];
    if (catFiles.length === 0 && cat === 'other') continue; // hide empty "Other"
    html += _buildCategoryCard(cat, catFiles);
  }

  if (!html) {
    html = `<div class="fl-cat-empty" style="grid-column:1/-1;">
      <div style="font-size:2rem;margin-bottom:0.5rem;">📂</div>
      <div style="font-weight:600;color:var(--fl-text-md);">No documents yet</div>
      <div style="font-size:0.78rem;margin-top:0.25rem;">Upload your first document to get started</div>
    </div>`;
  }

  grid.innerHTML = html;
}

/* ═══════════════════════════════════════════════════════════════
   CATEGORIZATION
   ═══════════════════════════════════════════════════════════════ */

function _categorizeFiles(files) {
  const result = { pdf: [], docx: [], pptx: [], image: [], other: [] };

  for (const file of files) {
    const ext = _getExt(file.fileName || '');
    let placed = false;
    for (const [cat, def] of Object.entries(FL_CATS)) {
      if (def.ext.includes(ext)) {
        result[cat].push(file);
        placed = true;
        break;
      }
    }
    if (!placed) result.other.push(file);
  }

  return result;
}

function _getExt(fileName) {
  const parts = fileName.toLowerCase().split('.');
  return parts.length > 1 ? parts[parts.length - 1] : '';
}

/* ═══════════════════════════════════════════════════════════════
   CATEGORY CARD (collapsed 2×2 preview)
   ═══════════════════════════════════════════════════════════════ */

function _buildCategoryCard(cat, files) {
  const def = FL_CATS[cat];
  const count = files.length;

  // Preview: up to 3 newest files + overflow slot
  const previewFiles = files.slice(0, 3);
  let previewSlots = '';

  for (let i = 0; i < 4; i++) {
    if (i < previewFiles.length) {
      const f = previewFiles[i];
      const displayName = getLocalFileName(f.id, f.fileName);
      previewSlots += `
        <div class="fl-cat-preview-slot">
          ${_renderFileIconSmall(cat)}
          <span class="fl-cat-preview-slot-name" title="${_esc(displayName)}">${_esc(_truncate(displayName, 16))}</span>
        </div>`;
    } else if (i === 3 && count > 3) {
      // Overflow slot
      previewSlots += `
        <div class="fl-cat-preview-slot" style="background:var(--fl-border);justify-content:center;font-size:0.72rem;font-weight:700;color:var(--fl-text-lo);">
          +${count - 3} more
        </div>`;
    } else {
      previewSlots += `<div class="fl-cat-preview-slot" style="background:transparent;border-color:transparent;"></div>`;
    }
  }

  return `
    <div class="fl-cat-card" onclick="openCategoryModal('${cat}')" role="button" tabindex="0"
         onkeydown="if(event.key==='Enter')openCategoryModal('${cat}')">
      <div class="fl-cat-card-header">
        <div class="fl-cat-card-title">
          <span>${def.icon}</span>
          <span>${def.label}</span>
        </div>
        <span class="fl-cat-card-count">${count} file${count !== 1 ? 's' : ''}</span>
      </div>
      <div class="fl-cat-preview-grid">${previewSlots}</div>
    </div>`;
}

/* ═══════════════════════════════════════════════════════════════
   CATEGORY MODAL (expanded file list)
   ═══════════════════════════════════════════════════════════════ */

function openCategoryModal(cat) {
  _flCurrentModalCat = cat;
  const def = FL_CATS[cat];
  const sorted = [..._flCurrentFiles].sort((a, b) =>
    new Date(b.uploadedAt || 0) - new Date(a.uploadedAt || 0)
  );
  const catFiles = _categorizeFiles(sorted)[cat] || [];

  const modal = document.getElementById('fl-cat-modal');
  const backdrop = document.getElementById('fl-cat-modal-backdrop');
  const title = document.getElementById('fl-cat-modal-title');
  const body = document.getElementById('fl-cat-modal-body');

  if (!modal || !backdrop) return;

  title.innerHTML = `<span>${def.icon}</span> ${def.label} <span style="font-size:0.8rem;font-weight:500;color:var(--fl-text-muted);">(${catFiles.length})</span>`;

  body.innerHTML = _buildModalFileList(catFiles, cat);

  backdrop.classList.add('open');
  document.body.style.overflow = 'hidden';

  // Attach right-click context menus
  _attachFileRowContextMenus(body);
}

function closeCategoryModal() {
  const backdrop = document.getElementById('fl-cat-modal-backdrop');
  if (backdrop) backdrop.classList.remove('open');
  document.body.style.overflow = '';
  _flCurrentModalCat = null;
}

function _buildModalFileList(files, cat) {
  if (files.length === 0) {
    return `<div class="fl-cat-empty">
      <div style="font-size:2rem;margin-bottom:0.5rem;">${FL_CATS[cat].icon}</div>
      <div>No ${FL_CATS[cat].label.toLowerCase()} uploaded yet</div>
    </div>`;
  }

  // Split: recent (≤6) and older
  const RECENT_LIMIT = 6;
  const recent = files.slice(0, RECENT_LIMIT);
  const older  = files.slice(RECENT_LIMIT);

  let html = '<div id="fl-file-list">';

  for (const f of recent) {
    html += _buildFileRow(f, cat);
  }

  if (older.length > 0) {
    html += `
      <button class="fl-archive-toggle" id="fl-archive-toggle" onclick="_toggleOlderFiles()">
        <span id="fl-archive-chevron">▶</span> Older files (${older.length})
      </button>
      <div id="fl-older-files" style="display:none;">
        ${older.map(f => _buildFileRow(f, cat)).join('')}
      </div>`;
  }

  html += '</div>';
  return html;
}

function _buildFileRow(f, cat) {
  const displayName = getLocalFileName(f.id, f.fileName);
  const uploadedAt  = f.uploadedAt ? new Date(f.uploadedAt).toLocaleDateString() : '';
  const uploaderName = f.uploadedByName || 'Unknown';
  const fileSize    = f.fileSize ? _formatBytes(f.fileSize) : '';
  const isHostOrAdmin = _isHostOrAdmin();

  return `
    <div class="fl-file-row" data-file-id="${_esc(f.id)}" data-drive-file-id="${_esc(f.driveFileId || '')}" 
         oncontextmenu="_showFileCtxMenu(event, '${_esc(f.id)}')">
      ${_renderFileIconFull(cat)}
      <div class="fl-file-row-info">
        <div class="fl-file-row-name" title="${_esc(f.fileName)}">${_esc(displayName)}</div>
        <div class="fl-file-row-meta">${uploaderName} · ${uploadedAt}${fileSize ? ' · ' + fileSize : ''}</div>
      </div>
      <div class="fl-file-row-actions">
        ${f.driveEmbedUrl || f.driveWebViewLink ? `
          <button class="fl-btn fl-btn-outline fl-btn-sm" title="Preview"
            onclick="_previewFile('${_esc(f.id)}')" style="font-size:0.72rem;">👁 Preview</button>` : ''}
        ${f.driveDownloadLink ? `
          <a class="fl-btn fl-btn-outline fl-btn-sm" href="${_esc(f.driveDownloadLink)}" target="_blank" 
            download title="Download" style="font-size:0.72rem;text-decoration:none;">⬇ Download</a>` : ''}
        ${isHostOrAdmin ? `
          <button class="fl-btn fl-btn-danger fl-btn-sm" title="Delete"
            onclick="_deleteFile('${_esc(f.id)}')" style="font-size:0.72rem;">🗑 Delete</button>` : ''}
      </div>
    </div>`;
}

function _toggleOlderFiles() {
  const older = document.getElementById('fl-older-files');
  const chevron = document.getElementById('fl-archive-chevron');
  if (!older) return;
  const open = older.style.display !== 'none';
  older.style.display = open ? 'none' : 'block';
  if (chevron) chevron.textContent = open ? '▶' : '▼';
}

/* ═══════════════════════════════════════════════════════════════
   CONTEXT MENU (right-click on file row)
   ═══════════════════════════════════════════════════════════════ */

let _flCtxMenu = null;

function _attachFileRowContextMenus(container) {
  // Context menus are attached via inline oncontextmenu handlers in HTML
  // Close context menu on outside click
  document.addEventListener('click', _closeFileCtxMenu, { once: false });
}

function _showFileCtxMenu(event, fileId) {
  event.preventDefault();
  _closeFileCtxMenu();

  const file = _flCurrentFiles.find(f => f.id === fileId);
  if (!file) return;

  const isHostOrAdmin = _isHostOrAdmin();
  const cat = _flCurrentModalCat;

  const menu = document.createElement('div');
  menu.id = 'fl-file-ctx-menu';
  menu.className = 'context-menu';
  menu.style.cssText = `
    position: fixed;
    top: ${event.clientY}px;
    left: ${event.clientX}px;
    z-index: 2000;
  `;

  const items = [];

  if (file.driveEmbedUrl || file.driveWebViewLink) {
    items.push({ label: '👁️  Preview', action: () => _previewFile(fileId) });
  }
  if (file.driveDownloadLink) {
    items.push({ label: '⬇️  Download', action: () => window.open(file.driveDownloadLink, '_blank') });
  }

  // Rename — available to host/admin always; members only if they're the file owner
  const canRename = isHostOrAdmin || (file.ownerUid === AppState.currentUser?.uid);
  if (canRename) {
    items.push({ label: '✏️  Rename', action: () => _promptRename(fileId) });
  }

  if (items.length > 0) {
    items.push({ sep: true });
  }

  if (isHostOrAdmin) {
    items.push({ label: '🗑️  Delete', action: () => _deleteFile(fileId), danger: true });
  }

  menu.innerHTML = items.map(item => {
    if (item.sep) return '<div class="ctx-item-fl-sep"></div>';
    return `<button class="ctx-item-fl${item.danger ? ' danger' : ''}">${item.label}</button>`;
  }).join('');

  // Bind click actions
  const btns = menu.querySelectorAll('button.ctx-item-fl');
  const actionItems = items.filter(i => !i.sep);
  btns.forEach((btn, i) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      _closeFileCtxMenu();
      actionItems[i].action();
    });
  });

  document.body.appendChild(menu);
  _flCtxMenu = menu;

  // Ensure the menu doesn't go off-screen
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (event.clientX - rect.width) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (event.clientY - rect.height) + 'px';
  });
}

function _closeFileCtxMenu() {
  if (_flCtxMenu) {
    _flCtxMenu.remove();
    _flCtxMenu = null;
  }
}

/* ═══════════════════════════════════════════════════════════════
   FILE ACTIONS
   ═══════════════════════════════════════════════════════════════ */

function _previewFile(fileId) {
  const file = _flCurrentFiles.find(f => f.id === fileId);
  if (!file) return;
  // Delegate to existing document-service.js viewer function (opens separate tab)
  if (typeof openDriveFileViewer === 'function') {
    openDriveFileViewer(file);
  } else if (file.driveWebViewLink) {
    window.open(file.driveWebViewLink, '_blank');
  }
}

function _deleteFile(fileId) {
  const file = _flCurrentFiles.find(f => f.id === fileId);
  if (!file) return;
  if (!confirm(`Delete "${getLocalFileName(fileId, file.fileName)}"? This cannot be undone.`)) return;

  // Delegate to existing document-service.js delete function
  if (typeof deleteDriveFile === 'function') {
    deleteDriveFile(fileId, _flCurrentSuiteId);
  } else {
    // Fallback: call API directly
    const uid = AppState.currentUser && AppState.currentUser.uid;
    API.deleteDriveFile(fileId, _flCurrentSuiteId)
      .then(res => {
        if (res.success) {
          showToast('main-toast', 'File deleted', 'success');
        } else {
          showToast('main-toast', res.error || 'Delete failed', 'error');
        }
      })
      .catch(err => showToast('main-toast', 'Delete failed: ' + err.message, 'error'));
  }
}

function _promptRename(fileId) {
  const file = _flCurrentFiles.find(f => f.id === fileId);
  if (!file) return;

  const current = getLocalFileName(fileId, file.fileName);
  const newName = prompt('Rename file:', current);
  if (!newName || newName.trim() === '' || newName.trim() === current) return;

  const trimmed = newName.trim();

  // Preserve extension if user accidentally removed it
  const origExt = _getExt(file.fileName);
  const newExt  = _getExt(trimmed);
  const finalName = (origExt && !newExt) ? `${trimmed}.${origExt}` : trimmed;

  renameDriveFileById(fileId, finalName);
}

/**
 * Calls PATCH /api/drive/files/:fileId (Option A backend rename)
 */
function renameDriveFileById(fileId, newName) {
  const file = _flCurrentFiles.find(f => f.id === fileId);
  if (!file) return;

  // Optimistic local update
  setLocalFileName(fileId, newName);
  // Re-render current modal if open
  if (_flCurrentModalCat) {
    openCategoryModal(_flCurrentModalCat);
  } else {
    renderFileGrid(_flCurrentFiles);
  }

  // Call backend
  const uid = AppState.currentUser && AppState.currentUser.uid;
  const suiteId = _flCurrentSuiteId;

  fileGridFetch(`/api/drive/files/${fileId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: newName, suiteId }),
  }).then(res => {
    if (res.success) {
      // Backend persisted — clear local override (Firestore listener will update)
      delete _flRenames[fileId];
      _saveLocalRenames(suiteId);
      showToast('main-toast', `Renamed to "${newName}"`, 'success');
    } else {
      showToast('main-toast', res.error || 'Rename failed', 'error');
    }
  }).catch(err => {
    showToast('main-toast', 'Rename failed: ' + err.message, 'error');
  });
}

/* ═══════════════════════════════════════════════════════════════
   LOCAL RENAME OVERRIDE (localStorage fallback / optimistic)
   ═══════════════════════════════════════════════════════════════ */

function getLocalFileName(fileId, fallback) {
  return _flRenames[fileId] || fallback || 'Untitled';
}

function setLocalFileName(fileId, name) {
  _flRenames[fileId] = name;
  _saveLocalRenames(_flCurrentSuiteId);
}

function _loadLocalRenames(suiteId) {
  if (!suiteId) return;
  try {
    const raw = localStorage.getItem(`colearn_renames_${suiteId}`);
    _flRenames = raw ? JSON.parse(raw) : {};
  } catch (e) {
    _flRenames = {};
  }
}

function _saveLocalRenames(suiteId) {
  if (!suiteId) return;
  try {
    localStorage.setItem(`colearn_renames_${suiteId}`, JSON.stringify(_flRenames));
  } catch (e) { /* storage full — ignore */ }
}

/* ═══════════════════════════════════════════════════════════════
   FILE ICON RENDERERS
   ═══════════════════════════════════════════════════════════════ */

function _renderFileIconSmall(cat) {
  const labels = { pdf: 'PDF', docx: 'DOC', pptx: 'PPT', image: 'IMG', other: 'FILE' };
  return `<div class="fl-file-icon ${cat}" style="width:24px;height:30px;font-size:0.42rem;">${labels[cat] || 'FILE'}</div>`;
}

function _renderFileIconFull(cat) {
  const labels = { pdf: 'PDF', docx: 'DOC', pptx: 'PPT', image: 'IMG', other: 'FILE' };
  return `<div class="fl-file-icon ${cat}">${labels[cat] || 'FILE'}</div>`;
}

/* ═══════════════════════════════════════════════════════════════
   DOM SETUP
   ═══════════════════════════════════════════════════════════════ */

function _ensureCategoryGridContainer() {
  // The container is injected by index.html. This is a safety fallback.
  if (!document.getElementById('ws-file-category-grid')) {
    const inviteState = document.getElementById('ws-state-invite');
    if (!inviteState) return;
    const grid = document.createElement('div');
    grid.id = 'ws-file-category-grid';
    grid.className = 'fl-cat-grid';
    // Insert at the top of ws-state-invite
    inviteState.insertBefore(grid, inviteState.firstChild);
  }
}

function _ensureModalDOM() {
  if (document.getElementById('fl-cat-modal-backdrop')) return;

  const backdrop = document.createElement('div');
  backdrop.id = 'fl-cat-modal-backdrop';
  backdrop.innerHTML = `
    <div id="fl-cat-modal">
      <div id="fl-cat-modal-header">
        <div id="fl-cat-modal-title"></div>
        <button id="fl-cat-modal-close" onclick="closeCategoryModal()" title="Close">✕</button>
      </div>
      <div id="fl-cat-modal-body"></div>
    </div>`;

  // Close on backdrop click (not modal click)
  backdrop.addEventListener('click', e => {
    if (e.target === backdrop) closeCategoryModal();
  });

  document.body.appendChild(backdrop);
}

/* ═══════════════════════════════════════════════════════════════
   PERMISSION HELPERS
   ═══════════════════════════════════════════════════════════════ */

function _isHostOrAdmin() {
  const role = AppState.wsRole || 'member';
  return role === 'host' || role === 'admin';
}

/* ═══════════════════════════════════════════════════════════════
   UTILITY HELPERS
   ═══════════════════════════════════════════════════════════════ */

function _esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function _truncate(str, maxLen) {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen - 1) + '…' : str;
}

function _formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

/**
 * Local fetch helper with auth headers.
 */
function fileGridFetch(path, options = {}) {
  const headers = Object.assign({}, options.headers || {});

  const uid = AppState.currentUser?.uid;
  const token = AppState.currentUser?.token;

  if (uid) headers["X-FS-UID"] = uid;
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const base = (window.CONFIG && window.CONFIG.API_BASE) || '';
  if (window.CONFIG && window.CONFIG.IS_PRODUCTION && !base) {
    return Promise.reject(new Error('Production backend URL is not configured.'));
  }

  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  const credentialsMode = options.credentials || (window.CONFIG && window.CONFIG.IS_CROSS_ORIGIN ? 'include' : 'same-origin');

  return fetch(`${base}${cleanPath}`, {
    ...options,
    credentials: credentialsMode,
    headers
  }).then(r => r.json());
}

/* ═══════════════════════════════════════════════════════════════
   EXPOSE TO WINDOW
   ═══════════════════════════════════════════════════════════════ */

window.fileGridInit      = fileGridInit;
window.renderFileGrid    = renderFileGrid;
window.openCategoryModal = openCategoryModal;
window.closeCategoryModal = closeCategoryModal;
window.getLocalFileName  = getLocalFileName;
window.setLocalFileName  = setLocalFileName;
window.renameDriveFileById = renameDriveFileById;
window._showFileCtxMenu  = _showFileCtxMenu;
window._toggleOlderFiles = _toggleOlderFiles;
window._previewFile      = _previewFile;
window._deleteFile       = _deleteFile;
