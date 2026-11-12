/* ── whiteboard.js – CoLearn Multi-Page Shared Whiteboard ──────
 *
 * Features:
 *   • Exact 4:3 Aspect Ratio responsive canvas (1600 x 1200 internal coordinate space)
 *   • Multi-page management (create, delete, navigate, page retention)
 *   • Undo / Redo per page (up to 30 history states) with Ctrl+Z / Ctrl+Y
 *   • Drawing tools: Pen, Eraser, Color picker, Brush size
 *   • Direct Text Tool: Click anywhere on whiteboard to type seamless multiline text (no boxes/cards)
 *   • Flowchart Maker: Start/End, Process, Decision shapes, Connectors/Arrows, node editing & movement
 *   • Real-time multi-user synchronization via Firebase RTDB
 *   • Single-page PNG export & Multi-page ZIP export (rasterizing handwriting, flowchart shapes & text)
 *   • Keyboard shortcuts & auto-hide bottom controls
 */

'use strict';

let wbCanvas, wbCtx;
let isDrawing        = false;
let lastX = 0, lastY = 0;
let wbTool           = 'pen'; // 'pen' | 'eraser' | 'text' | 'fc-start' | 'fc-process' | 'fc-decision' | 'fc-connector'
let wbColor          = '#212529';
let wbLineWidth      = 4;
let wbFontSize       = 32;

// Selection & editing state
let selectedTextId         = null;
let selectedNodeId         = null;
let selectedConnectorId    = null;
let _connectorSourceNodeId = null;
let _activeTextEditor      = null;
let _isDraggingObject      = false;
let _dragStartPos          = { x: 0, y: 0 };
let _objDragInitPos        = { x: 0, y: 0 };
let _hasDragged            = false;

// Page structure: Array<{ dataUrl: string|null, undoStack: string[], redoStack: string[], textObjects: Array, flowchartNodes: Array, flowchartConnectors: Array }>
let wbPages      = [{ dataUrl: null, undoStack: [], redoStack: [], textObjects: [], flowchartNodes: [], flowchartConnectors: [] }];
let wbPageIndex  = 0;

// Smart Recognition (Handwriting to Text/Math) state
let wbSmartRecognitionActive  = false;
let _smartCurrentStrokes      = [];
let _smartCurrentStroke       = null;
let _smartStrokeBounds        = null;
let _smartPreStrokeSnapshot   = null;
let _smartDebounceTimer       = null;
let _smartPredictionCard      = null;
let _smartCurrentCandidates   = [];
let _smartSelectedCandidate   = '';

// Synchronization state
let _wbSuiteId           = null;
let _wbRtdbRef           = null;
let _wbRtdbListener      = null;
let _isRemoteApplying    = false;
let _wbSyncDebounceTimer  = null;

/* ═══════════════════════════════════════════════════════════════
   INITIALISATION
   ═══════════════════════════════════════════════════════════════ */

function initWhiteboard() {
  wbCanvas = document.getElementById('whiteboard-canvas');
  if (!wbCanvas) return;
  wbCtx = wbCanvas.getContext('2d');

  // Set standard high-resolution 4:3 internal coordinate dimensions
  wbCanvas.width  = 1600;
  wbCanvas.height = 1200;

  // Reset listeners cleanly
  const newCanvas = wbCanvas.cloneNode(true);
  wbCanvas.parentNode.replaceChild(newCanvas, wbCanvas);
  wbCanvas = newCanvas;
  wbCtx    = wbCanvas.getContext('2d');

  wbCanvas.width  = 1600;
  wbCanvas.height = 1200;

  wbCanvas.addEventListener('pointerdown', onWBDown, { passive: false });
  wbCanvas.addEventListener('pointermove', onWBMove, { passive: false });
  wbCanvas.addEventListener('pointerup',   onWBUp);
  wbCanvas.addEventListener('pointercancel', onWBUp);
  wbCanvas.addEventListener('pointerout',  onWBUp);

  // Background overlay layers click handler
  const textLayer = document.getElementById('wb-text-layer');
  if (textLayer && !textLayer._wbBound) {
    textLayer._wbBound = true;
    textLayer.addEventListener('pointerdown', (e) => {
      if (e.target === textLayer) {
        onWBDown(e);
      }
    });
  }

  // Restore current page drawing & objects
  loadWBPage(wbPageIndex);
  _updateWBPageUI();
  _setupWBShortcuts();

  // Setup suite sync if in active suite
  if (window.AppState && window.AppState.currentSuite) {
    initWBSync(window.AppState.currentSuite.id);
  }

  if (window.AppState && window.AppState.wsCurrentState === 'whiteboard') {
    initWhiteboardAutoHide();
  }
}

function resizeWhiteboard() {
  if (!wbCanvas) return;
  if (wbCanvas.width !== 1600 || wbCanvas.height !== 1200) {
    let savedDataUrl = null;
    if (wbCanvas.width > 0 && wbCanvas.height > 0) {
      try { savedDataUrl = wbCanvas.toDataURL('image/png'); } catch (_) {}
    }
    wbCanvas.width  = 1600;
    wbCanvas.height = 1200;
    wbCtx.fillStyle = '#ffffff';
    wbCtx.fillRect(0, 0, 1600, 1200);

    if (savedDataUrl) {
      const img = new Image();
      img.onload = function() {
        try { wbCtx.drawImage(img, 0, 0, 1600, 1200); } catch (_) {}
      };
      img.src = savedDataUrl;
    }
  }
  _renderObjectLayer();
}

/** 
 * Maps screen mouse/touch event coordinates into exact 1600x1200 4:3 canvas space
 */
function getCanvasPos(e) {
  const rect = wbCanvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1600, (e.clientX - rect.left) * (1600 / rect.width))),
    y: Math.max(0, Math.min(1200, (e.clientY - rect.top)  * (1200 / rect.height))),
  };
}

function applyWBStyle() {
  if (wbTool === 'eraser') {
    wbCtx.globalCompositeOperation = 'destination-out';
    wbCtx.strokeStyle = 'rgba(0,0,0,1)';
    wbCtx.fillStyle   = 'rgba(0,0,0,1)';
    wbCtx.lineWidth   = wbLineWidth * 4;
  } else {
    wbCtx.globalCompositeOperation = 'source-over';
    wbCtx.strokeStyle = wbColor;
    wbCtx.fillStyle   = wbColor;
    wbCtx.lineWidth   = wbLineWidth;
  }
  wbCtx.lineCap  = 'round';
  wbCtx.lineJoin = 'round';
}

/* ═══════════════════════════════════════════════════════════════
   DRAWING & INTERACTION EVENT HANDLERS
   ═══════════════════════════════════════════════════════════════ */

function onWBDown(e) {
  if (e.button !== 0 && e.pointerType === 'mouse') return;

  const pos = getCanvasPos(e);

  // ── Flowchart Node Placement ─────────────────────────────────
  if (wbTool === 'fc-start' || wbTool === 'fc-process' || wbTool === 'fc-decision') {
    _handleFlowchartPlacement(pos, wbTool);
    return;
  }

  // ── Connector Tool ───────────────────────────────────────────
  if (wbTool === 'fc-connector') {
    // Click on empty canvas deselects source
    _connectorSourceNodeId = null;
    _renderObjectLayer();
    return;
  }

  // ── Text Tool Action: Type directly at click location ────────
  if (wbTool === 'text') {
    _handleTextClick(pos);
    return;
  }

  // ── Freehand Drawing Action (Pen / Eraser) ───────────────────
  _commitActiveTextEditor();

  if (wbSmartRecognitionActive && wbTool === 'pen') {
    _dismissSmartPredictionCard();
    if (_smartCurrentStrokes.length === 0) {
      try {
        _smartPreStrokeSnapshot = wbCanvas.toDataURL('image/png');
      } catch (_) { _smartPreStrokeSnapshot = null; }
      _smartStrokeBounds = { minX: pos.x, minY: pos.y, maxX: pos.x, maxY: pos.y };
    } else if (_smartStrokeBounds) {
      _smartStrokeBounds.minX = Math.min(_smartStrokeBounds.minX, pos.x);
      _smartStrokeBounds.minY = Math.min(_smartStrokeBounds.minY, pos.y);
      _smartStrokeBounds.maxX = Math.max(_smartStrokeBounds.maxX, pos.x);
      _smartStrokeBounds.maxY = Math.max(_smartStrokeBounds.maxY, pos.y);
    }
    if (_smartDebounceTimer) {
      clearTimeout(_smartDebounceTimer);
      _smartDebounceTimer = null;
    }
    _smartCurrentStroke = { x: [Math.round(pos.x)], y: [Math.round(pos.y)], t: [Date.now()] };
  }

  _pushWBUndo();

  isDrawing = true;
  lastX = pos.x; 
  lastY = pos.y;
  applyWBStyle();

  wbCtx.beginPath();
  wbCtx.arc(lastX, lastY, wbCtx.lineWidth / 2, 0, Math.PI * 2);
  wbCtx.fill();
}

