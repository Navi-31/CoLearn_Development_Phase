# CoLearn – Tunnelto Public Deployment & Recovery Guide

This guide documents the centralized deployment architecture of CoLearn and the exact step-by-step procedure to update the application when Tunnelto restarts in Termux.

---

## 1. Architecture Overview

CoLearn uses a hybrid deployment architecture:

| Component | Host / Provider | URL / Endpoint | Persistence |
| :--- | :--- | :--- | :--- |
| **Frontend** | GitHub Pages | `https://navi-31.github.io/CoLearn_Development_Phase/` | **Permanent** |
| **Backend** | Express on Termux (Android) | `http://localhost:3000` (LAN) / Tunnelto (Public) | Dynamic |
| **Tunnel** | Tunnelto CLI | `https://<subdomain>.tunnel.to` | Temporary |
| **WebSocket** | Express WS Server | `wss://<subdomain>.tunnel.to/ws/video` | Dynamic |
| **Database** | Firebase Firestore & RTDB | `friendsync-89f12` | Permanent |

### Single Source of Truth: `frontend/config/public.json`

To eliminate the need to edit multiple files across frontend, backend, meta tags, and environment variables, the public Tunnelto backend URL is centralized in a single configuration file:

```json
{
  "backendUrl": "https://early-orbit-807.tunnel.to"
}
```

- **Frontend on GitHub Pages**: On startup, fetches `/CoLearn_Development_Phase/config/public.json` (bypassing browser/CDN cache) before initializing views or dispatching API requests. Dynamically derives `window.CONFIG.API_BASE` and `window.CONFIG.WS_URL` (`https://` -> `wss://`, `/ws/video`).
- **Backend in Termux**: Automatically fetches and caches the configuration from `https://navi-31.github.io/CoLearn_Development_Phase/config/public.json` with a 60-second TTL and falls back to local disk or `.env`. Dynamically derives the Google Drive OAuth callback URL (`${backendUrl}/api/drive/callback`).
- **Firebase Auth Stability**: Because the frontend runs on permanent GitHub Pages (`https://navi-31.github.io`), Firebase Authentication authorized domains and Web API Key restrictions never change when Tunnelto restarts!

---

## 2. Step-by-Step Tunnelto Recovery Flow

Whenever Tunnelto stops, disconnects, or is restarted in Termux, follow these steps:

### Step 1: Start Tunnelto in Termux
In your Termux session, start Tunnelto pointing to local port 3000:
```bash
tunnelto --port 3000
```

### Step 2: Copy the New Tunnelto URL
Tunnelto outputs your new public HTTPS URL, for example:
```text
Success! Public tunnel established:
https://brave-falcon-1234.tunnel.to
```
Copy this URL (ensure it starts with `https://` and has no trailing slash).

### Step 3: Update `frontend/config/public.json`
Edit **only** `frontend/config/public.json` and update `backendUrl`:
```json
{
  "backendUrl": "https://brave-falcon-1234.tunnel.to"
}
```

### Step 4: Commit and Push to GitHub
Commit and push the updated configuration to the `main` branch:
```bash
git add frontend/config/public.json
git commit -m "chore(config): update tunnel URL to https://brave-falcon-1234.tunnel.to"
git push origin main
```

### Step 5: Wait for GitHub Pages Deployment
GitHub Actions deploys the updated file in ~30 seconds.
You can monitor deployment status at:
`https://github.com/Navi-31/CoLearn_Development_Phase/actions`

### Step 6: Update Google Cloud Console (Drive OAuth)
If you use Google Drive file attachments:
1. Open [Google Cloud Console Credentials](https://console.cloud.google.com/apis/credentials).
2. Select your OAuth 2.0 Client ID under **OAuth 2.0 Client IDs**.
3. Under **Authorized redirect URIs**, add the new callback URL:
   ```text
   https://brave-falcon-1234.tunnel.to/api/drive/callback
   ```
4. Click **Save**.

### Step 7: (Optional) Pull to Termux Backend
To immediately update the backend's local offline cache without waiting for the 60-second remote cache TTL:
```bash
cd ~/CoLearn_Development_Phase
git pull origin main
```
*(If your backend is already running, it will automatically refresh its cache from GitHub Pages within 60 seconds).*

### Step 8: Verify Frontend Connection
1. Open `https://navi-31.github.io/CoLearn_Development_Phase/` in your browser.
2. Open Browser Developer Tools (`F12` -> `Console`).
3. Verify the console log:
   ```text
   [CoLearn Config] 🌐 Centralized public configuration loaded from ...:
   { backendUrl: "https://brave-falcon-1234.tunnel.to", wsUrl: "wss://brave-falcon-1234.tunnel.to/ws/video" }
   ```
4. Log in or sign up to verify REST API requests succeed.

### Step 9: Verify Google Drive Connection
1. Go to **Workspace** -> **Documents** tab.
2. Click **🔗 Connect Google Drive**.
3. Sign in to your Google Account and grant permission.
4. The popup window will close automatically and show `✅ Google Drive Connected!`.

---

## 3. Troubleshooting & FAQs

### A. "Production backend URL is not configured"
- **Cause**: GitHub Pages could not fetch `config/public.json` or the file was empty.
- **Fix**: Check `https://navi-31.github.io/CoLearn_Development_Phase/config/public.json` directly in your browser. Ensure the JSON syntax is valid and contains `"backendUrl": "https://..."`.

### B. Google Drive OAuth `redirect_uri_mismatch` (Error 400)
- **Cause**: The redirect URI passed by CoLearn does not match the URI authorized in Google Cloud Console.
- **Fix**:
  1. Inspect the URL shown on Google's error page under `Request details`.
  2. Verify that `https://<your-tunnel>.tunnel.to/api/drive/callback` is saved in Google Cloud Console.
  3. Ensure there are no spaces or trailing slashes.

### C. CORS / Network Error in Browser
- **Cause**: The Express backend is not running, or Tunnelto closed.
- **Fix**:
  1. In Termux, check that `node server.js` is running on port 3000.
  2. Check that `tunnelto --port 3000` is active and forwarding traffic.
  3. Verify that `ALLOWED_ORIGINS` in `backend/.env` includes `*` or `https://navi-31.github.io`.

### D. WebSocket Connection Failed (`wss://.../ws/video`)
- **Cause**: Tunnelto connection dropped or WebSocket handshake failed.
- **Fix**: CoLearn dynamically derives the WebSocket URL from `backendUrl` by replacing `https:` with `wss:`. If WebSocket fails, restart Tunnelto and ensure the backend HTTP server has initialized its WebSocket server.

### E. CDN / Cache Delay
- CoLearn fetches `public.json` using `cache: 'no-store'` and appends a timestamp query (`?_t=...`) to avoid stale CDN responses. If you still see an old URL, perform a hard refresh (`Ctrl + Shift + R` or `Cmd + Shift + R`).
