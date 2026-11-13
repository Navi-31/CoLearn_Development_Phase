/**
 * CoLearn Environment Configuration Template
 * ─────────────────────────────────────────────────────────────────
 * Copy or include this configuration before js/config.js if you want
 * to configure your deployed backend and WebSocket endpoints.
 *
 * In local development, CoLearn automatically defaults to:
 *   • BACKEND_URL: http://localhost:3000
 *   • WS_URL:      ws://localhost:3000/ws/video
 *
 * For Cloudflare Pages production deployment:
 *   Set your deployed backend URL below or in frontend/index.html.
 */

window.__COLEARN_CONFIG__ = {
  // Your deployed backend API endpoint (e.g. on Render, Railway, Fly.io, or VPS)
  // Example: "https://api.colearn.app"
  BACKEND_URL: "",

  // Optional: Your deployed WebSocket signaling endpoint for WebRTC
  // If omitted, this is automatically derived from BACKEND_URL (https:// -> wss://.../ws/video)
  // Example: "wss://api.colearn.app/ws/video"
  WS_URL: "",

  // Optional: Firebase client configuration overrides
  FIREBASE: {
    apiKey: "",
    authDomain: "",
    projectId: "",
    databaseURL: ""
  }
};