function onWBMove(e) {
  if (!isDrawing || wbTool === 'text' || wbTool.startsWith('fc-')) return;
  e.preventDefault();

  const pos = getCanvasPos(e);
  applyWBStyle();

  wbCtx.beginPath();
  wbCtx.moveTo(lastX, lastY);
  wbCtx.lineTo(pos.x, pos.y);
  wbCtx.stroke();

  lastX = pos.x; 
  lastY = pos.y;

  if (wbSmartRecognitionActive && wbTool === 'pen' && _smartCurrentStroke) {
    _smartCurrentStroke.x.push(Math.round(pos.x));
    _smartCurrentStroke.y.push(Math.round(pos.y));
    _smartCurrentStroke.t.push(Date.now());
    if (_smartStrokeBounds) {
      _smartStrokeBounds.minX = Math.min(_smartStrokeBounds.minX, pos.x);
      _smartStrokeBounds.minY = Math.min(_smartStrokeBounds.minY, pos.y);
      _smartStrokeBounds.maxX = Math.max(_smartStrokeBounds.maxX, pos.x);
      _smartStrokeBounds.maxY = Math.max(_smartStrokeBounds.maxY, pos.y);
    }
  }
}

function onWBUp() {
  if (isDrawing) {
    isDrawing = false;
    _saveCurrentPage();
    _syncWBToRemote();

    if (wbSmartRecognitionActive && wbTool === 'pen' && _smartCurrentStroke) {
      _smartCurrentStrokes.push(_smartCurrentStroke);
      _smartCurrentStroke = null;
      if (_smartDebounceTimer) clearTimeout(_smartDebounceTimer);
      _smartDebounceTimer = setTimeout(_triggerSmartRecognition, 750);
    }
  }
}

/* ═══════════════════════════════════════════════════════════════
   TOOL CONTROLS
   ═══════════════════════════════════════════════════════════════ */

function setWBTool(tool) {
  _commitActiveTextEditor();
  _dismissSmartPredictionCard();
  if (tool !== 'pen') {
    _clearSmartStrokeState();
  }
  wbTool = tool;
  _connectorSourceNodeId = null;

  const tools = ['pen', 'eraser', 'text', 'flowchart'];
  tools.forEach(t => {
    const btn = document.getElementById('wb-btn-' + t);
    if (btn) btn.classList.toggle('active', tool === t);
  });

  const dfEl = document.getElementById('drawflow');
  const dfToolbar = document.getElementById('wb-flowchart-toolbar');

  if (tool === 'flowchart') {
    if (dfEl) dfEl.style.display = 'block';
    if (dfToolbar) dfToolbar.style.display = 'flex';
    initDrawflowEditor();
  } else {
    if (dfEl) dfEl.style.display = 'none';
    if (dfToolbar) dfToolbar.style.display = 'none';
  }

  if (wbCanvas) {
    if (tool === 'text') {
      wbCanvas.style.cursor = 'text';
    } else if (tool === 'flowchart') {
      wbCanvas.style.cursor = 'default';
    } else {
      wbCanvas.style.cursor = 'crosshair';
    }
  }
  _renderObjectLayer();
}

function updateWBColor(val) {
  wbColor = val;
  if (selectedTextId) {
    const page = wbPages[wbPageIndex];
    const item = page && page.textObjects ? page.textObjects.find(t => t.id === selectedTextId) : null;
    if (item) {
      item.color = val;
      _renderObjectLayer();
      _syncWBToRemote();
    }
  }
  if (selectedNodeId) {
    const page = wbPages[wbPageIndex];
    const node = page && page.flowchartNodes ? page.flowchartNodes.find(n => n.id === selectedNodeId) : null;
    if (node) {
      node.color = val;
      _renderObjectLayer();
      _syncWBToRemote();
    }
  }
  if (wbTool === 'eraser') setWBTool('pen');
}

function updateWBSize(val) {
  const parsed = parseInt(val, 10) || 4;
  wbLineWidth = parsed;
  wbFontSize  = Math.max(18, parsed * 5);

  if (selectedTextId) {
    const page = wbPages[wbPageIndex];
    const item = page && page.textObjects ? page.textObjects.find(t => t.id === selectedTextId) : null;
    if (item) {
      item.fontSize = wbFontSize;
      _renderObjectLayer();
      _syncWBToRemote();
    }
  }
}

/* ═══════════════════════════════════════════════════════════════
   PAGE DATA HELPERS
   ═══════════════════════════════════════════════════════════════ */

function _ensurePageObjects(page) {
  if (!page.textObjects)         page.textObjects = [];
  if (!page.flowchartNodes)      page.flowchartNodes = [];
  if (!page.flowchartConnectors) page.flowchartConnectors = [];
}

/* ═══════════════════════════════════════════════════════════════
   SEAMLESS DIRECT-TYPING TEXT TOOL (No Boxes / Borders)
   ═══════════════════════════════════════════════════════════════ */

function _commitActiveTextEditor() {
  if (_activeTextEditor && typeof _activeTextEditor.commit === 'function') {
    _activeTextEditor.commit();
  }
}

function _handleTextClick(pos) {
  const page = wbPages[wbPageIndex];
  _ensurePageObjects(page);

  // Check click on existing text object using accurate text measurements
  const hitItem = page.textObjects.slice().reverse().find(item => {
    const lines = (item.text || '').split('\n');
    const lineCount = Math.max(1, lines.length);
    const fontSize = item.fontSize || 32;
    let maxLineWidth = 0;
    if (wbCtx) {
      wbCtx.save();
      wbCtx.font = `500 ${fontSize}px 'Inter', -apple-system, BlinkMacSystemFont, sans-serif`;
      lines.forEach(l => {
        const m = wbCtx.measureText(l);
        if (m.width > maxLineWidth) maxLineWidth = m.width;
      });
      wbCtx.restore();
    } else {
      const maxLineLen = lines.reduce((max, l) => Math.max(max, l.length), 0);
      maxLineWidth = maxLineLen * fontSize * 0.7;
    }
    const w = Math.max(40, maxLineWidth + 20);
    const h = Math.max(24, lineCount * fontSize * 1.35 + 10);
    return pos.x >= item.x - 10 && pos.x <= item.x + w + 10 &&
           pos.y >= item.y - 10 && pos.y <= item.y + h + 10;
  });

  if (hitItem) {
    _openDirectTextEditor(hitItem, false);
    return;
  }

  // Otherwise, start typing directly at click position
  _commitActiveTextEditor();

  const newId = 'txt_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
  const newObj = {
    id: newId,
    x: Math.round(pos.x),
    y: Math.round(pos.y),
    text: '',
    fontSize: wbFontSize || 32,
    color: wbColor || '#212529',
  };

  page.textObjects.push(newObj);
  selectedTextId = newId;
  selectedNodeId = null;
  _openDirectTextEditor(newObj, true);
}

function _openDirectTextEditor(item, isNew) {
  _commitActiveTextEditor();

  const layer = document.getElementById('wb-text-layer');
  if (!layer || !wbCanvas) return;

  const rect = wbCanvas.getBoundingClientRect();
  const scale = rect.width > 0 ? (rect.width / 1600) : 1;

  const editor = document.createElement('textarea');
  editor.className = 'wb-text-editor';
  editor.value = item.text || '';
  editor.style.left = (item.x / 1600 * 100) + '%';
  editor.style.top  = (item.y / 1200 * 100) + '%';
  editor.style.color = item.color || '#212529';
  editor.style.fontSize = Math.max(12, Math.round((item.fontSize || 32) * scale)) + 'px';
  editor.style.lineHeight = '1.35';

  function autoFit() {
    editor.style.height = 'auto';
    editor.style.width  = 'auto';
    editor.style.height = (editor.scrollHeight) + 'px';
    editor.style.width  = (editor.scrollWidth + 30) + 'px';
  }

  editor.addEventListener('input', autoFit);

  let isCommitted = false;
  function commit() {
    if (isCommitted) return;
    isCommitted = true;
    _activeTextEditor = null;

    const val = editor.value;
    const page = wbPages[wbPageIndex];
    _ensurePageObjects(page);

    if (val.trim().length === 0) {
      page.textObjects = page.textObjects.filter(t => t.id !== item.id);
      if (selectedTextId === item.id) selectedTextId = null;
    } else {
      item.text = val;
      _pushWBUndo();
      _syncWBToRemote();
    }

    if (editor.parentNode) {
      editor.parentNode.removeChild(editor);
    }
    _renderObjectLayer();
  }

  _activeTextEditor = {
    itemId: item.id,
    commit: commit,
  };

  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      commit();
    }
  });

  editor.addEventListener('blur', commit);

  layer.appendChild(editor);
  autoFit();
  setTimeout(() => {
    editor.focus();
    if (!isNew && editor.setSelectionRange) {
      const len = editor.value.length;
      editor.setSelectionRange(len, len);
    }
  }, 20);

  _renderObjectLayer();
}

function _initObjectDrag(item, isNode, e) {
  _isDraggingObject = true;
  _hasDragged = false;
  _dragStartPos = { x: e.clientX, y: e.clientY };
  _objDragInitPos = { x: item.x, y: item.y };

  function onDragMove(moveEv) {
    if (!_isDraggingObject) return;
    const dxPx = Math.abs(moveEv.clientX - _dragStartPos.x);
    const dyPx = Math.abs(moveEv.clientY - _dragStartPos.y);
    if (dxPx > 4 || dyPx > 4) {
      _hasDragged = true;
    }

    const rect = wbCanvas.getBoundingClientRect();
    const scaleX = 1600 / rect.width;
    const scaleY = 1200 / rect.height;

    const dx = (moveEv.clientX - _dragStartPos.x) * scaleX;
    const dy = (moveEv.clientY - _dragStartPos.y) * scaleY;

    item.x = Math.max(10, Math.min(1500, Math.round(_objDragInitPos.x + dx)));
    item.y = Math.max(10, Math.min(1150, Math.round(_objDragInitPos.y + dy)));

    if (isNode) {
      _updateNodeDOM(item);
      _renderFlowchartConnectors();
    } else {
      const domEl = document.getElementById('wb-item-' + item.id);
      if (domEl) {
        domEl.style.left = (item.x / 1600 * 100) + '%';
        domEl.style.top  = (item.y / 1200 * 100) + '%';
      }
    }
  }

  function onDragEnd() {
    if (_isDraggingObject) {
      _isDraggingObject = false;
      if (_hasDragged) {
        _pushWBUndo();
        _syncWBToRemote();
      }
    }
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragEnd);
  }

  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragEnd);
}

