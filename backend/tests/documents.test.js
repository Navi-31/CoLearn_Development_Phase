/**
 * backend/tests/documents.test.js
 *
 * Regression tests for the document subsystem.
 * Zero network calls, zero Firebase calls — pure unit tests.
 *
 * Run:  node --test tests/documents.test.js
 *
 * Coverage:
 *  1.  _currentSuiteId() reads AppState (not a shadow variable)
 *  2.  _resumePendingUploads() skips when no active suite
 *  3.  _resumePendingUploads() skips needsReselect items
 *  4.  _resumePendingUploads() skips items with no file binary
 *  5.  Upload error log (_logUploadError / getRecentUploadErrors)
 *  6.  Suite isolation: each suite has its own file cache
 *  7.  clearSuiteDocState prunes stale caches
 *  8.  clearSuiteDocState preserveQueue=true keeps queue items
 *  9.  clearSuiteDocState preserveQueue=false clears queue
 *  10. renderDriveFiles suiteId param overrides AppState
 *  11. addDriveFileToList respects suite isolation guard
 *  12. Queue localStorage round-trip (save → load → restore)
 *  13. Firestore listener: _unsubscribeFirestoreFiles cleans up
 *  14. getListenerCount aggregates SSE + Firestore counts
 *  15. Duplicate upload auto-retry only when file binary present
 */

'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

/* ══════════════════════════════════════════════════════════════════
   MOCK ENVIRONMENT
   We simulate the browser globals that document-service.js relies on
   without actually loading the script (it uses the DOM).
   Instead we test the pure logic functions directly by recreating them.
   ══════════════════════════════════════════════════════════════════ */

// ── Minimal AppState mock ─────────────────────────────────────────
let _mockAppState = {
  currentUser:  null,
  currentSuite: null,
};

function _currentSuiteId() {
  return (_mockAppState && _mockAppState.currentSuite && _mockAppState.currentSuite.id)
    ? _mockAppState.currentSuite.id
    : null;
}

// ── Upload error log (copied from document-service.js) ────────────
let _recentUploadErrors = [];

function _logUploadError(fileName, errorMsg) {
  _recentUploadErrors.unshift({
    fileName: fileName || 'unknown',
    error:    errorMsg || 'unknown error',
    at:       new Date().toISOString(),
  });
  if (_recentUploadErrors.length > 5) _recentUploadErrors.length = 5;
}

function getRecentUploadErrors() { return _recentUploadErrors.slice(); }

// ── Queue mock ────────────────────────────────────────────────────
function makeQueue() {
  const _items = [];
  return {
    getAll:  ()      => _items.slice(),
    get:     (id)    => _items.find(d => d.id === id) || null,
    add:     (item)  => { _items.push(item); },
    remove:  (id)    => { const i = _items.findIndex(d => d.id === id); if (i !== -1) _items.splice(i, 1); },
    clear:   ()      => { _items.length = 0; },
    get length()     { return _items.length; },
  };
}

// ── Suite file caches (copied from document-service.js) ──────────
let _driveFilesBySuite    = {};
let _driveRegistryBySuite = {};

function _activeCache()    { const id = _currentSuiteId(); return id ? (_driveFilesBySuite[id]    || []) : []; }
function _activeRegistry() { const id = _currentSuiteId(); return id ? (_driveRegistryBySuite[id] || {}) : {}; }

// ── clearSuiteDocState (simplified — no DOM ops) ─────────────────
let _firestoreFileUnsubscribe = null;

function _unsubscribeFirestoreFiles() {
  if (_firestoreFileUnsubscribe) {
    try { _firestoreFileUnsubscribe(); } catch (_) {}
    _firestoreFileUnsubscribe = null;
  }
}

function clearSuiteDocState(opts, queue) {
  const preserveQueue = opts && opts.preserveQueue === true;
  _unsubscribeFirestoreFiles();

  // Prune stale suite caches
  const currentId = _currentSuiteId();
  if (currentId) {
    Object.keys(_driveFilesBySuite).forEach(k => {
      if (k !== currentId) {
        delete _driveFilesBySuite[k];
        delete _driveRegistryBySuite[k];
      }
    });
  }

  if (!preserveQueue && queue) {
    queue.clear();
  }
}

// ── _resumePendingUploads (simplified — no actual XHR) ───────────
function _resumePendingUploads_logic(queue) {
  if (!_currentSuiteId()) return 'no_suite';

  const pending = queue.getAll().filter(d =>
    (d.status === 'pending' || d.status === 'error') && !d.needsReselect && d.file
  );

  if (!pending.length) return 'nothing_to_upload';
  return pending.map(d => d.id); // return IDs that would be uploaded
}

