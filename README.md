# 🔗 CoLearn — Collaborative Learning Platform

[![CI](https://github.com/Navi-31/CoLearn_Development_Phase/actions/workflows/ci.yml/badge.svg)](https://github.com/Navi-31/CoLearn_Development_Phase/actions/workflows/ci.yml)
[![Security Analysis](https://github.com/Navi-31/CoLearn_Development_Phase/actions/workflows/security.yml/badge.svg)](https://github.com/Navi-31/CoLearn_Development_Phase/actions/workflows/security.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)
[![GitHub Issues](https://img.shields.io/github/issues/Navi-31/CoLearn_Development_Phase)](https://github.com/Navi-31/CoLearn_Development_Phase/issues)
[![Contributions Welcome](https://img.shields.io/badge/contributions-welcome-blue)](./CONTRIBUTING.md)

> **Real-time collaborative study suites with video, whiteboard, Google Drive, and private chat.**

CoLearn is an open-source collaborative platform where students and professionals create or join **study suites** — persistent, invite-only workspaces equipped with video calling, screen sharing, a shared multi-page whiteboard, Google Drive document management, suite chat, and private messaging.

---

## 🖼️ Screenshots

> Screenshots coming soon. Run the app locally to see it in action!  
> See [`docs/images/README.md`](./docs/images/README.md) for screenshot contribution guidelines.

<!-- Uncomment after adding screenshots:
| Dashboard | Workspace |
|-----------|-----------|
| ![Dashboard](docs/images/03-dashboard.png) | ![Workspace](docs/images/04-workspace.png) |

| Whiteboard | Google Drive |
|------------|-------------|
| ![Whiteboard](docs/images/05-whiteboard.png) | ![Drive](docs/images/06-drive.png) |
-->

---

## 🎬 Demo

> **Live Demo:** _Coming soon — deploy your own instance using the [Deployment Guide](./docs/DEPLOYMENT.md)._

> **Video Demo:** _Coming soon._

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🔐 **Authentication** | Email + password via Firebase Auth with OTP email verification |
| 📧 **Email OTP** | 6-digit OTP for signup and password reset (5-minute TTL, SHA-256 stored) |
| 🔑 **Forgot Password** | 3-step flow: email → OTP verify → new password via Firebase Admin SDK |
| 📋 **Suite Management** | Create permanent or quick suites; join via 5-digit code or invite link |
| 📨 **Invite System** | Host generates invite code/link; email delivery via SMTP |
| 📹 **Video Call** | WebRTC peer-to-peer video calling with mic/camera toggle |
| 📺 **Screen Share** | Share your screen to all suite members in real time |
| 🎨 **Whiteboard** | Multi-page HTML5 Canvas whiteboard with pen, eraser, color, size, save PNG |
| 💬 **Suite Chat** | Group text chat with message history |
| ✉️ **Private Chat** | One-to-one private messaging with reply threads and emoji picker |
| 🔔 **Notifications** | In-app notification bell with unread badge |
| ☁️ **Google Drive** | Per-user Drive connection; files uploaded to suite-specific folders |
| 🔒 **Drive Permissions** | Auto-grant access when member joins, auto-revoke when removed |
| 👁️ **Document Viewer** | Preview Drive files inline (PDF, DOCX, PPTX, images) |
| 🌐 **LAN Support** | Runs on `0.0.0.0`; share the network URL with anyone on the same Wi-Fi |
| ⚡ **SSE Updates** | Real-time member list via Server-Sent Events |

---

## 🏗️ Architecture

```
Browser (SPA)
    │
    │  HTTP / WebRTC / SSE
    ▼
Express Server  (backend/server.js)
    │
    ├── REST API   (/api/*)
    │     ├── Auth            (Firebase Admin SDK + Firestore)
    │     ├── OTP             (in-memory store, SHA-256 hashed)
    │     ├── Suites          (Firestore)
    │     ├── Invite          (in-memory + Firestore)
    │     ├── Google Drive    (googleapis — OAuth2 per user)
    │     └── SSE             (member stream)
    │
    └── Static Files  (frontend/)

Firebase
    ├── Authentication   (email/password)
    └── Firestore        (users, suites, notifications, screenSharing)

Google Drive API
    └── Per-user OAuth2 tokens stored in Firestore
        └── Suite-scoped folder per user
```

📐 **Full architecture with Mermaid diagrams:** [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)

---

## 🛠️ Technology Stack

### Backend
| Technology | Purpose |
|-----------|---------|
| **Node.js 18+** | Runtime |
| **Express 4** | HTTP server, routing |
| **Firebase Admin SDK** | Auth, Firestore |
| **googleapis** | Google Drive API (OAuth2) |
| **Nodemailer** | SMTP email (OTP, invites) |
| **Helmet** | Secure HTTP headers |
| **express-rate-limit** | Brute-force protection |
| **express-validator** | Input validation |
| **multer** | File upload handling |

### Frontend
| Technology | Purpose |
|-----------|---------|
| **Vanilla JS (ES6+)** | All UI logic |
| **HTML5 Canvas** | Whiteboard |
| **WebRTC** | Video, audio, screen share |
| **Firebase Client SDK** | Auth tokens, Firestore real-time |
| **CSS3** | Custom design system (no framework) |

---

## 📁 Repository Structure

```
CoLearn/
│
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.md
│   │   └── feature_request.md
│   ├── PULL_REQUEST_TEMPLATE.md
│   └── workflows/
│       ├── ci.yml             ← CI: install, lint, test
│       └── security.yml       ← Security analysis (weekly + PRs)
│
├── backend/                          ← Node.js / Express API server
│   ├── config/
│   │   ├── email.js                  ← Nodemailer transporter
│   │   ├── firebase.js               ← Firebase Admin SDK init
│   │   ├── serviceAccountKey.example.json   ← Template (safe to commit)
│   │   └── serviceAccountKey.json    ← YOUR key (gitignored, never commit)
│   ├── controllers/
│   │   ├── authController.js         ← Register, login, OTP, password reset
│   │   ├── driveController.js        ← Google Drive OAuth + file operations
│   │   └── inviteController.js       ← Suite invite logic + SSE broadcast
│   ├── middleware/
│   │   ├── errorHandler.js           ← Global Express error handler
│   │   └── requireAuth.js            ← UID header validation
│   ├── models/
│   │   ├── inviteStore.js            ← In-memory invite + SSE client store
│   │   └── store.js                  ← In-memory OTP store (hashed)
│   ├── routes/
│   │   ├── auth.js                   ← /api/auth/* + /api/send-otp
│   │   ├── drive.js                  ← /api/drive/*
│   │   ├── invite.js                 ← /api/invite/*
│   │   └── suite.js                  ← /api/suite/*
│   ├── scripts/
│   │   └── check-firebase-auth.js    ← Diagnostic script
│   ├── services/
│   │   ├── driveAuthService.js       ← OAuth2 token management per user
│   │   ├── driveService.js           ← Drive folder/file/permission operations
│   │   └── emailService.js           ← HTML email templates + send helpers
│   ├── .env.example                  ← Environment variable template
│   ├── .env.production.example       ← Production environment template
│   ├── package.json
│   └── server.js                     ← Entry point
│
├── docs/
│   ├── images/                       ← Screenshots (see images/README.md)
│   ├── API.md                        ← Full API reference
│   ├── ARCHITECTURE.md               ← System architecture + Mermaid diagrams
│   ├── DEPLOYMENT.md                 ← Local + production deployment guide
│   └── ROADMAP.md                    ← Planned features
│
├── frontend/                         ← Static SPA (served by backend)
│   ├── css/
│   │   └── styles.css                ← Design tokens + all component styles
│   ├── js/
│   │   ├── api.js                    ← fetch() wrappers for backend API
│   │   ├── config.js                 ← API_BASE, constants
│   │   ├── document-service.js       ← Drive document list + viewer
│   │   ├── firebase-client.js        ← Firebase Client SDK init
│   │   ├── invite.js                 ← Invite code/link handling
│   │   ├── member-context-menu.js    ← Right-click member actions
│   │   ├── notifications.js          ← Notification panel
│   │   ├── private-chat.js           ← Private messaging
│   │   ├── router.js                 ← SPA view navigation
│   │   ├── screen-share.js           ← Screen share WebRTC
│   │   ├── state.js                  ← Global app state
│   │   ├── utils.js                  ← Toast, alert, modal helpers
│   │   ├── video-call.js             ← Video call WebRTC
│   │   ├── voice.js                  ← Mic toggle
│   │   ├── webrtc-manager.js         ← WebRTC peer connection manager
│   │   ├── whiteboard.js             ← Canvas whiteboard engine
│   │   └── views/
│   │       ├── dashboard.js          ← Suite dashboard
│   │       ├── forgot.js             ← Forgot password (3-step)
│   │       ├── login.js              ← Login view
│   │       ├── signup.js             ← Signup + OTP flow
│   │       └── workspace.js          ← Active suite workspace
│   └── index.html                    ← SPA shell
│
├── .editorconfig                     ← Editor standards (UTF-8, LF, 2-space)
├── .gitattributes                    ← Line ending normalization
├── .gitignore
├── CHANGELOG.md
├── CONTRIBUTING.md
├── database.rules.json               ← Firebase Realtime Database rules
├── firestore.rules                   ← Firestore security rules
├── LICENSE
├── README.md
├── SECURITY.md
└── package.json                      ← Root project wrapper (no runtime deps)
```

---

## 🚀 Quick Start

```bash
# 1. Clone
git clone https://github.com/Navi-31/CoLearn_Development_Phase.git
cd colearn

# 2. Install backend
cd backend && npm install

# 3. Configure (see full guide below)
cp .env.example .env
# Edit .env with Firebase, SMTP, Google OAuth credentials

# 4. Add Firebase Admin SDK key
cp config/serviceAccountKey.example.json config/serviceAccountKey.json
# Replace with your real key from Firebase Console

# 5. Run
cd .. && npm run backend
# Open http://localhost:3000
```

For full setup instructions, see **[docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md)**.

---

## ⚙️ Environment Variables

All environment variables live in `backend/.env`. Copy from `backend/.env.example`.

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: `3000`) |
| `NODE_ENV` | No | `development` or `production` |
| `APP_URL` | Yes (prod) | Your public domain, e.g. `https://colearn.com` |
| `ALLOWED_ORIGINS` | No | CORS whitelist. `*` for dev, domain for prod |
| `SMTP_USER` | Yes | Gmail address for sending email |
| `SMTP_PASS` | Yes | Gmail App Password (16 chars) |
| `EMAIL_FROM_NAME` | No | Display name for emails (default: `CoLearn`) |
| `FIREBASE_PROJECT_ID` | Yes | Firebase project ID |
| `FIREBASE_KEY_PATH` | Yes | Path to service account key |
| `FIREBASE_API_KEY` | Yes | Firebase Web API key |
| `GOOGLE_CLIENT_ID` | Yes | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Yes | Google OAuth client secret |

---

## 📚 Documentation

| Document | Description |
|----------|-------------|
| [API Reference](./docs/API.md) | All backend endpoints, request/response schemas, error codes |
| [Architecture](./docs/ARCHITECTURE.md) | System design with Mermaid diagrams |
| [Deployment Guide](./docs/DEPLOYMENT.md) | Local, VPS, PM2, Nginx, HTTPS |
| [Roadmap](./docs/ROADMAP.md) | Planned features and improvements |
| [Contributing](./CONTRIBUTING.md) | Branch naming, commit style, PR guidelines |
| [Security Policy](./SECURITY.md) | Responsible disclosure, credential handling |
| [Changelog](./CHANGELOG.md) | Version history |

---

## 🌍 Production Deployment

See the full **[Deployment Guide](./docs/DEPLOYMENT.md)** for:
- VPS setup (DigitalOcean, Hetzner, Linode)
- PM2 process manager configuration
- Nginx reverse proxy with SSE support
- Let's Encrypt HTTPS
- Security checklist

Quick start with PM2:
```bash
npm install -g pm2
pm2 start backend/server.js --name colearn
pm2 save && pm2 startup
```

---

## 🗺️ Roadmap

See **[docs/ROADMAP.md](./docs/ROADMAP.md)** for the full list of planned features including:

- Persistent whiteboard sync (CRDT / Firebase RTDB)
- Collaborative document editing (Yjs)
- PWA with offline support
- Web Push notifications
- Suite roles (admin, editor, viewer)
- OAuth social login (Google, GitHub)
- Public suite discovery
- End-to-end encrypted private chat

---

## 🤝 Contributing

We welcome contributions! Please read **[CONTRIBUTING.md](./CONTRIBUTING.md)** before opening a PR.

1. Fork the repo
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Commit following [Conventional Commits](https://www.conventionalcommits.org/)
4. Push and open a Pull Request

---

## 🔒 Security

**Do not open public GitHub issues for security vulnerabilities.**

Read our **[Security Policy](./SECURITY.md)** for responsible disclosure, credential handling, and the Firebase Admin SDK key rotation process.

---

## 📄 License

[MIT](./LICENSE) © 2025 CoLearn Contributors