function deleteTextObject(id) {
  const page = wbPages[wbPageIndex];
  if (!page || !page.textObjects) return;
  page.textObjects = page.textObjects.filter(t => t.id !== id);
  if (selectedTextId === id) selectedTextId = null;
  _renderObjectLayer();
  _pushWBUndo();
  _syncWBToRemote();
}

/* ═══════════════════════════════════════════════════════════════
   DRAWFLOW FLOWCHART ENGINE (Lazy Loaded)
   ═══════════════════════════════════════════════════════════════ */

let _drawflowEditor = null;
let _drawflowLoaded = false;
let _drawflowLoading = false;

/**
 * Lazy loads Drawflow CSS & JS from CDN only when Flowchart mode is opened
 */
function loadDrawflowLibrary() {
  if (_drawflowLoaded || typeof window.Drawflow !== 'undefined') {
    _drawflowLoaded = true;
    return Promise.resolve();
  }
  if (_drawflowLoading) {
    return new Promise(resolve => {
      const check = setInterval(() => {
        if (_drawflowLoaded) { clearInterval(check); resolve(); }
      }, 50);
    });
  }

  _drawflowLoading = true;

  // 1. Inject Drawflow CSS
  if (!document.getElementById('drawflow-css')) {
    const link = document.createElement('link');
    link.id = 'drawflow-css';
    link.rel = 'stylesheet';
    link.href = 'https://cdn.jsdelivr.net/gh/jerosoler/Drawflow/dist/drawflow.min.css';
    document.head.appendChild(link);
  }

  // 2. Inject Drawflow JS
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.id = 'drawflow-js';
    script.src = 'https://cdn.jsdelivr.net/gh/jerosoler/Drawflow/dist/drawflow.min.js';
    script.onload = () => {
      _drawflowLoaded = true;
      _drawflowLoading = false;
      console.info('[Whiteboard] Drawflow library loaded successfully.');
      resolve();
    };
    script.onerror = (err) => {
      _drawflowLoading = false;
      console.error('[Whiteboard] Failed to load Drawflow from CDN:', err);
      reject(err);
    };
    document.body.appendChild(script);
  });
}

/**
 * Initializes Drawflow instance on #drawflow element
 */
async function initDrawflowEditor() {
  const container = document.getElementById('drawflow');
  if (!container) return;

  await loadDrawflowLibrary();

  if (!_drawflowEditor && typeof window.Drawflow !== 'undefined') {
    _drawflowEditor = new window.Drawflow(container);
    _drawflowEditor.reroute = true;
    _drawflowEditor.curvature = 0.5;
    _drawflowEditor.reroute_curvature_start_end = 0.5;
    _drawflowEditor.reroute_curvature = 0.5;
    _drawflowEditor.start();

    // Attach Drawflow event listeners for automatic collaboration sync & undo
    _drawflowEditor.on('nodeCreated', () => _saveAndSyncDrawflow());
    _drawflowEditor.on('nodeRemoved', () => _saveAndSyncDrawflow());
    _drawflowEditor.on('nodeMoved',   () => _saveAndSyncDrawflowDebounced());
    _drawflowEditor.on('connectionCreated', () => _saveAndSyncDrawflow());
    _drawflowEditor.on('connectionRemoved', () => _saveAndSyncDrawflow());
  }

  // Load current page's flowchart data
  loadDrawflowForPage(wbPageIndex);
}

function _saveAndSyncDrawflow() {
  if (!_drawflowEditor) return;
  const page = wbPages[wbPageIndex];
  if (!page) return;
  try {
    page.drawflowData = _drawflowEditor.export();
    _pushWBUndo();
    _syncWBToRemote();
  } catch (_) {}
}

let _dfSyncTimer = null;
function _saveAndSyncDrawflowDebounced() {
  if (_dfSyncTimer) clearTimeout(_dfSyncTimer);
  _dfSyncTimer = setTimeout(() => {
    _saveAndSyncDrawflow();
  }, 150);
}

function loadDrawflowForPage(pageIndex) {
  if (!_drawflowEditor) return;
  const page = wbPages[pageIndex];
  try {
    _drawflowEditor.clearModuleSelected();
    if (page && page.drawflowData && page.drawflowData.drawflow) {
      _drawflowEditor.import(page.drawflowData);
    }
  } catch (err) {
    console.warn('[Whiteboard] Drawflow import warning:', err);
  }
}

/**
 * Add a node to Drawflow (Start/End, Process, Decision)
 */
function addDrawflowNode(type) {
  if (!_drawflowEditor) return;

  const rect = wbCanvas ? wbCanvas.getBoundingClientRect() : { width: 800, height: 600 };
  const centerX = Math.round(rect.width / 2) - 70;
  const centerY = Math.round(rect.height / 2) - 30;

  let newNodeId = null;

  if (type === 'start_end') {
    const html = `
      <div class="df-node-content df-node-start_end">
        <input type="text" class="df-node-input" placeholder="Start / End" df-label oninput="_onDrawflowNodeInput(this)" />
      </div>
    `;
    newNodeId = _drawflowEditor.addNode('start_end', 1, 1, centerX, centerY, 'df-node-start_end', { label: '' }, html);
  } else if (type === 'process') {
    const html = `
      <div class="df-node-content df-node-process">
        <input type="text" class="df-node-input" placeholder="Process" df-label oninput="_onDrawflowNodeInput(this)" />
      </div>
    `;
    newNodeId = _drawflowEditor.addNode('process', 1, 1, centerX, centerY, 'df-node-process', { label: '' }, html);
  } else if (type === 'decision') {
    const html = `
      <div class="df-node-content df-node-decision">
        <input type="text" class="df-node-input" placeholder="Decision" df-label oninput="_onDrawflowNodeInput(this)" />
      </div>
    `;
    newNodeId = _drawflowEditor.addNode('decision', 1, 2, centerX, centerY, 'df-node-decision', { label: '' }, html);
  }

  _saveAndSyncDrawflow();

  // Immediately focus and select the input field of the new node for quick typing
  if (newNodeId) {
    setTimeout(() => {
      const nodeEl = document.getElementById('node-' + newNodeId);
      if (nodeEl) {
        const input = nodeEl.querySelector('input.df-node-input');
        if (input) {
          input.focus();
          input.select();
        }
      }
    }, 40);
  }
}

let _drawflowMode = 'select'; // 'select' | 'arrow'
function setDrawflowMode(mode) {
  _drawflowMode = mode;
  const selectBtn = document.getElementById('df-btn-mode-select');
  const arrowBtn  = document.getElementById('df-btn-mode-arrow');
  const dfContainer = document.getElementById('drawflow');

  if (selectBtn) selectBtn.classList.toggle('active', mode === 'select');
  if (arrowBtn)  arrowBtn.classList.toggle('active', mode === 'arrow');

  if (dfContainer) {
    dfContainer.classList.toggle('df-mode-arrow', mode === 'arrow');
  }
}

function toggleDrawflowMoreMenu(e) {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  const menu = document.getElementById('df-more-menu');
  if (menu) menu.classList.toggle('hidden');
}

function hideDrawflowMoreMenu() {
  const menu = document.getElementById('df-more-menu');
  if (menu) menu.classList.add('hidden');
}

document.addEventListener('click', function(e) {
  const moreBtn = document.getElementById('df-btn-more');
  const menu = document.getElementById('df-more-menu');
  if (menu && !menu.classList.contains('hidden')) {
    if (moreBtn && !moreBtn.contains(e.target) && !menu.contains(e.target)) {
      menu.classList.add('hidden');
    }
  }
});

function _onDrawflowNodeInput(inputEl) {
  if (!_drawflowEditor) return;
  const nodeEl = inputEl.closest('.drawflow-node');
  if (!nodeEl) return;
  const idStr = nodeEl.id.replace('node-', '');
  const nodeId = parseInt(idStr, 10);
  if (_drawflowEditor.drawflow.drawflow.Home.data[nodeId]) {
    _drawflowEditor.drawflow.drawflow.Home.data[nodeId].data.label = inputEl.value;
    _saveAndSyncDrawflowDebounced();
  }
}

function deleteSelectedDrawflowNode() {
  if (!_drawflowEditor) return;
  if (_drawflowEditor.node_selected) {
    _drawflowEditor.removeNodeId(_drawflowEditor.node_selected.id);
  } else if (_drawflowEditor.connection_selected) {
    _drawflowEditor.removeConnection();
  }
}

function zoomDrawflow(scaleFactor) {
  if (!_drawflowEditor) return;
  if (scaleFactor > 1) {
    _drawflowEditor.zoom_in();
  } else {
    _drawflowEditor.zoom_out();
  }
}

function resetDrawflowZoom() {
  if (!_drawflowEditor) return;
  _drawflowEditor.zoom_reset();
}

function clearDrawflowCanvas() {
  if (!_drawflowEditor) return;
  _drawflowEditor.clearModuleSelected();
  _saveAndSyncDrawflow();
}