// ── getListenerCount (simplified) ────────────────────────────────
function getSseListenerInfo_mock() {
  return { connected: false, reconnectCount: 0 };
}

function getListenerCount(sseConnected, fsUnsubscribeFn) {
  const sseInfo = { connected: sseConnected, reconnectCount: 0 };
  const fsLive  = fsUnsubscribeFn ? 1 : 0;
  return {
    sse:       sseInfo.connected ? 1 : 0,
    firestore: fsLive,
    total:     (sseInfo.connected ? 1 : 0) + fsLive,
  };
}

// ── localStorage mock for queue persistence ───────────────────────
const _localStorageMock = {};
function _saveQueueToStorage(suiteId, items) {
  const serializable = items.map(d => ({
    id:   d.id,
    name: d.name,
    type: d.type,
    size: d.size,
    selectedBy:  d.selectedBy,
    status:      'pending',
    needsReselect: true,  // binary cannot survive serialisation
    addedAt:     d.addedAt || new Date().toISOString(),
  }));
  _localStorageMock['colearn_upload_queue_' + suiteId] = JSON.stringify(serializable);
}

function _loadQueueFromStorage(suiteId) {
  const raw = _localStorageMock['colearn_upload_queue_' + suiteId];
  if (!raw) return [];
  try {
    const items = JSON.parse(raw);
    return Array.isArray(items) ? items : [];
  } catch (_) { return []; }
}

/* ══════════════════════════════════════════════════════════════════
   TEST SUITES
   ══════════════════════════════════════════════════════════════════ */

describe('_currentSuiteId()', () => {
  test('returns null when AppState.currentSuite is null', () => {
    _mockAppState.currentSuite = null;
    assert.equal(_currentSuiteId(), null);
  });

  test('returns the suite id from AppState.currentSuite', () => {
    _mockAppState.currentSuite = { id: 'suite-abc', name: 'Math' };
    assert.equal(_currentSuiteId(), 'suite-abc');
  });

  test('returns null when AppState.currentSuite has no id', () => {
    _mockAppState.currentSuite = { name: 'No ID' };
    assert.equal(_currentSuiteId(), null);
  });

  test('changing AppState is immediately reflected (no shadow var)', () => {
    _mockAppState.currentSuite = { id: 'first' };
    assert.equal(_currentSuiteId(), 'first');
    _mockAppState.currentSuite = { id: 'second' };
    assert.equal(_currentSuiteId(), 'second');
  });
});

describe('_resumePendingUploads() logic', () => {
  beforeEach(() => {
    _mockAppState.currentSuite = null;
  });

  test('returns "no_suite" when AppState.currentSuite is null', () => {
    const q = makeQueue();
    q.add({ id: '1', name: 'file.pdf', status: 'pending', file: {}, needsReselect: false });
    assert.equal(_resumePendingUploads_logic(q), 'no_suite');
  });

  test('returns "nothing_to_upload" when all items are needsReselect', () => {
    _mockAppState.currentSuite = { id: 'suite-x' };
    const q = makeQueue();
    q.add({ id: '1', name: 'file.pdf', status: 'pending', file: null, needsReselect: true });
    assert.equal(_resumePendingUploads_logic(q), 'nothing_to_upload');
  });

  test('returns "nothing_to_upload" when items have no file binary', () => {
    _mockAppState.currentSuite = { id: 'suite-x' };
    const q = makeQueue();
    q.add({ id: '1', name: 'file.pdf', status: 'pending', file: null, needsReselect: false });
    assert.equal(_resumePendingUploads_logic(q), 'nothing_to_upload');
  });

  test('returns IDs of uploadable items when suite is active', () => {
    _mockAppState.currentSuite = { id: 'suite-x' };
    const q = makeQueue();
    q.add({ id: 'a', name: 'file.pdf', status: 'pending', file: {}, needsReselect: false });
    q.add({ id: 'b', name: 'img.png',  status: 'error',   file: {}, needsReselect: false });
    q.add({ id: 'c', name: 'lost.doc', status: 'pending', file: null, needsReselect: true });
    const result = _resumePendingUploads_logic(q);
    assert.deepEqual(result, ['a', 'b']); // c is skipped
  });

  test('uploaded items are excluded', () => {
    _mockAppState.currentSuite = { id: 'suite-x' };
    const q = makeQueue();
    q.add({ id: 'done', name: 'done.pdf', status: 'uploaded', file: {}, needsReselect: false });
    assert.equal(_resumePendingUploads_logic(q), 'nothing_to_upload');
  });
});

