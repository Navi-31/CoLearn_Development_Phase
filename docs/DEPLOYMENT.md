# CoLearn — Deployment Guide

This guide covers everything needed to run CoLearn in **local development** and **production**.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Local Development](#local-development)
3. [Firebase Setup](#firebase-setup)
4. [Google OAuth & Drive Setup](#google-oauth--drive-setup)
5. [SMTP Setup (Gmail)](#smtp-setup-gmail)
6. [Environment Variables Reference](#environment-variables-reference)
7. [Production Deployment](#production-deployment)
8. [PM2 Process Manager](#pm2-process-manager)
9. [Reverse Proxy (Nginx)](#reverse-proxy-nginx)
10. [HTTPS Setup](#https-setup)
11. [Security Checklist](#security-checklist)

---

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | 18+ | LTS recommended |
| npm | 9+ | Included with Node.js |
| Firebase project | Any | Free Spark plan works |
| Gmail account | — | For SMTP (OTP / invite emails) |
| Google Cloud project | — | For Google Drive OAuth |

---

## Local Development

### 1. Clone and Install

```bash
git clone https://github.com/Navi-31/CoLearn_Development_Phase.git
cd colearn
cd backend && npm install
```

### 2. Configure Environment

```bash
cp backend/.env.example backend/.env
```

Edit `backend/.env` with your credentials. See [Environment Variables](#environment-variables-reference).

### 3. Firebase Admin SDK Key

```bash
# Place your downloaded key here:
cp ~/Downloads/your-firebase-key.json backend/config/serviceAccountKey.json
```

### 4. Start the Server

```bash
# From the project root:
npm run backend

# Or directly:
cd backend && npm run dev
```

The server starts on `http://localhost:3000`.

**LAN access:** The startup banner prints your local IP — other devices on the same Wi-Fi can use that URL.

### 5. Open the App

Navigate to `http://localhost:3000` in your browser.

---

## Firebase Setup

### Step 1 — Create a Firebase Project

1. Go to [https://console.firebase.google.com/](https://console.firebase.google.com/)
2. Click **Add project** → enter project name → Continue
3. Disable Google Analytics (optional) → Create project

### Step 2 — Enable Authentication

1. In the Firebase Console: **Build → Authentication → Get started**
2. Click **Sign-in method** tab
3. Enable **Email/Password** → Save

### Step 3 — Create Firestore Database

1. **Build → Firestore Database → Create database**
2. Choose **Production mode** (you'll configure rules next)
3. Select a Cloud Firestore location (pick one close to your users)

### Step 4 — Deploy Firestore Rules

```bash
npm install -g firebase-tools
firebase login
firebase use --add   # select your project
firebase deploy --only firestore:rules
```

Or paste `firestore.rules` contents manually in the Firebase Console under **Firestore → Rules**.

### Step 5 — Get Admin SDK Key

1. **Project Settings** (gear icon) → **Service Accounts** tab
2. Click **Generate new private key** → Download JSON
3. Rename to `serviceAccountKey.json`
4. Place at `backend/config/serviceAccountKey.json`

> ⚠️ **Never commit this file.** It is gitignored.

### Step 6 — Get Web API Key

1. **Project Settings → General**
2. Under **Your apps**, register a Web app if none exists
3. Copy the `apiKey` value → set as `FIREBASE_API_KEY` in `backend/.env`

### Step 7 — (Optional) Enable Realtime Database

Screen-sharing state uses Firebase Realtime Database:

1. **Build → Realtime Database → Create database**
2. Select **Locked mode** (deploy rules from `database.rules.json`)
3. Copy the Database URL and set as `FIREBASE_RTDB_URL` in `backend/.env` if needed

---

## Google OAuth & Drive Setup

This is a **one-time setup** for the entire CoLearn application. All users share one OAuth client but each user grants their own independent Google Drive access.

### Step 1 — Select or Create a Google Cloud Project

1. Go to [https://console.cloud.google.com/](https://console.cloud.google.com/)
2. Select your Firebase project (same project recommended) or create a new one

### Step 2 — Enable Google Drive API

1. **APIs & Services → Library**
2. Search for **Google Drive API** → **Enable**

### Step 3 — Configure OAuth Consent Screen

1. **APIs & Services → OAuth consent screen**
2. User type: **External** → Create
3. Fill in:
   - **App name:** `CoLearn`
   - **User support email:** your email
   - **Developer contact email:** your email
4. **Scopes:** Click **Add or Remove Scopes** → add:
   - `https://www.googleapis.com/auth/drive.file`
5. **Test users:** Add your Gmail address (required while app is in Testing mode)
6. **Summary:** Save and continue

### Step 4 — Create OAuth 2.0 Credentials

1. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
2. Application type: **Web application**
3. Name: `CoLearn Web`
4. **Authorized redirect URIs** — add both:
   - `http://localhost:3000/api/drive/callback` (development)
   - `https://yourdomain.com/api/drive/callback` (production)
5. Click **Create** → copy **Client ID** and **Client Secret**

### Step 5 — Configure Backend

In `backend/.env`:
```env
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-your-secret
```

### Publishing the App (Production)

When you're ready for all Google accounts (not just test users):

1. OAuth consent screen → **Publish App**
2. Google may require verification for sensitive scopes — `drive.file` typically does not require verification

---

## SMTP Setup (Gmail)

### Step 1 — Enable 2-Factor Authentication

Go to [https://myaccount.google.com/security](https://myaccount.google.com/security) and enable 2-Step Verification.

### Step 2 — Generate App Password

1. [https://myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
2. Select app: **Mail** → Select device: **Other** → enter `CoLearn`
3. Copy the 16-character password (format: `xxxx xxxx xxxx xxxx`)

### Step 3 — Configure Backend

```env
SMTP_USER=your-gmail@gmail.com
SMTP_PASS=xxxx xxxx xxxx xxxx
EMAIL_FROM_NAME=CoLearn
```

> **Note:** If SMTP is not configured, the server starts in "console OTP mode" — OTPs are printed to the terminal instead of sent by email. This is fine for development but not production.

---

## Environment Variables Reference

All variables belong in `backend/.env`. Copy from `backend/.env.example`.

### Server

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `PORT` | `3000` | No | HTTP port |
| `NODE_ENV` | `development` | No | `development` or `production` |
| `HOST_IP` | auto | No | LAN IP for startup banner |

### CORS & App URL

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `APP_URL` | `http://localhost:3000` | Yes (prod) | Full public URL with no trailing slash |
| `ALLOWED_ORIGINS` | `*` | No | Comma-separated allowed origins for CORS. Use `*` in dev, domain in prod. |

### Email (SMTP)

| Variable | Required | Description |
|----------|----------|-------------|
| `SMTP_USER` | Yes | Gmail address |
| `SMTP_PASS` | Yes | Gmail App Password |
| `EMAIL_FROM_NAME` | No | Display name (default: `CoLearn`) |

### Firebase

| Variable | Required | Description |
|----------|----------|-------------|
| `FIREBASE_PROJECT_ID` | Yes | Firebase project ID |
| `FIREBASE_KEY_PATH` | Yes | Path to service account key JSON (relative to `backend/`) |
| `FIREBASE_API_KEY` | Yes | Firebase Web API key (for client-side auth REST calls) |

### Google Drive

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_CLIENT_ID` | Yes | OAuth2 client ID |
| `GOOGLE_CLIENT_SECRET` | Yes | OAuth2 client secret |
| `GOOGLE_REDIRECT_URI` | No | Auto-derived from `APP_URL` if not set |

---

## Production Deployment

### Platform Options

| Platform | Notes |
|----------|-------|
| **VPS (DigitalOcean, Linode, Hetzner)** | Full control. Recommended with PM2 + Nginx. |
| **Railway** | Easy deploy. Set env vars in dashboard. |
| **Render** | Free tier available. Set `PORT=10000`. |
| **Fly.io** | Docker-based. Requires `Dockerfile`. |
| **Vercel** | Not recommended — CoLearn uses long-lived SSE connections. |

### VPS Deployment Steps

```bash
# 1. SSH into your server
ssh user@your-server-ip

# 2. Install Node.js 20 (using nvm)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 20
nvm use 20

# 3. Clone the repository
git clone https://github.com/Navi-31/CoLearn_Development_Phase.git
cd colearn

# 4. Install backend dependencies
cd backend && npm install --production

# 5. Configure environment
cp .env.production.example .env
nano .env   # fill in all values

# 6. Upload Firebase Admin SDK key
# From your local machine:
scp backend/config/serviceAccountKey.json user@your-server-ip:~/colearn/backend/config/

# 7. Start with PM2 (see below)
```

---

## PM2 Process Manager

PM2 keeps the server running, restarts on crashes, and survives server reboots.

```bash
# Install PM2 globally
npm install -g pm2

# Start CoLearn backend
pm2 start backend/server.js --name colearn

# Save current process list (survives reboot)
pm2 save

# Enable PM2 startup on boot
pm2 startup
# Run the command that pm2 outputs

# Useful PM2 commands
pm2 list              # List running processes
pm2 logs colearn      # Stream live logs
pm2 logs colearn --lines 100   # Last 100 log lines
pm2 restart colearn   # Restart
pm2 stop colearn      # Stop
pm2 delete colearn    # Remove from list
```

**PM2 ecosystem file** (optional, create `ecosystem.config.js` in project root):

```js
module.exports = {
  apps: [{
    name: 'colearn',
    script: './backend/server.js',
    cwd: './',
    instances: 1,         // SSE requires sticky sessions; keep at 1
    exec_mode: 'fork',
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    }
  }]
};
```

---

## Reverse Proxy (Nginx)

Running CoLearn behind Nginx allows HTTPS termination and serving on port 80/443.

### Install Nginx

```bash
sudo apt update && sudo apt install nginx -y
```

### Configuration

Create `/etc/nginx/sites-available/colearn`:

```nginx
server {
    listen 80;
    server_name yourdomain.com www.yourdomain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name yourdomain.com www.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    # SSE: disable buffering so events reach the client immediately
    proxy_buffering off;
    proxy_cache off;

    location / {
        proxy_pass         http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # SSE-specific: no timeout on streaming connections
        proxy_read_timeout  24h;
        proxy_send_timeout  24h;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/colearn /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

---

## HTTPS Setup

Using Let's Encrypt (free SSL certificates):

```bash
# Install Certbot
sudo apt install certbot python3-certbot-nginx -y

# Obtain certificate (auto-configures Nginx)
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com

# Auto-renewal (already set up by certbot)
sudo certbot renew --dry-run
```

---

## Security Checklist

Before going live, verify each item:

### Secrets & Configuration
- [ ] `backend/.env` is **not** committed to git (`git check-ignore -v backend/.env`)
- [ ] `serviceAccountKey.json` is **not** committed to git
- [ ] `NODE_ENV=production` in production `.env`
- [ ] `ALLOWED_ORIGINS` set to your exact domain (not `*`)
- [ ] `APP_URL` set to your HTTPS domain
- [ ] Google OAuth redirect URI includes `https://` URL

### Infrastructure
- [ ] HTTPS enabled (TLS 1.2+)
- [ ] PM2 or equivalent process manager running
- [ ] Server reboots handled (PM2 startup configured)
- [ ] Firewall allows only ports 80, 443, and SSH

### Firebase
- [ ] Firestore security rules deployed and tested
- [ ] Firebase service account key rotated if previously exposed
- [ ] Firebase Authentication restricted to your domain (optional but recommended)

### Google Drive
- [ ] OAuth consent screen app name set to `CoLearn` (not a test name)
- [ ] Production redirect URI added to Google Cloud Console
- [ ] OAuth app published (or test users added) as needed

### Monitoring
- [ ] `pm2 logs` checked for errors after first deploy
- [ ] `/api/health` endpoint accessible and returning `200`
- [ ] SMTP tested (send a test OTP)
- [ ] Google Drive OAuth flow tested end-to-end in production