/* ═══════════════════════════════════════════════════════════════
   UNIFIED OBJECT LAYER RENDERER (Text + Flowchart + Connectors)
   ═══════════════════════════════════════════════════════════════ */

function _renderObjectLayer() {
  _renderTextLayer();
  _renderFlowchartNodes();
  _renderFlowchartConnectors();
}

function _renderTextLayer() {
  const layer = document.getElementById('wb-text-layer');
  if (!layer || !wbCanvas) return;
  
  // Clear only text objects from layer
  const textItems = layer.querySelectorAll('.wb-text-item');
  textItems.forEach(el => el.remove());

  const page = wbPages[wbPageIndex];
  if (!page || !page.textObjects) return;

  const rect = wbCanvas.getBoundingClientRect();
  const scale = rect.width > 0 ? (rect.width / 1600) : 1;

  page.textObjects.forEach(item => {
    if (_activeTextEditor && _activeTextEditor.itemId === item.id) return;

    const el = document.createElement('div');
    el.className = 'wb-text-item';
    el.id = 'wb-item-' + item.id;
    el.style.left = (item.x / 1600 * 100) + '%';
    el.style.top  = (item.y / 1200 * 100) + '%';
    el.style.color = item.color || '#212529';
    el.style.fontSize = Math.max(12, Math.round((item.fontSize || 32) * scale)) + 'px';
    el.textContent = item.text || '';

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!_hasDragged) {
        _openDirectTextEditor(item, false);
      }
    });

    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      selectedTextId = item.id;
      selectedNodeId = null;
      selectedConnectorId = null;
      _initObjectDrag(item, false, e);
    });

    layer.appendChild(el);
  });
}

function _renderFlowchartNodes() {
  const layer = document.getElementById('wb-text-layer');
  if (!layer || !wbCanvas) return;

  const oldNodes = layer.querySelectorAll('.wb-fc-node');
  oldNodes.forEach(el => el.remove());

  const page = wbPages[wbPageIndex];
  if (!page || !page.flowchartNodes) return;

  const rect = wbCanvas.getBoundingClientRect();
  const scale = rect.width > 0 ? (rect.width / 1600) : 1;

  page.flowchartNodes.forEach(node => {
    const el = document.createElement('div');
    el.className = `wb-fc-node wb-fc-node-${node.type}${selectedNodeId === node.id || _connectorSourceNodeId === node.id ? ' selected' : ''}`;
    el.id = 'wb-fc-node-' + node.id;
    el.style.left   = (node.x / 1600 * 100) + '%';
    el.style.top    = (node.y / 1200 * 100) + '%';
    el.style.width  = (node.width / 1600 * 100) + '%';
    el.style.height = (node.height / 1200 * 100) + '%';
    el.style.fontSize = Math.max(11, Math.round(18 * scale)) + 'px';

    const textEl = document.createElement('div');
    textEl.className = 'wb-fc-node-text';
    textEl.textContent = node.label || 'Node';
    el.appendChild(textEl);

    // Connector handles
    ['top', 'right', 'bottom', 'left'].forEach(dir => {
      const pt = document.createElement('div');
      pt.className = `wb-fc-connector-point wb-fc-point-${dir}`;
      pt.title = 'Connect node';
      pt.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        _handleNodeConnection(node.id);
      });
      el.appendChild(pt);
    });

    // Node interactions
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (wbTool === 'fc-connector') {
        _handleNodeConnection(node.id);
      } else if (!_hasDragged) {
        selectedNodeId = node.id;
        selectedTextId = null;
        selectedConnectorId = null;
        _renderObjectLayer();
      }
    });

    el.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      _openNodeTextEditor(node);
    });

    el.addEventListener('pointerdown', (e) => {
      if (wbTool === 'fc-connector') return;
      e.stopPropagation();
      selectedNodeId = node.id;
      selectedTextId = null;
      selectedConnectorId = null;
      _initObjectDrag(node, true, e);
    });

    layer.appendChild(el);
  });
}

function _renderFlowchartConnectors() {
  const svg = document.getElementById('wb-fc-svg-layer');
  if (!svg) return;
  svg.innerHTML = '';

  const page = wbPages[wbPageIndex];
  if (!page || !page.flowchartConnectors || !page.flowchartNodes) return;

  const nodeMap = {};
  page.flowchartNodes.forEach(n => { nodeMap[n.id] = n; });

  // Add marker defs for arrows
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  defs.innerHTML = `
    <marker id="wb-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 1 L 10 5 L 0 9 z" fill="#2563eb" />
    </marker>
    <marker id="wb-arrow-selected" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 1 L 10 5 L 0 9 z" fill="#dc2626" />
    </marker>
  `;
  svg.appendChild(defs);

  page.flowchartConnectors.forEach(conn => {
    const fromNode = nodeMap[conn.fromId];
    const toNode   = nodeMap[conn.toId];
    if (!fromNode || !toNode) return;

    const fromCenter = { x: fromNode.x + fromNode.width / 2, y: fromNode.y + fromNode.height / 2 };
    const toCenter   = { x: toNode.x + toNode.width / 2,     y: toNode.y + toNode.height / 2 };

    const isSelected = selectedConnectorId === conn.id;
    const color = isSelected ? '#dc2626' : (conn.color || '#2563eb');
    const marker = isSelected ? 'url(#wb-arrow-selected)' : 'url(#wb-arrow)';

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', (fromCenter.x / 1600 * 100) + '%');
    line.setAttribute('y1', (fromCenter.y / 1200 * 100) + '%');
    line.setAttribute('x2', (toCenter.x / 1600 * 100) + '%');
    line.setAttribute('y2', (toCenter.y / 1200 * 100) + '%');
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', '3');
    line.setAttribute('marker-end', marker);
    line.style.pointerEvents = 'stroke';
    line.style.cursor = 'pointer';

    line.addEventListener('click', (e) => {
      e.stopPropagation();
      selectedConnectorId = conn.id;
      selectedNodeId = null;
      selectedTextId = null;
      _renderFlowchartConnectors();
    });

    svg.appendChild(line);
  });
}

/* ═══════════════════════════════════════════════════════════════
   UNDO / REDO HISTORY
   ═══════════════════════════════════════════════════════════════ */

function _pushWBUndo() {
  if (!wbCanvas || !wbPages[wbPageIndex]) return;
  try {
    const page = wbPages[wbPageIndex];
    const stateObj = {
      canvasData: wbCanvas.toDataURL('image/png'),
      textObjects: JSON.parse(JSON.stringify(page.textObjects || [])),
      flowchartNodes: JSON.parse(JSON.stringify(page.flowchartNodes || [])),
      flowchartConnectors: JSON.parse(JSON.stringify(page.flowchartConnectors || [])),
    };
    page.undoStack.push(JSON.stringify(stateObj));
    if (page.undoStack.length > 30) page.undoStack.shift();
    page.redoStack = [];
  } catch (_) {}
}

function wbUndo() {
  _commitActiveTextEditor();
  _dismissSmartPredictionCard();
  _clearSmartStrokeState();
  const page = wbPages[wbPageIndex];
  if (!page || page.undoStack.length === 0) return;

  try {
    const currentState = {
      canvasData: wbCanvas.toDataURL('image/png'),
      textObjects: JSON.parse(JSON.stringify(page.textObjects || [])),
      flowchartNodes: JSON.parse(JSON.stringify(page.flowchartNodes || [])),
      flowchartConnectors: JSON.parse(JSON.stringify(page.flowchartConnectors || [])),
    };
    page.redoStack.push(JSON.stringify(currentState));

    const prevState = JSON.parse(page.undoStack.pop());
    page.textObjects         = prevState.textObjects || [];
    page.flowchartNodes      = prevState.flowchartNodes || [];
    page.flowchartConnectors = prevState.flowchartConnectors || [];

    const img = new Image();
    img.onload = function() {
      wbCtx.globalCompositeOperation = 'source-over';
      wbCtx.fillStyle = '#ffffff';
      wbCtx.fillRect(0, 0, 1600, 1200);
      wbCtx.drawImage(img, 0, 0, 1600, 1200);
      _saveCurrentPage();
      _renderObjectLayer();
      _syncWBToRemote();
    };
    img.src = prevState.canvasData;
  } catch (_) {}
}

function wbRedo() {
  _commitActiveTextEditor();
  _dismissSmartPredictionCard();
  _clearSmartStrokeState();
  const page = wbPages[wbPageIndex];
  if (!page || page.redoStack.length === 0) return;

  try {
    const currentState = {
      canvasData: wbCanvas.toDataURL('image/png'),
      textObjects: JSON.parse(JSON.stringify(page.textObjects || [])),
      flowchartNodes: JSON.parse(JSON.stringify(page.flowchartNodes || [])),
      flowchartConnectors: JSON.parse(JSON.stringify(page.flowchartConnectors || [])),
    };
    page.undoStack.push(JSON.stringify(currentState));

    const nextState = JSON.parse(page.redoStack.pop());
    page.textObjects         = nextState.textObjects || [];
    page.flowchartNodes      = nextState.flowchartNodes || [];
    page.flowchartConnectors = nextState.flowchartConnectors || [];

    const img = new Image();
    img.onload = function() {
      wbCtx.globalCompositeOperation = 'source-over';
      wbCtx.fillStyle = '#ffffff';
      wbCtx.fillRect(0, 0, 1600, 1200);
      wbCtx.drawImage(img, 0, 0, 1600, 1200);
      _saveCurrentPage();
      _renderObjectLayer();
      _syncWBToRemote();
    };
    img.src = nextState.canvasData;
  } catch (_) {}
}

