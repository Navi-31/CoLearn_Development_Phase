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

  // Firebase project configuration (configurable via window.__FIREBASE_CONFIG__ or window.CONFIG.FIREBASE)
  const firebaseConfig = window.__FIREBASE_CONFIG__ || (window.CONFIG && window.CONFIG.FIREBASE) || {
    apiKey:      'AIzaSy_DEV_TEST_KEY_PLACEHOLDER',
    authDomain:  'your-project-id.firebaseapp.com',
    projectId:   'your-project-id',
    // Realtime Database URL — using default US region.
    // If your project uses a different region, update this URL accordingly.
    databaseURL: 'https://your-project-id-default-rtdb.firebaseio.com',
  };

  // Guard: only initialize once
  try {
    if (!firebase.apps.length) {
      firebase.initializeApp(firebaseConfig);
    }

    // ── Firebase Auth ───────────────────────────────────────────
    window.fsAuth = firebase.auth();

    // ── Firestore (chat) ────────────────────────────────────────
    try {
      window.fsDb = firebase.firestore();
      // Enable offline persistence (best-effort, may fail in multi-tab)
      window.fsDb.enablePersistence({ synchronizeTabs: true }).catch(() => {});
      console.info('[CoLearn] Firestore ready.');
    } catch (e) {
      console.warn('[CoLearn] Firestore init failed:', e.message);
      window.fsDb = undefined;
    }

    // ── Realtime Database (WebRTC signaling) ────────────────────
    try {
      window.fsRtdb = firebase.database();
      // Quick connectivity test — if RTDB is not provisioned, this will error
      window.fsRtdb.ref('.info/connected').once('value')
        .then(() => console.info('[CoLearn] Realtime Database ready.'))
        .catch(e => {
          console.warn('[CoLearn] Realtime Database connection failed:', e.message);
          // RTDB might not be provisioned — voice signaling will be unavailable
          window.fsRtdb = undefined;
        });
    } catch (e) {
      console.warn('[CoLearn] Realtime Database init failed:', e.message);
      window.fsRtdb = undefined;
    }

  } catch (e) {
    console.error('[CoLearn] Firebase client SDK initialization failed:', e.message);
    window.fsAuth = undefined;
    window.fsDb   = undefined;
    window.fsRtdb = undefined;
    return;
  }

  let _authInFlightPromise = null;

  /**
   * Authenticate the Firebase Client SDK using a custom token from the backend.
   * Called after successful backend login / session restore.
   *
   * @param {string} uid  The user's Firebase UID
   */
  window.authenticateFirebaseClient = async function(uid) {
    if (!uid || !window.fsAuth) return false;

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
  window.ensureFirebaseAuth = async function(uid) {
    if (!uid && typeof AppState !== 'undefined' && AppState.currentUser) {
      uid = AppState.currentUser.uid;
    }
    if (!uid || !window.fsAuth) return false;
    const currentFbUser = window.fsAuth.currentUser;
    if (currentFbUser && currentFbUser.uid === uid) return true;
    return window.authenticateFirebaseClient(uid);
  };

})();