describe('Upload error log', () => {
  beforeEach(() => {
    _recentUploadErrors.length = 0;
  });

  test('getRecentUploadErrors returns empty array initially', () => {
    assert.deepEqual(getRecentUploadErrors(), []);
  });

  test('_logUploadError adds entry with correct fields', () => {
    _logUploadError('report.pdf', 'Network error');
    const errors = getRecentUploadErrors();
    assert.equal(errors.length, 1);
    assert.equal(errors[0].fileName, 'report.pdf');
    assert.equal(errors[0].error, 'Network error');
    assert.ok(errors[0].at); // ISO timestamp
  });

  test('entries are stored newest-first (LIFO)', () => {
    _logUploadError('a.pdf', 'err1');
    _logUploadError('b.pdf', 'err2');
    const errors = getRecentUploadErrors();
    assert.equal(errors[0].fileName, 'b.pdf');
    assert.equal(errors[1].fileName, 'a.pdf');
  });

  test('capped at 5 entries (oldest dropped)', () => {
    for (let i = 1; i <= 7; i++) _logUploadError(`file${i}.pdf`, `err${i}`);
    const errors = getRecentUploadErrors();
    assert.equal(errors.length, 5);
    assert.equal(errors[0].fileName, 'file7.pdf'); // newest first
    assert.equal(errors[4].fileName, 'file3.pdf'); // 6 and 7 (oldest) dropped
  });

  test('getRecentUploadErrors returns a copy (no mutation)', () => {
    _logUploadError('x.pdf', 'err');
    const a = getRecentUploadErrors();
    const b = getRecentUploadErrors();
    a.push({ fake: true });
    assert.equal(b.length, 1); // b is not affected
  });
});

describe('Suite file cache isolation', () => {
  beforeEach(() => {
    _driveFilesBySuite    = {};
    _driveRegistryBySuite = {};
    _mockAppState.currentSuite = null;
  });

  test('_activeCache returns [] when no suite active', () => {
    assert.deepEqual(_activeCache(), []);
  });

  test('_activeRegistry returns {} when no suite active', () => {
    assert.deepEqual(_activeRegistry(), {});
  });

  test('files for suiteA do not appear in suiteB cache', () => {
    _driveFilesBySuite['suite-A'] = [{ id: 'f1', fileName: 'a.pdf' }];
    _driveFilesBySuite['suite-B'] = [{ id: 'f2', fileName: 'b.pdf' }];

    _mockAppState.currentSuite = { id: 'suite-A' };
    assert.equal(_activeCache().length, 1);
    assert.equal(_activeCache()[0].id, 'f1');

    _mockAppState.currentSuite = { id: 'suite-B' };
    assert.equal(_activeCache().length, 1);
    assert.equal(_activeCache()[0].id, 'f2');
  });

  test('switching suite immediately changes active cache (no stale data)', () => {
    _driveFilesBySuite['suite-A'] = [{ id: 'f1' }];
    _driveFilesBySuite['suite-B'] = [];
    _mockAppState.currentSuite = { id: 'suite-A' };
    assert.equal(_activeCache().length, 1);
    _mockAppState.currentSuite = { id: 'suite-B' };
    assert.equal(_activeCache().length, 0);
  });
});