/* ═══════════════════════════════════════════════════════════════
   MULTI-PAGE MANAGEMENT
   ═══════════════════════════════════════════════════════════════ */

function _saveCurrentPage() {
  if (!wbCanvas || !wbPages[wbPageIndex]) return;
  try {
    wbPages[wbPageIndex].dataUrl = wbCanvas.toDataURL('image/png');
  } catch (_) {}
}

function loadWBPage(index) {
  _commitActiveTextEditor();
  _dismissSmartPredictionCard();
  _clearSmartStrokeState();
  if (index < 0 || index >= wbPages.length) return;
  wbPageIndex = index;

  wbCtx.globalCompositeOperation = 'source-over';
  wbCtx.fillStyle = '#ffffff';
  wbCtx.fillRect(0, 0, 1600, 1200);

  const page = wbPages[wbPageIndex];
  if (page && page.dataUrl) {
    const img = new Image();
    img.onload = function() {
      wbCtx.drawImage(img, 0, 0, 1600, 1200);
    };
    img.src = page.dataUrl;
  }

  selectedTextId = null;
  selectedNodeId = null;
  selectedConnectorId = null;
  _renderObjectLayer();
  if (_drawflowEditor) {
    loadDrawflowForPage(wbPageIndex);
  }
  _updateWBPageUI();
}

function _updateWBPageUI() {
  const lbl = document.getElementById('wb-page-label');
  if (lbl) {
    lbl.textContent = `Page ${wbPageIndex + 1} of ${wbPages.length}`;
  }

  const prevBtn = document.getElementById('wb-btn-prev');
  const nextBtn = document.getElementById('wb-btn-next');
  if (prevBtn) prevBtn.disabled = (wbPageIndex === 0);
  if (nextBtn) nextBtn.disabled = (wbPageIndex === wbPages.length - 1);
}

/* ═══════════════════════════════════════════════════════════════
   TOOLBAR DISPATCH
   ═══════════════════════════════════════════════════════════════ */

function wbAction(action) {
  _commitActiveTextEditor();
  switch (action) {
    case 'clear':
      _pushWBUndo();
      wbCtx.globalCompositeOperation = 'source-over';
      wbCtx.fillStyle = '#ffffff';
      wbCtx.fillRect(0, 0, 1600, 1200);
      if (wbPages[wbPageIndex]) {
        wbPages[wbPageIndex].textObjects = [];
        wbPages[wbPageIndex].flowchartNodes = [];
        wbPages[wbPageIndex].flowchartConnectors = [];
      }
      _saveCurrentPage();
      _renderObjectLayer();
      _syncWBToRemote();
      break;

    case 'undo':
      wbUndo();
      break;

    case 'redo':
      wbRedo();
      break;

    case 'new':
      _saveCurrentPage();
      wbPages.push({ dataUrl: null, undoStack: [], redoStack: [], textObjects: [], flowchartNodes: [], flowchartConnectors: [] });
      loadWBPage(wbPages.length - 1);
      _syncWBToRemote();
      if (typeof showToast === 'function') {
        showToast('main-toast', `📄 Created Page ${wbPages.length}`, 'dark');
      }
      break;

    case 'prev':
      if (wbPageIndex > 0) {
        _saveCurrentPage();
        loadWBPage(wbPageIndex - 1);
      }
      break;

    case 'next':
      if (wbPageIndex < wbPages.length - 1) {
        _saveCurrentPage();
        loadWBPage(wbPageIndex + 1);
      } else {
        wbAction('new');
      }
      break;

    case 'delete_page':
      if (wbPages.length <= 1) {
        if (typeof showToast === 'function') showToast('main-toast', '⚠️ Cannot delete the only page.', 'dark');
        return;
      }
      if (confirm(`Delete Page ${wbPageIndex + 1}? This cannot be undone.`)) {
        wbPages.splice(wbPageIndex, 1);
        if (wbPageIndex >= wbPages.length) wbPageIndex = wbPages.length - 1;
        loadWBPage(wbPageIndex);
        _syncWBToRemote();
        if (typeof showToast === 'function') showToast('main-toast', '🗑️ Page deleted', 'dark');
      }
      break;

    case 'save':
      _saveCurrentPage();
      _downloadPageWithText(wbPageIndex);
      break;

    case 'zip':
      exportAllPagesAsZip();
      break;

    case 'exit':
      if (typeof setWSState === 'function') {
        setWSState('invite');
      }
      break;
  }
}

/**
 * Generates combined canvas image with handwriting, flowchart shapes & connectors, and text objects rasterized seamlessly
 */
function _renderCombinedPageCanvas(pageIndex) {
  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = 1600;
  exportCanvas.height = 1200;
  const expCtx = exportCanvas.getContext('2d');

  expCtx.fillStyle = '#ffffff';
  expCtx.fillRect(0, 0, 1600, 1200);

  const page = wbPages[pageIndex];
  if (page && page.dataUrl) {
    const img = new Image();
    img.src = page.dataUrl;
    try { expCtx.drawImage(img, 0, 0, 1600, 1200); } catch (_) {}
  } else if (pageIndex === wbPageIndex && wbCanvas) {
    try { expCtx.drawImage(wbCanvas, 0, 0, 1600, 1200); } catch (_) {}
  }

  // 1. Draw Flowchart connectors
  if (page && page.flowchartConnectors && page.flowchartNodes) {
    const nodeMap = {};
    page.flowchartNodes.forEach(n => { nodeMap[n.id] = n; });

    page.flowchartConnectors.forEach(conn => {
      const fromNode = nodeMap[conn.fromId];
      const toNode   = nodeMap[conn.toId];
      if (!fromNode || !toNode) return;

      const fromX = fromNode.x + fromNode.width / 2;
      const fromY = fromNode.y + fromNode.height / 2;
      const toX   = toNode.x + toNode.width / 2;
      const toY   = toNode.y + toNode.height / 2;

      expCtx.strokeStyle = conn.color || '#2563eb';
      expCtx.lineWidth = 3;
      expCtx.beginPath();
      expCtx.moveTo(fromX, fromY);
      expCtx.lineTo(toX, toY);
      expCtx.stroke();

      // Draw arrowhead
      const angle = Math.atan2(toY - fromY, toX - fromX);
      expCtx.fillStyle = conn.color || '#2563eb';
      expCtx.beginPath();
      expCtx.moveTo(toX, toY);
      expCtx.lineTo(toX - 15 * Math.cos(angle - Math.PI / 6), toY - 15 * Math.sin(angle - Math.PI / 6));
      expCtx.lineTo(toX - 15 * Math.cos(angle + Math.PI / 6), toY - 15 * Math.sin(angle + Math.PI / 6));
      expCtx.closePath();
      expCtx.fill();
    });
  }

  // 2. Draw Flowchart nodes
  if (page && page.flowchartNodes && page.flowchartNodes.length > 0) {
    page.flowchartNodes.forEach(node => {
      expCtx.save();
      if (node.type === 'start_end') {
        expCtx.fillStyle = '#f0fdf4';
        expCtx.strokeStyle = '#16a34a';
        expCtx.lineWidth = 3;
        expCtx.beginPath();
        const r = node.height / 2;
        expCtx.arc(node.x + r, node.y + r, r, Math.PI / 2, Math.PI * 1.5);
        expCtx.arc(node.x + node.width - r, node.y + r, r, Math.PI * 1.5, Math.PI / 2);
        expCtx.closePath();
        expCtx.fill();
        expCtx.stroke();
      } else if (node.type === 'process') {
        expCtx.fillStyle = '#eff6ff';
        expCtx.strokeStyle = '#2563eb';
        expCtx.lineWidth = 3;
        expCtx.beginPath();
        expCtx.roundRect ? expCtx.roundRect(node.x, node.y, node.width, node.height, 8) : expCtx.rect(node.x, node.y, node.width, node.height);
        expCtx.fill();
        expCtx.stroke();
      } else if (node.type === 'decision') {
        expCtx.fillStyle = '#fffbeb';
        expCtx.strokeStyle = '#d97706';
        expCtx.lineWidth = 3;
        expCtx.beginPath();
        expCtx.moveTo(node.x + node.width / 2, node.y);
        expCtx.lineTo(node.x + node.width, node.y + node.height / 2);
        expCtx.lineTo(node.x + node.width / 2, node.y + node.height);
        expCtx.lineTo(node.x, node.y + node.height / 2);
        expCtx.closePath();
        expCtx.fill();
        expCtx.stroke();
      }

      // Draw node text
      expCtx.fillStyle = '#0f172a';
      expCtx.font = '600 18px "Inter", -apple-system, BlinkMacSystemFont, sans-serif';
      expCtx.textAlign = 'center';
      expCtx.textBaseline = 'middle';
      expCtx.fillText(node.label || '', node.x + node.width / 2, node.y + node.height / 2);
      expCtx.restore();
    });
  }

  // 3. Draw typed text objects directly onto exported canvas
  if (page && page.textObjects && page.textObjects.length > 0) {
    page.textObjects.forEach(item => {
      if (!item.text) return;
      expCtx.fillStyle = item.color || '#212529';
      expCtx.font = `500 ${item.fontSize || 32}px 'Inter', -apple-system, BlinkMacSystemFont, sans-serif`;
      expCtx.textBaseline = 'top';

      const lines = item.text.split('\n');
      const lineHeight = (item.fontSize || 32) * 1.35;
      lines.forEach((line, idx) => {
        expCtx.fillText(line, item.x, item.y + (idx * lineHeight));
      });
    });
  }

  return exportCanvas;
}

