/**
 * ══════════════════════════════════════════════════════════════════
 * CoLearn Runtime Deployment Configuration
 * ══════════════════════════════════════════════════════════════════
 *
 * 📌 TUNNELTO UPDATE WORKFLOW (Termux):
 * Whenever you restart Tunnelto in Termux and receive a new tunnel URL:
 *
 *   1. Update the `TUNNELTO_URL` string below with your new tunnel URL.
 *   2. Commit and push to GitHub (`git commit -am "Update tunnel URL" && git push`).
 *   3. GitHub Pages automatically redeploys in ~30 seconds.
 *
 * NOTE:
 * • Localhost Development:
 *   When accessing CoLearn on http://localhost:3000 or your local LAN,
 *   this file automatically routes all requests to http://localhost:3000.
 * • Permanent GitHub Pages (https://navi-31.github.io/CoLearn_Development_Phase/):
 *   All API requests and WebSocket signaling route to TUNNELTO_URL.
 * • You NEVER need to modify Firebase authorized domains or Web API key
 *   restrictions when Tunnelto restarts, because the browser origin remains
 *   permanently at `https://navi-31.github.io`!
 */

(function () {
  'use strict';

  /* ──────────────────────────────────────────────────────────────
     ⬇️ UPDATE THIS VALUE WHENEVER TUNNELTO RESTARTS ⬇️
     ────────────────────────────────────────────────────────────── */
  const TUNNELTO_URL = 'https://early-orbit-807.tunnel.to';

  /* ──────────────────────────────────────────────────────────────
     Export to CoLearn Global Configuration
     ────────────────────────────────────────────────────────────── */
  window.__COLEARN_CONFIG__ = window.__COLEARN_CONFIG__ || {};
  window.__COLEARN_CONFIG__.TUNNELTO_URL = TUNNELTO_URL.trim().replace(/\/$/, '');

  // Pre-configured public Firebase Web App parameters for Friendsync
  // (apiKey can be set here, via meta tag in index.html, or fetched dynamically from backend /api/config/firebase)
  window.__COLEARN_CONFIG__.FIREBASE = window.__COLEARN_CONFIG__.FIREBASE || {
    apiKey:      '',
    projectId:   'friendsync-89f12',
    authDomain:  'friendsync-89f12.firebaseapp.com',
    databaseURL: 'https://friendsync-89f12-default-rtdb.firebaseio.com',
  };
})();