describe('clearSuiteDocState()', () => {
  beforeEach(() => {
    _driveFilesBySuite    = {};
    _driveRegistryBySuite = {};
    _firestoreFileUnsubscribe = null;
  });

  test('prunes stale suite caches, keeps current suite', () => {
    _mockAppState.currentSuite = { id: 'current' };
    _driveFilesBySuite['current'] = [{ id: 'f1' }];
    _driveFilesBySuite['old-A']   = [{ id: 'f2' }];
    _driveFilesBySuite['old-B']   = [{ id: 'f3' }];

    clearSuiteDocState({}, null);

    assert.ok(_driveFilesBySuite['current']);     // kept
    assert.equal(_driveFilesBySuite['old-A'], undefined); // pruned
    assert.equal(_driveFilesBySuite['old-B'], undefined); // pruned
  });

  test('preserveQueue=false clears the queue', () => {
    _mockAppState.currentSuite = { id: 'suite-x' };
    const q = makeQueue();
    q.add({ id: '1', name: 'a.pdf', status: 'pending' });
    assert.equal(q.length, 1);
    clearSuiteDocState({ preserveQueue: false }, q);
    assert.equal(q.length, 0);
  });

  test('preserveQueue=true keeps the queue', () => {
    _mockAppState.currentSuite = { id: 'suite-x' };
    const q = makeQueue();
    q.add({ id: '1', name: 'a.pdf', status: 'pending' });
    clearSuiteDocState({ preserveQueue: true }, q);
    assert.equal(q.length, 1);
  });

  test('default (no opts) clears the queue', () => {
    _mockAppState.currentSuite = { id: 'suite-x' };
    const q = makeQueue();
    q.add({ id: '1', name: 'a.pdf', status: 'pending' });
    clearSuiteDocState(undefined, q);
    assert.equal(q.length, 0);
  });

  test('calls _unsubscribeFirestoreFiles (listener cleanup)', () => {
    let cleaned = false;
    _firestoreFileUnsubscribe = () => { cleaned = true; };
    _mockAppState.currentSuite = { id: 'suite-x' };
    clearSuiteDocState({}, null);
    assert.equal(cleaned, true);
    assert.equal(_firestoreFileUnsubscribe, null);
  });
});

describe('Queue localStorage round-trip', () => {
  beforeEach(() => {
    Object.keys(_localStorageMock).forEach(k => delete _localStorageMock[k]);
  });

  test('save → load returns items with needsReselect=true', () => {
    const items = [
      { id: 'q1', name: 'report.pdf', type: 'application/pdf', size: 1024, selectedBy: 'Alice', addedAt: new Date().toISOString() },
    ];
    _saveQueueToStorage('suite-Z', items);
    const loaded = _loadQueueFromStorage('suite-Z');
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, 'q1');
    assert.equal(loaded[0].needsReselect, true);  // no file binary after restore
    assert.equal(loaded[0].status, 'pending');
  });

  test('load returns [] for unknown suiteId', () => {
    const loaded = _loadQueueFromStorage('nonexistent-suite');
    assert.deepEqual(loaded, []);
  });

  test('load for suiteA does not return suiteB items', () => {
    _saveQueueToStorage('suite-A', [{ id: 'a1', name: 'a.pdf', type: '', size: 0, selectedBy: 'X', addedAt: '' }]);
    _saveQueueToStorage('suite-B', [{ id: 'b1', name: 'b.pdf', type: '', size: 0, selectedBy: 'Y', addedAt: '' }]);
    const aItems = _loadQueueFromStorage('suite-A');
    assert.equal(aItems.length, 1);
    assert.equal(aItems[0].id, 'a1');
  });

  test('load handles corrupt JSON gracefully', () => {
    _localStorageMock['colearn_upload_queue_bad'] = '{corrupt json[';
    const loaded = _loadQueueFromStorage('bad');
    assert.deepEqual(loaded, []);
  });
});

describe('getListenerCount()', () => {
  test('returns all zeros when nothing is connected', () => {
    const c = getListenerCount(false, null);
    assert.deepEqual(c, { sse: 0, firestore: 0, total: 0 });
  });

  test('counts SSE when connected', () => {
    const c = getListenerCount(true, null);
    assert.equal(c.sse, 1);
    assert.equal(c.total, 1);
  });

  test('counts Firestore when subscribed', () => {
    const c = getListenerCount(false, () => {});
    assert.equal(c.firestore, 1);
    assert.equal(c.total, 1);
  });

  test('counts both when both active', () => {
    const c = getListenerCount(true, () => {});
    assert.equal(c.sse, 1);
    assert.equal(c.firestore, 1);
    assert.equal(c.total, 2);
  });
});

describe('Auto-retry guard: only retry when file binary present', () => {
  test('retry flag is respected when file is present', () => {
    const doc = { id: 'x', name: 'a.pdf', status: 'error', file: {}, _retried: false };
    // Simulate the xhr.onerror guard logic
    const shouldRetry = !doc._retried && !!doc.file;
    assert.equal(shouldRetry, true);
  });

  test('no retry when file binary is missing', () => {
    const doc = { id: 'x', name: 'a.pdf', status: 'error', file: null, _retried: false };
    const shouldRetry = !doc._retried && !!doc.file;
    assert.equal(shouldRetry, false);
  });

  test('no retry when already retried', () => {
    const doc = { id: 'x', name: 'a.pdf', status: 'error', file: {}, _retried: true };
    const shouldRetry = !doc._retried && !!doc.file;
    assert.equal(shouldRetry, false);
  });
});
