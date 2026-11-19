/* ── Centralized Environment & App Configuration ─────────────── */
/**
 * Centralized configuration system for CoLearn.
 *
 * Automatically detects the runtime environment:
 *  • LOCAL / DEVELOPMENT:
 *      Detected when accessed via localhost, 127.0.0.1, [::1], or private LAN IPs.
 *      API calls and WebSocket signaling route to the local Express server.
 *  • PRODUCTION / GITHUB PAGES:
 *      Detected on public hostnames (e.g. navi-31.github.io).
 *      Loads centralized public configuration asynchronously from:
 *        frontend/config/public.json
 *      Single source of truth for the active Tunnelto backend URL.
 *      WebSocket signaling is dynamically derived (https -> wss).
 *      NEVER falls back to localhost or silently redirects production traffic.
 *
 * Configuration sources (in priority order):
 *  1. window.__COLEARN_CONFIG__  (explicit configuration object)
 *  2. frontend/config/public.json (centralized public deployment configuration)
 *  3. window.__ENV__             (environment configuration object)
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
  const pathname = (window.location.pathname || '/');

  // Check if running on GitHub Pages (e.g. navi-31.github.io)
  const isGitHubPages = Boolean(
    hostname === 'navi-31.github.io' ||
    hostname.endsWith('.github.io')
  );

  // Check if running in a local / loopback / LAN development environment
  const isLocalDev = Boolean(
    !isGitHubPages && (
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
    )
  );

  // Check if accessed through a temporary public development tunnel directly (Express hosting)
  const isTunnel = Boolean(
    hostname.endsWith('.tunnel.to') ||
    hostname.endsWith('.ngrok.io') ||
    hostname.endsWith('.ngrok-free.app') ||
    hostname.endsWith('.loca.lt') ||
    hostname.endsWith('.trycloudflare.com')
  );

  const ENV = (isLocalDev || isTunnel) ? 'development' : 'production';
  const IS_PRODUCTION = !isLocalDev && !isTunnel;

  // Base repository subpath (e.g. '/CoLearn_Development_Phase/' on GitHub Pages)
  const basePath = (isGitHubPages && pathname.startsWith('/CoLearn_Development_Phase'))
    ? '/CoLearn_Development_Phase/'
    : '/';

  /* ── 2. Helper to read meta tags ───────────────────────────── */
  function getMetaContent(name) {
    try {
      const tag = document.querySelector(`meta[name="${name}"]`);
      return tag ? (tag.getAttribute('content') || '').trim() : '';
    } catch (_) {
      return '';
    }
  }

  /* ── 3. Resolve Synchronous Configuration Baseline ─────────── */
  const userConfig = window.__COLEARN_CONFIG__ || window.__ENV__ || {};

  // Optional fallback configured in env-config.js
  const fallbackTunneltoUrl = (userConfig.TUNNELTO_URL || '').trim().replace(/\/$/, '');

  // Explicit JavaScript overrides take highest priority if manually provided
  const explicitBackendUrl =
    userConfig.BACKEND_URL ||
    userConfig.API_BASE ||
    (typeof window.__CoLearn_API_BASE__ !== 'undefined' ? window.__CoLearn_API_BASE__ : '');

  const metaBackendUrl = getMetaContent('colearn-backend-url');

  let apiBase = '';
  let isConfigured = true;

  if (explicitBackendUrl) {
    // 1. Explicit runtime JS configuration
    apiBase = String(explicitBackendUrl).trim().replace(/\/$/, '');
  } else if (isLocalDev) {
    // 2. LOCALHOST / LAN DEVELOPMENT:
    // ALWAYS route to the local Express backend directly.
    // Never allow a remote tunnel URL to hijack localhost traffic.
    const port = window.location.port;
    if (port === '3000') {
      apiBase = currentOrigin;
    } else {
      const devHost = hostname || 'localhost';
      apiBase = `http://${devHost}:3000`;
    }
  } else if (isTunnel) {
    // 3. Direct tunnel browsing (Express serves both frontend and API on same origin)
    apiBase = currentOrigin;
  } else if (fallbackTunneltoUrl) {
    apiBase = fallbackTunneltoUrl;
  } else if (metaBackendUrl) {
    apiBase = String(metaBackendUrl).trim().replace(/\/$/, '');
  } else {
    // Initial placeholder for production while public.json is being fetched
    apiBase = '';
    isConfigured = false;
  }

  /* ── 4. Resolve WebSocket Signaling URL ────────────────────── */
  const explicitWsUrl =
    userConfig.WS_URL ||
    userConfig.WEBSOCKET_URL;

  const metaWsUrl = getMetaContent('colearn-ws-url');

  let wsUrl = '';
  if (explicitWsUrl) {
    wsUrl = String(explicitWsUrl).trim().replace(/\/$/, '');
  } else if (isLocalDev) {
    wsUrl = `ws://${hostname || 'localhost'}:3000/ws/video`;
  } else if (metaWsUrl) {
    wsUrl = String(metaWsUrl).trim().replace(/\/$/, '');
  } else if (isTunnel) {
    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl = `${wsProto}//${hostname}/ws/video`;
  } else if (apiBase) {
    try {
      const parsedApi = new URL(apiBase);
      const wsProto = parsedApi.protocol === 'https:' ? 'wss:' : 'ws:';
      wsUrl = `${wsProto}//${parsedApi.host}/ws/video`;
    } catch (_) {
      wsUrl = '';
    }
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
  const rawFirebaseOverride =
    userConfig.FIREBASE ||
    window.__FIREBASE_CONFIG__ ||
    (window.CONFIG && window.CONFIG.FIREBASE) ||
    {};

  const firebaseConfig = {
    apiKey:
      rawFirebaseOverride.apiKey ||
      getMetaContent('colearn-firebase-api-key') ||
      'AIzaSy_DEV_TEST_KEY_PLACEHOLDER',
    authDomain:
      rawFirebaseOverride.authDomain ||
      getMetaContent('colearn-firebase-auth-domain') ||
      'friendsync-89f12.firebaseapp.com',
    projectId:
      rawFirebaseOverride.projectId ||
      getMetaContent('colearn-firebase-project-id') ||
      'friendsync-89f12',
    databaseURL:
      rawFirebaseOverride.databaseURL ||
      getMetaContent('colearn-firebase-database-url') ||
      'https://friendsync-89f12-default-rtdb.firebaseio.com',
  };

  /* ── 7. Export Initial CONFIG to Global Scope ──────────────── */
  window.CONFIG = {
    ENV,
    IS_PRODUCTION,
    IS_LOCAL: isLocalDev,
    IS_GITHUB_PAGES: isGitHubPages,
    IS_CONFIGURED: isConfigured,
    IS_CROSS_ORIGIN: isCrossOrigin,
    BASE_PATH: basePath,

    /**
     * Base URL for all API calls, e.g. "http://localhost:3000" or "https://early-orbit-807.tunnel.to".
     * Guaranteed no trailing slash. Updated dynamically when public.json is fetched.
     */
    API_BASE: apiBase,

    /**
     * WebSocket URL for WebRTC signaling, e.g. "ws://localhost:3000/ws/video" or "wss://early-orbit-807.tunnel.to/ws/video".
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

  /* ── 8. Asynchronous Centralized Config Loader ─────────────── */
  let _configPromise = null;

  async function loadPublicConfig() {
    // Local development does not require remote public.json fetching
    if (isLocalDev) {
      return window.CONFIG;
    }

    // Explicit runtime manual override takes precedence
    if (explicitBackendUrl) {
      return window.CONFIG;
    }

    // Determine path to public.json
    // On GitHub Pages: /CoLearn_Development_Phase/config/public.json
    // On root deployment: /config/public.json
    const configPath = `${basePath.replace(/\/$/, '')}/config/public.json`;
    const resolvedUrl = new URL(configPath, window.location.origin).href;

    try {
      // Use cache: 'no-store' and a timestamp query to bypass GitHub Pages / browser caching
      const fetchUrl = `${resolvedUrl}?_t=${Date.now()}`;
      const response = await fetch(fetchUrl, {
        cache: 'no-store',
        headers: { 'Accept': 'application/json' },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      if (data && typeof data.backendUrl === 'string' && data.backendUrl.trim()) {
        const publicBackend = data.backendUrl.trim().replace(/\/$/, '');
        window.CONFIG.API_BASE = publicBackend;
        window.CONFIG.IS_CONFIGURED = true;

        if (data.firebase && typeof data.firebase === 'object') {
          window.CONFIG.FIREBASE = Object.assign({}, window.CONFIG.FIREBASE, data.firebase);
          window.__FIREBASE_CONFIG__ = window.CONFIG.FIREBASE;
        }

        // Dynamically derive WebSocket URL (https -> wss, http -> ws, append /ws/video)
        try {
          const parsed = new URL(publicBackend);
          const proto = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
          window.CONFIG.WS_URL = `${proto}//${parsed.host}/ws/video`;
          window.CONFIG.IS_CROSS_ORIGIN = (parsed.origin !== currentOrigin);
        } catch (_) {
          window.CONFIG.WS_URL = publicBackend.replace(/^http/, 'ws') + '/ws/video';
        }

        console.info(`[CoLearn Config] 🌐 Centralized public configuration loaded from ${configPath}:`, {
          backendUrl: window.CONFIG.API_BASE,
          wsUrl: window.CONFIG.WS_URL,
        });
        return window.CONFIG;
      } else {
        throw new Error('public.json missing valid "backendUrl" property.');
      }
    } catch (err) {
      console.warn(`[CoLearn Config] ⚠️ Could not fetch centralized ${configPath}: ${err.message}.`);
      // If fallback URL available, ensure it is configured
      if (!window.CONFIG.API_BASE && (fallbackTunneltoUrl || metaBackendUrl)) {
        const fallbackUrl = fallbackTunneltoUrl || metaBackendUrl;
        window.CONFIG.API_BASE = fallbackUrl;
        window.CONFIG.IS_CONFIGURED = true;
        try {
          const parsed = new URL(fallbackUrl);
          const proto = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
          window.CONFIG.WS_URL = `${proto}//${parsed.host}/ws/video`;
          window.CONFIG.IS_CROSS_ORIGIN = (parsed.origin !== currentOrigin);
        } catch (_) {}
      }

      if (!window.CONFIG.API_BASE && isGitHubPages) {
        console.error(
          '[CoLearn Config] Public backend URL is NOT configured.\n' +
          'Please ensure frontend/config/public.json exists and has a valid "backendUrl".'
        );
      }
      return window.CONFIG;
    }
  }

  function ensureConfigReady() {
    if (!_configPromise) {
      _configPromise = loadPublicConfig();
    }
    return _configPromise;
  }

  // Immediately initiate public configuration fetch
  ensureConfigReady();

  // Export helper functions to global window scope
  window.ensureConfigReady = ensureConfigReady;
  window.loadPublicConfig = ensureConfigReady;

  // Diagnostic log
  if (isLocalDev) {
    console.info(`[CoLearn Config] 🛠️ Environment: development | API: ${window.CONFIG.API_BASE} | WS: ${window.CONFIG.WS_URL}`);
  } else {
    console.info(`[CoLearn Config] 🚀 Environment: production | Initial API: ${window.CONFIG.API_BASE || '(resolving via public.json...)'}`);
  }
})();
