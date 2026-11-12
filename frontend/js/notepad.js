'use strict';
/**
 * notepad.js – CoLearn Suite Floating Notepad
 * ─────────────────────────────────────────────────────────────────
 * A draggable, resizable multi-note floating window.
 * Persists entirely to localStorage — zero backend calls.
 * 
 * Storage key: colearn_notepad_{suiteId}
 * Format: { notes: [{ id, title, content, updatedAt }], activeNoteId }
 * 
 * Functions exposed to window:
 *   openNotepad()
 *   closeNotepad()
 *   toggleNotepad()
 */

/* ═══════════════════════════════════════════════════════════════
   CONSTANTS & STATE
   ═══════════════════════════════════════════════════════════════ */

const NOTEPAD_STORAGE_KEY = () => {
  const sid = AppState.currentSuite && AppState.currentSuite.id;
  return sid ? `colearn_notepad_${sid}` : 'colearn_notepad_global';
};

const NOTEPAD_AUTOSAVE_MS = 800; // debounce delay

let _npData = { notes: [], activeNoteId: null };
let _npAutoSaveTimer = null;
let _npDragging = false;
let _npDragOffsetX = 0;
let _npDragOffsetY = 0;
let _npInitialized = false;

/* ═══════════════════════════════════════════════════════════════
   INITIALISATION
   ═══════════════════════════════════════════════════════════════ */

function _notepadInit() {
  if (_npInitialized) return;
  _npInitialized = true;

  _ensureNotepadDOM();
  _loadNotepadData();

  // Ensure at least one note exists
  if (_npData.notes.length === 0) {
    _npCreateNote('Note 1');
  }

  _renderNoteList();
  _activateNote(_npData.activeNoteId || (_npData.notes[0] && _npData.notes[0].id));

  // Set up drag
  const titlebar = document.getElementById('notepad-titlebar');
  if (titlebar) {
    titlebar.addEventListener('mousedown', _onDragStart);
  }

  // Auto-save on editor input
  const editor = document.getElementById('notepad-editor');
  if (editor) {
    editor.addEventListener('input', _onEditorInput);
  }
}

/* ═══════════════════════════════════════════════════════════════
   PUBLIC API
   ═══════════════════════════════════════════════════════════════ */

function openNotepad() {
  _notepadInit();
  const win = document.getElementById('notepad-window');
  if (win) win.classList.add('open');
}

function closeNotepad() {
  _saveNotepadData(); // save immediately on close
  const win = document.getElementById('notepad-window');
  if (win) win.classList.remove('open');
}

function toggleNotepad() {
  const win = document.getElementById('notepad-window');
  if (!win) { openNotepad(); return; }
  if (win.classList.contains('open')) {
    closeNotepad();
  } else {
    openNotepad();
  }
}

/* ═══════════════════════════════════════════════════════════════
   NOTE CRUD
   ═══════════════════════════════════════════════════════════════ */

function _npCreateNote(title) {
  const id = 'note_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const note = { id, title: title || 'Untitled', content: '', updatedAt: new Date().toISOString() };
  _npData.notes.push(note);
  return note;
}

function _npDeleteNote(noteId) {
  if (_npData.notes.length <= 1) {
    if (typeof showToast === 'function') showToast('main-toast', 'Cannot delete the last note.', 'red');
    return;
  }
  _npData.notes = _npData.notes.filter(n => n.id !== noteId);
  const next = _npData.notes[0];
  _activateNote(next ? next.id : null);
  _renderNoteList();
  _saveNotepadData();
}

function _npRenameNote(noteId) {
  const note = _npData.notes.find(n => n.id === noteId);
  if (!note) return;
  const newTitle = prompt('Rename note:', note.title);
  if (!newTitle || !newTitle.trim()) return;
  note.title = newTitle.trim().slice(0, 60);
  note.updatedAt = new Date().toISOString();
  _renderNoteList();
  _saveNotepadData();
}

function _activateNote(noteId) {
  const note = _npData.notes.find(n => n.id === noteId);
  if (!note) return;
  _npData.activeNoteId = noteId;

  const editor = document.getElementById('notepad-editor');
  if (editor) editor.value = note.content;

  _renderNoteList();
}

/* ═══════════════════════════════════════════════════════════════
   RENDER
   ═══════════════════════════════════════════════════════════════ */

function _renderNoteList() {
  const list = document.getElementById('notepad-notes-list');
  if (!list) return;

  list.innerHTML = _npData.notes.map(note => `
    <div class="notepad-note-item ${note.id === _npData.activeNoteId ? 'active' : ''}"
         onclick="_activateNote('${_esc(note.id)}')"
         oncontextmenu="_noteItemCtxMenu(event,'${_esc(note.id)}');return false;"
         title="${_esc(note.title)}">
      ${_esc(_truncate(note.title, 18))}
    </div>
  `).join('');
}

function _noteItemCtxMenu(event, noteId) {
  event.preventDefault();
  const menu = [
    { label: '✏️ Rename', action: () => _npRenameNote(noteId) },
    { label: '🗑️ Delete', action: () => _npDeleteNote(noteId), danger: true },
  ];

  // Quick inline context using native confirm/prompt — no extra DOM needed
  const choice = menu.map((m, i) => `${i + 1}. ${m.label}`).join('\n');
  const sel = parseInt(prompt(`Note actions:\n${choice}`));
  if (!isNaN(sel) && menu[sel - 1]) menu[sel - 1].action();
}

