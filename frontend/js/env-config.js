/**
 * ══════════════════════════════════════════════════════════════════
 * CoLearn Runtime Deployment Configuration
 * ══════════════════════════════════════════════════════════════════
 *
 * 📌 CENTRALIZED CONFIGURATION (Single Source of Truth):
 * The public backend URL is centralized in:
 *   frontend/config/public.json
 *
 * Whenever you restart Tunnelto in Termux and receive a new tunnel URL:
 *   1. Update ONLY `frontend/config/public.json` with your new backend URL.
 *   2. Commit and push: `git commit -am "Update tunnel URL" && git push`
 *   3. Update Google Cloud Console Authorized redirect URIs if using Drive.
 *   4. Both the GitHub Pages frontend and Termux backend will automatically
 *      load and sync from `frontend/config/public.json`!
 *
 * You do NOT need to edit this file or index.html when Tunnelto restarts.
 * Any value defined here serves strictly as an emergency offline fallback.
 */

(function () {
  'use strict';

  /* ──────────────────────────────────────────────────────────────
     Optional offline fallback (the app loads frontend/config/public.json)
     ────────────────────────────────────────────────────────────── */
  const FALLBACK_TUNNELTO_URL = '';

  /* ──────────────────────────────────────────────────────────────
     Export to CoLearn Global Configuration
     ────────────────────────────────────────────────────────────── */
  window.__COLEARN_CONFIG__ = window.__COLEARN_CONFIG__ || {};
  if (FALLBACK_TUNNELTO_URL) {
    window.__COLEARN_CONFIG__.TUNNELTO_URL = FALLBACK_TUNNELTO_URL.trim().replace(/\/$/, '');
  }

  // Pre-configured public Firebase Web App parameters for Friendsync
  // (apiKey can be set here, via meta tag in index.html, or fetched dynamically from backend /api/config/firebase)
  window.__COLEARN_CONFIG__.FIREBASE = window.__COLEARN_CONFIG__.FIREBASE || {
    apiKey:      '',
    projectId:   'friendsync-89f12',
    authDomain:  'friendsync-89f12.firebaseapp.com',
    databaseURL: 'https://friendsync-89f12-default-rtdb.firebaseio.com',
  };
})();