function _downloadPageWithText(pageIndex) {
  const canvas = _renderCombinedPageCanvas(pageIndex);
  const a = document.createElement('a');
  a.download = `CoLearn_Whiteboard_Page_${pageIndex + 1}.png`;
  a.href     = canvas.toDataURL('image/png');
  a.click();
}

/* ═══════════════════════════════════════════════════════════════
   EXPORT ALL PAGES AS ZIP
   ═══════════════════════════════════════════════════════════════ */

async function exportAllPagesAsZip() {
  _commitActiveTextEditor();
  _saveCurrentPage();
  if (typeof showToast === 'function') {
    showToast('main-toast', '📦 Preparing whiteboard pages ZIP…', 'dark');
  }

  const pageCount = wbPages.length;
  const pageBlobs = [];

  for (let i = 0; i < pageCount; i++) {
    const canvas = _renderCombinedPageCanvas(i);
    const dataUrl = canvas.toDataURL('image/png');
    const byteCharacters = atob(dataUrl.split(',')[1]);
    const byteNumbers = new Array(byteCharacters.length);
    for (let j = 0; j < byteCharacters.length; j++) {
      byteNumbers[j] = byteCharacters.charCodeAt(j);
    }
    const byteArray = new Uint8Array(byteNumbers);
    pageBlobs.push({
      name: `CoLearn_Whiteboard_Page_${i + 1}.png`,
      data: byteArray,
    });
  }

  // 1. Try JSZip if available
  if (typeof window.JSZip !== 'undefined') {
    try {
      const zip = new window.JSZip();
      pageBlobs.forEach(item => {
        zip.file(item.name, item.data);
      });
      const content = await zip.generateAsync({ type: 'blob' });
      _triggerDownload(content, 'CoLearn_Whiteboard_Pages.zip');
      if (typeof showToast === 'function') {
        showToast('main-toast', `✅ Downloaded ${pageCount} whiteboard page(s) as ZIP!`, 'green');
      }
      return;
    } catch (e) {
      console.warn('[Whiteboard] JSZip generation error, falling back to internal ZIP writer:', e.message);
    }
  }

  // 2. Pure-JS ZIP writer fallback
  try {
    const zipBlob = _createSimpleZipBlob(pageBlobs);
    _triggerDownload(zipBlob, 'CoLearn_Whiteboard_Pages.zip');
    if (typeof showToast === 'function') {
      showToast('main-toast', `✅ Downloaded ${pageCount} whiteboard page(s) as ZIP!`, 'green');
    }
  } catch (err) {
    console.error('[Whiteboard] ZIP export failed:', err);
    wbAction('save');
  }
}

function _triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 1000);
}

function _createSimpleZipBlob(files) {
  const parts = [];
  const centralDirEntries = [];
  let offset = 0;

  for (let f = 0; f < files.length; f++) {
    const file = files[f];
    const nameBytes = new TextEncoder().encode(file.name);
    const dataBytes = file.data;
    const crc = _crc32(dataBytes);
    const dataLength = dataBytes.length;

    // Local file header (30 bytes + name)
    const header = new Uint8Array(30 + nameBytes.length);
    const hView = new DataView(header.buffer);
    hView.setUint32(0, 0x04034b50, true);
    hView.setUint16(4, 10, true);
    hView.setUint16(6, 0, true);
    hView.setUint16(8, 0, true);
    hView.setUint16(10, 0, true);
    hView.setUint16(12, 0, true);
    hView.setUint32(14, crc, true);
    hView.setUint32(18, dataLength, true);
    hView.setUint32(22, dataLength, true);
    hView.setUint16(26, nameBytes.length, true);
    hView.setUint16(28, 0, true);
    header.set(nameBytes, 30);

    parts.push(header);
    parts.push(dataBytes);

    // Central directory header entry
    const cdEntry = new Uint8Array(46 + nameBytes.length);
    const cdView = new DataView(cdEntry.buffer);
    cdView.setUint32(0, 0x02014b50, true);
    cdView.setUint16(4, 20, true);
    cdView.setUint16(6, 10, true);
    cdView.setUint16(8, 0, true);
    cdView.setUint16(10, 0, true);
    cdView.setUint16(12, 0, true);
    cdView.setUint32(14, crc, true);
    cdView.setUint32(16, dataLength, true);
    cdView.setUint32(20, dataLength, true);
    cdView.setUint16(24, nameBytes.length, true);
    cdView.setUint16(28, 0, true);
    cdView.setUint16(30, 0, true);
    cdView.setUint32(38, offset, true);
    cdEntry.set(nameBytes, 46);

    centralDirEntries.push(cdEntry);
    offset += header.length + dataLength;
  }

  let centralDirSize = 0;
  centralDirEntries.forEach(entry => {
    parts.push(entry);
    centralDirSize += entry.length;
  });

  const eocd = new Uint8Array(22);
  const eView = new DataView(eocd.buffer);
  eView.setUint32(0, 0x06054b50, true);
  eView.setUint16(4, 0, true);
  eView.setUint16(6, 0, true);
  eView.setUint16(8, files.length, true);
  eView.setUint16(10, files.length, true);
  eView.setUint32(12, centralDirSize, true);
  eView.setUint32(16, offset, true);
  eView.setUint16(20, 0, true);
  parts.push(eocd);

  return new Blob(parts, { type: 'application/zip' });
}

function _crc32(buf) {
  let crc = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ _crcTable[(crc ^ buf[i]) & 0xFF];
  }
  return (crc ^ (-1)) >>> 0;
}

const _crcTable = (function() {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) {
      c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/* ═══════════════════════════════════════════════════════════════
   REAL-TIME COLLABORATION SYNC (Firebase RTDB)
   ═══════════════════════════════════════════════════════════════ */

function initWBSync(suiteId) {
  if (!suiteId || !window.fsRtdb) return;
  _wbSuiteId = suiteId;

  if (_wbRtdbListener && _wbRtdbRef) {
    try { _wbRtdbRef.off('value', _wbRtdbListener); } catch (_) {}
  }

  _wbRtdbRef = window.fsRtdb.ref(`suites/${suiteId}/whiteboard`);
  _wbRtdbListener = _wbRtdbRef.on('value', (snap) => {
    if (_isRemoteApplying) return;
    const data = snap.val();
    if (!data) return;

    // Check sender
    const myUid = window.AppState && window.AppState.currentUser ? window.AppState.currentUser.uid : null;
    if (data.senderUid && data.senderUid === myUid) return;

    if (data.pages && Array.isArray(data.pages)) {
      _isRemoteApplying = true;
      try {
        wbPages = data.pages.map((p, idx) => ({
          dataUrl: p.dataUrl || null,
          drawflowData: p.drawflowData || null,
          textObjects: p.textObjects || [],
          flowchartNodes: p.flowchartNodes || [],
          flowchartConnectors: p.flowchartConnectors || [],
          undoStack: (wbPages[idx] ? wbPages[idx].undoStack : []),
          redoStack: (wbPages[idx] ? wbPages[idx].redoStack : []),
        }));

        if (typeof data.activePageIndex === 'number' && data.activePageIndex >= 0 && data.activePageIndex < wbPages.length) {
          wbPageIndex = data.activePageIndex;
        }
        loadWBPage(wbPageIndex);
        if (_drawflowEditor) {
          loadDrawflowForPage(wbPageIndex);
        }
      } finally {
        setTimeout(() => { _isRemoteApplying = false; }, 80);
      }
    }
  });
}

function _syncWBToRemote() {
  if (!_wbSuiteId || !window.fsRtdb || _isRemoteApplying) return;

  if (_wbSyncDebounceTimer) {
    clearTimeout(_wbSyncDebounceTimer);
  }

  _wbSyncDebounceTimer = setTimeout(() => {
    try {
      const myUid = window.AppState && window.AppState.currentUser ? window.AppState.currentUser.uid : 'anon';
      const pagesPayload = wbPages.map(p => ({
        dataUrl: p.dataUrl || null,
        drawflowData: p.drawflowData || null,
        textObjects: p.textObjects || [],
        flowchartNodes: p.flowchartNodes || [],
        flowchartConnectors: p.flowchartConnectors || [],
      }));

      window.fsRtdb.ref(`suites/${_wbSuiteId}/whiteboard`).set({
        pages: pagesPayload,
        activePageIndex: wbPageIndex,
        senderUid: myUid,
        updatedAt: Date.now(),
      }).catch(() => {});
    } catch (_) {}
  }, 120);
}

/* ═══════════════════════════════════════════════════════════════
   KEYBOARD SHORTCUTS
   ═══════════════════════════════════════════════════════════════ */

let _wbShortcutsSetup = false;
function _setupWBShortcuts() {
  if (_wbShortcutsSetup) return;
  _wbShortcutsSetup = true;

  window.addEventListener('keydown', function(e) {
    // Check if whiteboard is currently active / visible in DOM or state
    const wbStateEl = document.getElementById('ws-state-whiteboard');
    const isWbActive = (window.AppState && window.AppState.wsCurrentState === 'whiteboard') ||
                       (wbStateEl && wbStateEl.style.display !== 'none');
    if (!isWbActive) return;

    // Do not intercept if user is typing in a text field / textarea
    const activeEl = document.activeElement;
    if (activeEl && (
      activeEl.tagName === 'INPUT' ||
      activeEl.tagName === 'TEXTAREA' ||
      activeEl.isContentEditable ||
      activeEl.classList.contains('wb-text-editor')
    )) {
      return;
    }
    if (e.target && (
      e.target.tagName === 'INPUT' ||
      e.target.tagName === 'TEXTAREA' ||
      e.target.isContentEditable ||
      (e.target.classList && e.target.classList.contains('wb-text-editor'))
    )) {
      return;
    }

    const isCtrlOrMeta = e.ctrlKey || e.metaKey;
    const key = (e.key || '').toLowerCase();
    const code = (e.code || '').toLowerCase();

    // Ctrl+Z or Cmd+Z -> Undo (or Redo if Shift is held)
    if (isCtrlOrMeta && (key === 'z' || code === 'keyz')) {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) {
        wbRedo();
      } else {
        wbUndo();
      }
      return;
    }

    // Ctrl+Y or Cmd+Y -> Redo
    if (isCtrlOrMeta && (key === 'y' || code === 'keyy')) {
      e.preventDefault();
      e.stopPropagation();
      wbRedo();
      return;
    }

    // Delete or Backspace for selected text object or selected Drawflow node/connection
    if (key === 'delete' || key === 'backspace' || code === 'delete' || code === 'backspace') {
      if (selectedTextId) {
        e.preventDefault();
        e.stopPropagation();
        deleteTextObject(selectedTextId);
      } else if (_drawflowEditor && (_drawflowEditor.node_selected || _drawflowEditor.connection_selected)) {
        e.preventDefault();
        e.stopPropagation();
        deleteSelectedDrawflowNode();
      }
      return;
    }

    // Escape -> dismiss Drawflow more menu, cancel connection/edit, deselect
    if (key === 'escape' || code === 'escape') {
      hideDrawflowMoreMenu();
      if (_drawflowEditor) {
        if (_drawflowEditor.node_selected) {
          try { _drawflowEditor.node_selected.classList.remove('selected'); } catch (_) {}
          _drawflowEditor.node_selected = null;
        }
        if (_drawflowEditor.connection_selected) {
          try { _drawflowEditor.connection_selected.classList.remove('selected'); } catch (_) {}
          _drawflowEditor.connection_selected = null;
        }
      }
      if (document.activeElement && typeof document.activeElement.blur === 'function') {
        document.activeElement.blur();
      }
      return;
    }
  }, true);
}

// Auto-register shortcuts immediately on script execution
if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _setupWBShortcuts);
  } else {
    _setupWBShortcuts();
  }
}