/* ═══════════════════════════════════════════════════════════════
   EDITOR INPUT / AUTOSAVE
   ═══════════════════════════════════════════════════════════════ */

function _onEditorInput() {
  const editor = document.getElementById('notepad-editor');
  if (!editor) return;

  const note = _npData.notes.find(n => n.id === _npData.activeNoteId);
  if (note) {
    note.content = editor.value;
    note.updatedAt = new Date().toISOString();
    // Update title from first line if it's still the default
    const firstLine = editor.value.split('\n')[0].trim().slice(0, 60);
    if (firstLine && note.title === 'Untitled') {
      note.title = firstLine || 'Untitled';
      _renderNoteList();
    }
  }

  // Debounced save
  clearTimeout(_npAutoSaveTimer);
  _npAutoSaveTimer = setTimeout(_saveNotepadData, NOTEPAD_AUTOSAVE_MS);
}

/* ═══════════════════════════════════════════════════════════════
   PERSISTENCE
   ═══════════════════════════════════════════════════════════════ */

function _loadNotepadData() {
  try {
    const raw = localStorage.getItem(NOTEPAD_STORAGE_KEY());
    if (raw) {
      _npData = JSON.parse(raw);
      if (!Array.isArray(_npData.notes)) _npData.notes = [];
    }
  } catch (e) {
    _npData = { notes: [], activeNoteId: null };
  }
}

function _saveNotepadData() {
  try {
    localStorage.setItem(NOTEPAD_STORAGE_KEY(), JSON.stringify(_npData));
  } catch (e) { /* storage full — ignore */ }
}

/* ═══════════════════════════════════════════════════════════════
   DRAG
   ═══════════════════════════════════════════════════════════════ */

function _onDragStart(e) {
  if (e.target.id === 'notepad-close-btn') return;
  _npDragging = true;
  const win = document.getElementById('notepad-window');
  if (!win) return;
  const rect = win.getBoundingClientRect();
  _npDragOffsetX = e.clientX - rect.left;
  _npDragOffsetY = e.clientY - rect.top;
  win.style.transition = 'none';
  document.addEventListener('mousemove', _onDragMove);
  document.addEventListener('mouseup', _onDragEnd);
}

function _onDragMove(e) {
  if (!_npDragging) return;
  const win = document.getElementById('notepad-window');
  if (!win) return;
  const x = Math.max(0, Math.min(window.innerWidth - 200, e.clientX - _npDragOffsetX));
  const y = Math.max(0, Math.min(window.innerHeight - 100, e.clientY - _npDragOffsetY));
  win.style.left = x + 'px';
  win.style.top  = y + 'px';
}

function _onDragEnd() {
  _npDragging = false;
  document.removeEventListener('mousemove', _onDragMove);
  document.removeEventListener('mouseup', _onDragEnd);
}

/* ═══════════════════════════════════════════════════════════════
   DOM INJECTION
   ═══════════════════════════════════════════════════════════════ */

function _ensureNotepadDOM() {
  if (document.getElementById('notepad-window')) return;

  const win = document.createElement('div');
  win.id = 'notepad-window';
  win.innerHTML = `
    <div id="notepad-titlebar">
      <span style="font-size:0.9rem;">📝</span>
      <span id="notepad-titlebar-title">Notes</span>
      <button id="notepad-add-btn" onclick="_npAddNote()"
        style="background:none;border:1px solid var(--fl-border);border-radius:4px;cursor:pointer;font-size:0.75rem;
               padding:0.15rem 0.4rem;color:var(--fl-text-lo);line-height:1;transition:all 0.15s;"
        title="New note">+</button>
      <button id="notepad-close-btn" onclick="closeNotepad()" title="Close">✕</button>
    </div>
    <div id="notepad-body">
      <div id="notepad-notes-list"></div>
      <textarea id="notepad-editor" placeholder="Start writing...&#10;&#10;Notes auto-save to your browser."></textarea>
    </div>
    <div id="notepad-toolbar">
      <span style="font-size:0.72rem;color:var(--fl-text-muted);flex:1;">Auto-saved · local only</span>
      <button onclick="_npDeleteCurrentNote()"
        class="fl-btn fl-btn-danger fl-btn-sm" style="font-size:0.7rem;" title="Delete this note">🗑</button>
    </div>`;

  document.body.appendChild(win);
}

function _npAddNote() {
  _saveNotepadData(); // save current before switching
  const note = _npCreateNote('Untitled');
  _renderNoteList();
  _activateNote(note.id);
  const editor = document.getElementById('notepad-editor');
  if (editor) editor.focus();
}

function _npDeleteCurrentNote() {
  if (_npData.activeNoteId) _npDeleteNote(_npData.activeNoteId);
}

/* ═══════════════════════════════════════════════════════════════
   UTILITY
   ═══════════════════════════════════════════════════════════════ */

function _esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function _truncate(str, n) {
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

/* ═══════════════════════════════════════════════════════════════
   EXPOSE TO WINDOW
   ═══════════════════════════════════════════════════════════════ */

window.openNotepad    = openNotepad;
window.closeNotepad   = closeNotepad;
window.toggleNotepad  = toggleNotepad;
window._activateNote  = _activateNote;
window._noteItemCtxMenu = _noteItemCtxMenu;
window._npAddNote     = _npAddNote;
window._npDeleteCurrentNote = _npDeleteCurrentNote;
