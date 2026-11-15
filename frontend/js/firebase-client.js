/* ── Firebase Client SDK Initialization ──────────────────────────
 *
 * This file initializes the Firebase Client SDK for:
 *   • Auth (sign in with custom token from backend)
 *   • Firestore (real-time chat messages)
 *   • Realtime Database (WebRTC signaling)
 *
 * Loaded AFTER config.js, state.js, and api.js so those are available.
 * Firebase compat scripts must be loaded in index.html BEFORE this file.
 */

(function () {
  'use strict';

  function isPlaceholderConfig(cfg) {
    if (!cfg || !cfg.apiKey) return true;
    return (
      cfg.apiKey.includes('PLACEHOLDER') ||
      cfg.apiKey.includes('your-') ||
      (cfg.projectId && cfg.projectId.includes('your-project-id'))
    );
  }

  function getActiveConfig() {
    return (
      window.__FIREBASE_CONFIG__ ||
      (window.CONFIG && window.CONFIG.FIREBASE) || {
        apiKey:      'AIzaSy_DEV_TEST_KEY_PLACEHOLDER',
        authDomain:  'friendsync-89f12.firebaseapp.com',
        projectId:   'friendsync-89f12',
        databaseURL: 'https://friendsync-89f12-default-rtdb.firebaseio.com',
      }
    );
  }

  function setupFirebaseServices() {
    // ── Firebase Auth ───────────────────────────────────────────
    try {
      window.fsAuth = firebase.auth();
    } catch (e) {
      console.warn('[CoLearn] Firebase Auth init failed:', e.message);
      window.fsAuth = undefined;
    }

    // ── Firestore (chat) ────────────────────────────────────────
    try {
      window.fsDb = firebase.firestore();
      window.fsDb.enablePersistence({ synchronizeTabs: true }).catch(() => {});
      console.info('[CoLearn] Firestore ready.');
    } catch (e) {
      console.warn('[CoLearn] Firestore init failed:', e.message);
      window.fsDb = undefined;
    }

    // ── Realtime Database (WebRTC signaling) ────────────────────
    try {
      window.fsRtdb = firebase.database();
      window.fsRtdb.ref('.info/connected').once('value')
        .then(() => console.info('[CoLearn] Realtime Database ready.'))
        .catch(e => {
          console.warn('[CoLearn] Realtime Database connection failed:', e.message);
          window.fsRtdb = undefined;
        });
    } catch (e) {
      console.warn('[CoLearn] Realtime Database init failed:', e.message);
      window.fsRtdb = undefined;
    }
  }

  window.initFirebaseClient = function (config) {
    if (!config || !config.apiKey) return false;
    try {
      if (typeof firebase === 'undefined' || !firebase.initializeApp) {
        console.warn('[CoLearn] Firebase SDK scripts not loaded yet.');
        return false;
      }

      if (firebase.apps && firebase.apps.length > 0) {
        const currentApp = firebase.app();
        if (
          currentApp.options &&
          currentApp.options.apiKey === config.apiKey &&
          currentApp.options.projectId === config.projectId
        ) {
          setupFirebaseServices();
          return true;
        }

        // Re-initialize with real credentials if previously on placeholder
        currentApp.delete().then(() => {
          firebase.initializeApp(config);
          setupFirebaseServices();
        }).catch(() => {});
        return true;
      }

      firebase.initializeApp(config);
      setupFirebaseServices();
      return true;
    } catch (e) {
      console.error('[CoLearn] Firebase client SDK initialization failed:', e.message);
      return false;
    }
  };

  let _configFetchPromise = null;

  /**
   * Ensures the Firebase Client SDK is initialized with valid non-placeholder configuration.
   * If running with placeholders, fetches the public client config from backend /api/config/firebase.
   */
  window.ensureFirebaseClientReady = async function () {
    let currentConfig = getActiveConfig();
    if (!isPlaceholderConfig(currentConfig) && window.fsAuth) {
      return true;
    }

    if (_configFetchPromise) {
      return _configFetchPromise;
    }

    _configFetchPromise = (async () => {
      try {
        if (typeof apiFetch === 'function') {
          const cfgRes = await apiFetch('/api/config/firebase');
          if (cfgRes && cfgRes.success && cfgRes.firebase && !isPlaceholderConfig(cfgRes.firebase)) {
            window.__FIREBASE_CONFIG__ = cfgRes.firebase;
            if (window.CONFIG) window.CONFIG.FIREBASE = cfgRes.firebase;
            activeConfig = cfgRes.firebase;
            window.initFirebaseClient(cfgRes.firebase);
            return true;
          }
        }
      } catch (e) {
        console.warn('[CoLearn] Could not fetch Firebase public config from backend:', e.message);
      } finally {
        _configFetchPromise = null;
      }
      return Boolean(window.fsAuth);
    })();

    return _configFetchPromise;
  };

  // Initial attempt with current active config
  let activeConfig = getActiveConfig();
  if (typeof firebase !== 'undefined' && firebase.initializeApp) {
    window.initFirebaseClient(activeConfig);
  }

  // Pre-fetch public config from backend if running with placeholder keys
  if (isPlaceholderConfig(activeConfig) && typeof apiFetch === 'function') {
    window.ensureFirebaseClientReady().catch(() => {});
  }

  let _authInFlightPromise = null;

  /**
   * Authenticate the Firebase Client SDK using a custom token from the backend.
   * Called after successful backend login / session restore.
   *
   * @param {string} uid  The user's Firebase UID
   */
  window.authenticateFirebaseClient = async function (uid) {
    if (!uid) return false;

    // Ensure Firebase client is initialized with valid non-placeholder config
    await window.ensureFirebaseClientReady();

    if (!window.fsAuth) return false;

    // Check if already signed in as this user
    const currentFbUser = window.fsAuth.currentUser;
    if (currentFbUser && currentFbUser.uid === uid) {
      console.info('[CoLearn] Firebase client already authenticated for:', uid);
      return true;
    }

    if (_authInFlightPromise) {
      return _authInFlightPromise;
    }

    _authInFlightPromise = (async () => {
      try {
        const res = await apiFetch('/api/auth/token', {
          method: 'POST',
          body:   JSON.stringify({ uid }),
        });

        if (res && res.success && res.token) {
          await window.fsAuth.signInWithCustomToken(res.token);
          console.info('[CoLearn] Firebase client authenticated for uid:', uid);
          try {
            window.dispatchEvent(new CustomEvent('firebaseAuthReady', { detail: { uid } }));
          } catch (_) {}
          return true;
        } else {
          console.warn('[CoLearn] Could not get Firebase custom token:', res && res.error);
          return false;
        }
      } catch (e) {
        console.warn('[CoLearn] Firebase client authentication failed:', e.message);
        return false;
      } finally {
        _authInFlightPromise = null;
      }
    })();

    return _authInFlightPromise;
  };

  /**
   * Helper to ensure Firebase Client is fully authenticated before accessing RTDB/Firestore.
   */
  window.ensureFirebaseAuth = async function (uid) {
    if (!uid && typeof AppState !== 'undefined' && AppState.currentUser) {
      uid = AppState.currentUser.uid;
    }
    if (!uid) return false;
    if (!window.fsAuth) {
      return window.authenticateFirebaseClient(uid);
    }
    const currentFbUser = window.fsAuth.currentUser;
    if (currentFbUser && currentFbUser.uid === uid) return true;
    return window.authenticateFirebaseClient(uid);
  };

})();