/* ═══════════════════════════════════════════════════════════════
   AUTO-HIDE CONTROLS
   ═══════════════════════════════════════════════════════════════ */

let _wbAutoHideTimer = null;
let _wbAutoHideActive = false;

function _wbShowCircularControls() {
  if (!_wbAutoHideActive) return;
  const tb = document.querySelector('.bottom-toolbar');
  if (tb) {
    tb.classList.remove('wb-auto-hidden');
    tb.classList.add('wb-auto-visible');
  }
  if (_wbAutoHideTimer) {
    clearTimeout(_wbAutoHideTimer);
    _wbAutoHideTimer = null;
  }
  _wbAutoHideTimer = setTimeout(() => {
    _wbHideCircularControls();
  }, 3000);
}

function _wbHideCircularControls() {
  if (_wbAutoHideTimer) {
    clearTimeout(_wbAutoHideTimer);
    _wbAutoHideTimer = null;
  }
  const tb = document.querySelector('.bottom-toolbar');
  if (tb) {
    tb.classList.remove('wb-auto-visible');
    tb.classList.add('wb-auto-hidden');
  }
}

function _wbOnPointerActivity(e) {
  if (!_wbAutoHideActive) return;
  const clientY = (e.touches && e.touches[0]) ? e.touches[0].clientY : e.clientY;
  if (typeof clientY === 'number') {
    if (clientY >= window.innerHeight - 70) {
      _wbShowCircularControls();
    }
  }
}

function _wbOnToolbarActivity() {
  if (!_wbAutoHideActive) return;
  _wbShowCircularControls();
}

function initWhiteboardAutoHide() {
  cleanupWhiteboardAutoHide();
  _wbAutoHideActive = true;
  _wbHideCircularControls();

  window.addEventListener('mousemove', _wbOnPointerActivity, { passive: true });
  window.addEventListener('pointermove', _wbOnPointerActivity, { passive: true });
  window.addEventListener('touchstart', _wbOnPointerActivity, { passive: true });
  window.addEventListener('touchmove', _wbOnPointerActivity, { passive: true });

  const tb = document.querySelector('.bottom-toolbar');
  if (tb) {
    tb.addEventListener('mouseenter', _wbOnToolbarActivity);
    tb.addEventListener('mousemove', _wbOnToolbarActivity);
    tb.addEventListener('touchstart', _wbOnToolbarActivity, { passive: true });
    tb.addEventListener('touchmove', _wbOnToolbarActivity, { passive: true });
  }
}

function cleanupWhiteboardAutoHide() {
  _wbAutoHideActive = false;
  if (_wbAutoHideTimer) {
    clearTimeout(_wbAutoHideTimer);
    _wbAutoHideTimer = null;
  }

  window.removeEventListener('mousemove', _wbOnPointerActivity);
  window.removeEventListener('pointermove', _wbOnPointerActivity);
  window.removeEventListener('touchstart', _wbOnPointerActivity);
  window.removeEventListener('touchmove', _wbOnPointerActivity);

  const tb = document.querySelector('.bottom-toolbar');
  if (tb) {
    tb.removeEventListener('mouseenter', _wbOnToolbarActivity);
    tb.removeEventListener('mousemove', _wbOnToolbarActivity);
    tb.removeEventListener('touchstart', _wbOnToolbarActivity);
    tb.removeEventListener('touchmove', _wbOnToolbarActivity);
    tb.classList.remove('wb-auto-hidden', 'wb-auto-visible');
  }
}

window.addEventListener('resize', () => {
  if (window.AppState && window.AppState.wsCurrentState === 'whiteboard') {
    resizeWhiteboard();
  }
});

/* ═══════════════════════════════════════════════════════════════
   SMART RECOGNITION (Handwriting & Math Expression Recognition)
   ═══════════════════════════════════════════════════════════════ */

function toggleWBSmartRecognition() {
  wbSmartRecognitionActive = !wbSmartRecognitionActive;
  const btn = document.getElementById('wb-btn-smart');
  if (btn) {
    btn.classList.toggle('active', wbSmartRecognitionActive);
  }

  if (wbSmartRecognitionActive) {
    if (wbTool !== 'pen') setWBTool('pen');
    if (typeof showToast === 'function') {
      showToast('main-toast', '✨ Smart Write ON — write text or formulas', 'dark');
    }
  } else {
    _dismissSmartPredictionCard();
    _clearSmartStrokeState();
    if (typeof showToast === 'function') {
      showToast('main-toast', 'Smart Write OFF', 'dark');
    }
  }
}

function _clearSmartStrokeState() {
  _smartCurrentStrokes = [];
  _smartCurrentStroke = null;
  _smartStrokeBounds = null;
  _smartPreStrokeSnapshot = null;
  _smartCurrentCandidates = [];
  _smartSelectedCandidate = '';
  if (_smartDebounceTimer) {
    clearTimeout(_smartDebounceTimer);
    _smartDebounceTimer = null;
  }
}

function _dismissSmartPredictionCard() {
  if (_smartPredictionCard && _smartPredictionCard.parentNode) {
    _smartPredictionCard.parentNode.removeChild(_smartPredictionCard);
  }
  _smartPredictionCard = null;
}

function _formatSmartRecognitionCandidate(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let str = raw.trim();

  // Mathematical square roots: sqrt(x) -> √(x), sqrt -> √
  str = str.replace(/\bsqrt\(([^)]+)\)/gi, '√($1)');
  str = str.replace(/\bsqrt\b/gi, '√');

  // Superscripts map
  const supers = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', 'n': 'ⁿ' };

  // Explicit exponent: x^2 -> x², a^2 -> a²
  str = str.replace(/([a-zA-Z])\^([0-9n+-]+)/g, (m, v, exp) => {
    return v + exp.split('').map(c => supers[c] || c).join('');
  });

  // Implicit exponent in algebra: e.g. x2 + 2x + 1 -> x² + 2x + 1, a2+b2=c2 -> a²+b²=c²
  str = str.replace(/([a-zA-Z])([23456789])(?=[+\-=/ *)]|$|\s)/g, (m, v, digit) => {
    return v + (supers[digit] || digit);
  });

  return str;
}

