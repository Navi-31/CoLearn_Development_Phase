/* ── Centralized Environment & App Configuration ─────────────── */
/**
 * Centralized configuration system for CoLearn.
 *
 * Automatically detects the runtime environment:
 *  • LOCAL / DEVELOPMENT:
 *      Detected when accessed via localhost, 127.0.0.1, [::1], or private LAN IPs.
 *      API calls and WebSocket signaling route to the local Express server.
 *  • PRODUCTION (Cloudflare Pages / custom domain):
 *      Detected on public hostnames.
 *      API calls route to the configured deployed backend URL.
 *      WebSocket signaling routes to the configured secure WebSocket endpoint.
 *      NEVER falls back to localhost or silently redirects production traffic.
 *
 * Configuration sources (in priority order):
 *  1. window.__COLEARN_CONFIG__  (explicit configuration object)
 *  2. window.__ENV__             (environment configuration object)
 *  3. window.__CoLearn_API_BASE__(legacy override)
 *  4. HTML meta tags:
 *       <meta name="colearn-backend-url" content="...">
 *       <meta name="colearn-ws-url" content="...">
 *  5. In development: auto-derives from page origin or http://${hostname}:3000
 */

(function () {
  'use strict';

  /* ── 1. Hostname & Environment Detection ───────────────────── */
  const hostname = (window.location.hostname || '').toLowerCase().trim();
  const currentOrigin = (window.location.origin || '').replace(/\/$/, '');

  // Check if running in a local / loopback / LAN development environment
  const isLocalDev = Boolean(
    !hostname ||
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname.endsWith('.localhost') ||
    /^192\.168\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
    window.location.protocol === 'file:'
  );

  const ENV = isLocalDev ? 'development' : 'production';
  const IS_PRODUCTION = !isLocalDev;

  /* ── 2. Helper to read meta tags ───────────────────────────── */
  function getMetaContent(name) {
    try {
      const tag = document.querySelector(`meta[name="${name}"]`);
      return tag ? (tag.getAttribute('content') || '').trim() : '';
    } catch (_) {
      return '';
    }
  }

  /* ── 3. Resolve Configuration Overrides ─────────────────────── */
  const userConfig = window.__COLEARN_CONFIG__ || window.__ENV__ || {};

  // Backend / API base resolution
  let rawBackendUrl =
    userConfig.BACKEND_URL ||
    userConfig.API_BASE ||
    (typeof window.__CoLearn_API_BASE__ !== 'undefined' ? window.__CoLearn_API_BASE__ : '') ||
    getMetaContent('colearn-backend-url');

  let apiBase = '';
  let isConfigured = true;

  if (rawBackendUrl) {
    // Explicit backend URL configured
    apiBase = String(rawBackendUrl).trim().replace(/\/$/, '');
  } else if (isLocalDev) {
    // In local development:
    // If opened on port 3000 (Express serving frontend), use current origin.
    // If opened on another port (e.g. live-server, vite), default to Express on port 3000.
    const port = window.location.port;
    if (port === '3000') {
      apiBase = currentOrigin;
    } else {
      const devHost = hostname || 'localhost';
      apiBase = `http://${devHost}:3000`;
    }
  } else {
    // In PRODUCTION on Cloudflare Pages / custom domain:
    // Do NOT fall back to localhost! Do NOT guess!
    // Flag as unconfigured so UI and API calls provide a clear actionable message.
    apiBase = '';
    isConfigured = false;
    console.error(
      '[CoLearn Config] Production backend URL is NOT configured.\n' +
      'Please set your deployed backend URL via window.__COLEARN_CONFIG__.BACKEND_URL ' +
      'or <meta name="colearn-backend-url" content="https://your-api.com">.\n' +
      'Requests will NOT fall back to localhost in production.'
    );
  }

  /* ── 4. Resolve WebSocket Signaling URL ────────────────────── */
  let rawWsUrl =
    userConfig.WS_URL ||
    userConfig.WEBSOCKET_URL ||
    getMetaContent('colearn-ws-url');

  let wsUrl = '';
  if (rawWsUrl) {
    wsUrl = String(rawWsUrl).trim().replace(/\/$/, '');
  } else if (apiBase) {
    try {
      const parsedApi = new URL(apiBase);
      const wsProto = parsedApi.protocol === 'https:' ? 'wss:' : 'ws:';
      wsUrl = `${wsProto}//${parsedApi.host}/ws/video`;
    } catch (_) {
      if (isLocalDev) {
        wsUrl = `ws://${hostname || 'localhost'}:3000/ws/video`;
      }
    }
  } else if (isLocalDev) {
    wsUrl = `ws://${hostname || 'localhost'}:3000/ws/video`;
  } else {
    wsUrl = '';
  }

  /* ── 5. Cross-Origin Check ─────────────────────────────────── */
  let isCrossOrigin = false;
  if (apiBase) {
    try {
      const parsedApi = new URL(apiBase);
      isCrossOrigin = parsedApi.origin !== currentOrigin;
    } catch (_) {}
  }

  /* ── 6. Firebase Client Configuration ──────────────────────── */
  const firebaseOverride =
    userConfig.FIREBASE ||
    window.__FIREBASE_CONFIG__ ||
    (window.CONFIG && window.CONFIG.FIREBASE) ||
    null;

  const firebaseConfig = firebaseOverride || {
    apiKey:
      getMetaContent('colearn-firebase-api-key') ||
      'AIzaSy_DEV_TEST_KEY_PLACEHOLDER',
    authDomain:
      getMetaContent('colearn-firebase-auth-domain') ||
      'your-project-id.firebaseapp.com',
    projectId:
      getMetaContent('colearn-firebase-project-id') ||
      'your-project-id',
    databaseURL:
      getMetaContent('colearn-firebase-database-url') ||
      'https://your-project-id-default-rtdb.firebaseio.com',
  };

  /* ── 7. Export CONFIG to Global Scope ──────────────────────── */
  window.CONFIG = {
    ENV,
    IS_PRODUCTION,
    IS_LOCAL: isLocalDev,
    IS_CONFIGURED: isConfigured,
    IS_CROSS_ORIGIN: isCrossOrigin,

    /**
     * Base URL for all API calls, e.g. "http://localhost:3000" or "https://api.colearn.app".
     * Guaranteed no trailing slash. Empty string if unconfigured in production.
     */
    API_BASE: apiBase,

    /**
     * WebSocket URL for WebRTC signaling, e.g. "ws://localhost:3000/ws/video" or "wss://api.colearn.app/ws/video".
     */
    WS_URL: wsUrl,

    /**
     * Firebase client SDK configuration.
     */
    FIREBASE: firebaseConfig,

    OTP_TTL: 300, // seconds (5 minutes)

    CHAT_REPLIES: [
      'Got it! 👍', 'Makes sense!', 'Great point 📝',
      'Agreed! Let\'s continue.', 'Can you explain more?',
      'That\'s interesting!', 'Let me check that.', 'On it! 🔥',
    ],
  };

  // Diagnostic log for developers and testers
  if (isLocalDev) {
    console.info(`[CoLearn Config] 🛠️ Environment: development | API: ${window.CONFIG.API_BASE} | WS: ${window.CONFIG.WS_URL}`);
  } else {
    console.info(`[CoLearn Config] 🚀 Environment: production | Configured: ${isConfigured} | API: ${window.CONFIG.API_BASE || '(not set)'} | WS: ${window.CONFIG.WS_URL || '(not set)'}`);
  }
})();