async function _triggerSmartRecognition() {
  if (!wbSmartRecognitionActive || _smartCurrentStrokes.length === 0 || !_smartStrokeBounds) return;

  let totalPts = 0;
  _smartCurrentStrokes.forEach(s => { if (s && s.x) totalPts += s.x.length; });
  if (totalPts < 3) {
    _clearSmartStrokeState();
    return;
  }

  const ink = _smartCurrentStrokes.map(s => [s.x, s.y, s.t]);
  const width = Math.max(120, Math.round(_smartStrokeBounds.maxX - _smartStrokeBounds.minX + 40));
  const height = Math.max(120, Math.round(_smartStrokeBounds.maxY - _smartStrokeBounds.minY + 40));

  _showSmartLoadingCard(_smartStrokeBounds);

  try {
    const rawCandidates = await API.recognizeHandwritingStrokes(ink, width, height, 'en');
    if (rawCandidates && rawCandidates.length > 0) {
      const candidates = [];
      const seen = new Set();
      rawCandidates.forEach(cand => {
        const fmt = _formatSmartRecognitionCandidate(cand);
        if (fmt && !seen.has(fmt)) {
          seen.add(fmt);
          candidates.push(fmt);
        }
        if (cand && !seen.has(cand)) {
          seen.add(cand);
          candidates.push(cand);
        }
      });

      _smartCurrentCandidates = candidates.slice(0, 5);
      _smartSelectedCandidate = _smartCurrentCandidates[0];
      _showSmartPredictionCard(_smartStrokeBounds, _smartCurrentCandidates, _smartSelectedCandidate);
    } else {
      _showSmartErrorCard(_smartStrokeBounds, 'Could not recognize');
    }
  } catch (err) {
    console.error('[Smart Recognition] Recognition error:', err);
    _showSmartErrorCard(_smartStrokeBounds, 'Recognition error');
  }
}

function _showSmartLoadingCard(bounds) {
  _dismissSmartPredictionCard();
  const wrapper = document.getElementById('whiteboard-canvas-wrapper');
  if (!wrapper || !bounds) return;

  const card = document.createElement('div');
  card.className = 'wb-smart-preview';
  card.id = 'wb-smart-preview-card';

  let posX = Math.max(2, Math.min(75, (bounds.minX / 1600 * 100)));
  let posY = ((bounds.maxY + 15) / 1200 * 100);
  if (bounds.maxY > 950) {
    posY = (Math.max(10, bounds.minY - 70) / 1200 * 100);
  }

  card.style.left = posX + '%';
  card.style.top  = posY + '%';

  card.innerHTML = `
    <div class="wb-smart-loading">
      <span style="display:inline-block;animation:spin 1s linear infinite;">⏳</span>
      <span>Recognizing handwriting…</span>
    </div>
  `;

  wrapper.appendChild(card);
  _smartPredictionCard = card;
}

function _showSmartErrorCard(bounds, message) {
  _dismissSmartPredictionCard();
  const wrapper = document.getElementById('whiteboard-canvas-wrapper');
  if (!wrapper || !bounds) return;

  const card = document.createElement('div');
  card.className = 'wb-smart-preview';
  card.id = 'wb-smart-preview-card';

  let posX = Math.max(2, Math.min(75, (bounds.minX / 1600 * 100)));
  let posY = ((bounds.maxY + 15) / 1200 * 100);
  if (bounds.maxY > 950) {
    posY = (Math.max(10, bounds.minY - 70) / 1200 * 100);
  }

  card.style.left = posX + '%';
  card.style.top  = posY + '%';

  card.innerHTML = `
    <div class="wb-smart-header">
      <span>✨ Smart Write</span>
      <span style="cursor:pointer;font-size:0.85rem;" onclick="rejectWBSmartPrediction(event)" title="Dismiss">✕</span>
    </div>
    <div class="wb-smart-error">${_escapeHtml(message || 'Could not recognize')}</div>
    <div class="wb-smart-actions">
      <button class="wb-smart-btn wb-smart-reject" onclick="rejectWBSmartPrediction(event)">Dismiss</button>
    </div>
  `;

  card.addEventListener('pointerdown', (e) => e.stopPropagation());
  card.addEventListener('click', (e) => e.stopPropagation());

  wrapper.appendChild(card);
  _smartPredictionCard = card;

  setTimeout(() => {
    if (_smartPredictionCard === card) {
      _dismissSmartPredictionCard();
      _clearSmartStrokeState();
    }
  }, 3000);
}

function _showSmartPredictionCard(bounds, candidates, selected) {
  _dismissSmartPredictionCard();
  const wrapper = document.getElementById('whiteboard-canvas-wrapper');
  if (!wrapper || !bounds) return;

  const card = document.createElement('div');
  card.className = 'wb-smart-preview';
  card.id = 'wb-smart-preview-card';

  let posX = Math.max(2, Math.min(75, (bounds.minX / 1600 * 100)));
  let posY = ((bounds.maxY + 15) / 1200 * 100);
  if (bounds.maxY > 900) {
    posY = (Math.max(10, bounds.minY - 110) / 1200 * 100);
  }

  card.style.left = posX + '%';
  card.style.top  = posY + '%';

  let chipsHtml = '';
  if (candidates.length > 1) {
    chipsHtml = `<div class="wb-smart-candidates">` +
      candidates.map((c) => `
        <button class="wb-smart-chip${c === selected ? ' active' : ''}" onclick="selectWBSmartCandidate('${_escapeHtmlAttr(c)}', event)">${_escapeHtml(c)}</button>
      `).join('') +
    `</div>`;
  }

  card.innerHTML = `
    <div class="wb-smart-header">
      <span>✨ Prediction</span>
      <span style="cursor:pointer;font-size:0.85rem;" onclick="rejectWBSmartPrediction(event)" title="Dismiss">✕</span>
    </div>
    <div class="wb-smart-value" id="wb-smart-selected-val">${_escapeHtml(selected)}</div>
    ${chipsHtml}
    <div class="wb-smart-actions">
      <button class="wb-smart-btn wb-smart-accept" onclick="acceptWBSmartPrediction(event)" title="Convert handwriting to text/math">✓ Accept</button>
      <button class="wb-smart-btn wb-smart-reject" onclick="rejectWBSmartPrediction(event)" title="Keep original handwriting">Keep Handwriting</button>
    </div>
  `;

  card.addEventListener('pointerdown', (e) => e.stopPropagation());
  card.addEventListener('click', (e) => e.stopPropagation());

  wrapper.appendChild(card);
  _smartPredictionCard = card;
}

function selectWBSmartCandidate(val, e) {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  _smartSelectedCandidate = val;
  const valEl = document.getElementById('wb-smart-selected-val');
  if (valEl) valEl.textContent = val;

  const card = document.getElementById('wb-smart-preview-card');
  if (card) {
    const chips = card.querySelectorAll('.wb-smart-chip');
    chips.forEach(chip => {
      chip.classList.toggle('active', chip.textContent.trim() === val.trim());
    });
  }
}

function acceptWBSmartPrediction(e) {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  if (!_smartSelectedCandidate || !_smartStrokeBounds) {
    _dismissSmartPredictionCard();
    _clearSmartStrokeState();
    return;
  }

  const textToInsert = _smartSelectedCandidate;
  const bounds = { ..._smartStrokeBounds };
  const snapshot = _smartPreStrokeSnapshot;

  function doInsert() {
    const page = wbPages[wbPageIndex];
    _ensurePageObjects(page);

    const boxHeight = bounds.maxY - bounds.minY;
    const computedFontSize = Math.max(20, Math.min(64, Math.round(boxHeight * 0.85)));

    const newTextObj = {
      id: 'txt_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      x: Math.round(bounds.minX),
      y: Math.round(bounds.minY),
      text: textToInsert,
      fontSize: computedFontSize || wbFontSize || 32,
      color: wbColor || '#212529',
    };

    page.textObjects.push(newTextObj);
    _pushWBUndo();
    _saveCurrentPage();
    _syncWBToRemote();
    _renderObjectLayer();
    _dismissSmartPredictionCard();
    _clearSmartStrokeState();
  }

  if (snapshot) {
    const img = new Image();
    img.onload = function() {
      wbCtx.globalCompositeOperation = 'source-over';
      wbCtx.fillStyle = '#ffffff';
      wbCtx.fillRect(0, 0, 1600, 1200);
      wbCtx.drawImage(img, 0, 0, 1600, 1200);
      doInsert();
    };
    img.src = snapshot;
  } else {
    doInsert();
  }
}

function rejectWBSmartPrediction(e) {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  _dismissSmartPredictionCard();
  _clearSmartStrokeState();
}

function _escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function _escapeHtmlAttr(str) {
  if (!str) return '';
  return String(str).replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

// Window attachments
window.initWhiteboard            = initWhiteboard;
window.resizeWhiteboard          = resizeWhiteboard;
window.setWBTool                 = setWBTool;
window.updateWBColor             = updateWBColor;
window.updateWBSize              = updateWBSize;
window.wbAction                  = wbAction;
window.wbUndo                    = wbUndo;
window.wbRedo                    = wbRedo;
window.exportAllPagesAsZip       = exportAllPagesAsZip;
window.initWhiteboardAutoHide    = initWhiteboardAutoHide;
window.cleanupWhiteboardAutoHide = cleanupWhiteboardAutoHide;
window.deleteTextObject          = deleteTextObject;
window.initWBSync                = initWBSync;
window.addDrawflowNode           = addDrawflowNode;
window.deleteSelectedDrawflowNode = deleteSelectedDrawflowNode;
window.zoomDrawflow              = zoomDrawflow;
window.resetDrawflowZoom         = resetDrawflowZoom;
window.clearDrawflowCanvas       = clearDrawflowCanvas;
window._onDrawflowNodeInput      = _onDrawflowNodeInput;
window.setDrawflowMode           = setDrawflowMode;
window.toggleDrawflowMoreMenu    = toggleDrawflowMoreMenu;
window.hideDrawflowMoreMenu      = hideDrawflowMoreMenu;
window.toggleWBSmartRecognition  = toggleWBSmartRecognition;
window.acceptWBSmartPrediction   = acceptWBSmartPrediction;
window.rejectWBSmartPrediction   = rejectWBSmartPrediction;
window.selectWBSmartCandidate    = selectWBSmartCandidate;

