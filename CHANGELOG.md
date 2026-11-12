# Changelog

All notable changes to **CoLearn** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.0] — 2025-07-19

### Summary

Initial public release of CoLearn — a real-time collaborative learning platform built with Node.js, Express, Firebase, and WebRTC.

---

### Authentication & User Accounts

- Email + password authentication via Firebase Auth (REST API + Admin SDK)
- User registration with email OTP verification (6-digit, 5-minute TTL, SHA-256 stored)
- Secure login with Firebase-validated session (UID-based auth on all protected routes)
- Password reset via 3-step OTP flow (send OTP → verify → set new password)
- Firebase Custom Token generation for Client SDK auth (Firestore/RTDB security rules)
- Rate-limited auth endpoints (5–10 requests per 15-minute window)
- Input validation via `express-validator` on registration and login

### Suite Management

- Create persistent or quick (temporary) study suites
- Suite host system — the creator becomes the permanent host
- View all suites the user owns or is a member of
- Delete suites (host only)
- Suite member list with host flag, name, username, join timestamp

### Invite System

- Generate 5-digit invite code (in-memory, host-scoped, active while host is online)
- Generate shareable invite link (tokenized URL)
- Send invite via email (HTML email with code + clickable link)
- Validate invite code endpoint (public — used during pre-login join flow)
- Validate invite token endpoint (public)
- Invalidate all host invites on logout/offline
- Suite join flow — adds user to Firestore `members` and `memberUids` arrays

### Video Calling (WebRTC)

- Peer-to-peer video calling using the WebRTC API
- Firestore-based signaling (offer/answer/ICE candidate exchange)
- Camera toggle (video on/off)
- Microphone toggle (mute/unmute)
- Video tile layout for multiple participants
- Screen sharing with presenter/viewer roles
- Screen share state synced via Firestore `screenSharing` collection
- Screen share state API (`POST /api/suite/:id/screen-share`)

### Whiteboard

- Multi-page shared HTML5 Canvas whiteboard
- Drawing tools: pen, eraser
- Color picker and brush size slider
- Page navigation (add, switch, delete pages)
- Save current page as PNG download
- Independent canvas per suite workspace

### Chat

- Suite group chat with message history stored in Firestore
- Private 1:1 messaging between suite members
- Reply threads in private chat
- Emoji picker in private chat
- Member context menu (right-click to open private chat or remove member)
- Read/unread state per private chat

### Notifications

- In-app notification system with bell icon and unread badge count
- Notification types: suite invite, member removed, suite deleted
- Real-time updates via Firestore `onSnapshot` listener
- Mark all as read on panel open

### Google Drive Integration

- Per-user Google Drive connection via OAuth2 (one-click consent popup)
- OAuth2 token exchange and refresh token storage in Firestore (`driveTokens`)
- Disconnect Drive (revoke access + delete stored tokens)
- Upload files to Drive from within the workspace (up to 200 MB)
- Suite-scoped folder creation in user's Drive (auto-created on first upload)
- Duplicate file handling: `keep_both` (auto-rename) or `replace`
- List suite files from Firestore metadata (ordered by upload date)
- Delete files (Drive trash + Firestore metadata removal)
- Auto-grant read permission to all suite members on upload
- Auto-grant read permission to new member on suite join
- Auto-revoke permissions when host removes a member
- Drive file preview inline (PDF, DOCX, PPTX, images via Google Drive embed URL)
- SSE broadcast on file upload/delete to update all connected clients
- Drive scope: `drive.file` only (app cannot access user's pre-existing files)

### SSE (Server-Sent Events)

- Real-time member list stream at `/api/suite/:id/members/stream`
- Initial member list pushed on connection
- Member join/leave events pushed to all connected clients
- File add/delete events pushed to suite members
- 25-second heartbeat to keep connections alive through proxies
- `X-Accel-Buffering: no` header for Nginx compatibility

### Backend Infrastructure

- Single Express server serving both REST API and frontend static files
- `'use strict'` throughout all server-side modules
- Helmet middleware for secure HTTP response headers
- CORS with configurable origin allowlist (`ALLOWED_ORIGINS` env var)
- Per-endpoint rate limiting (5–200 requests per window)
- Firebase Admin SDK initialization with token warm-up
- Firestore retry logic for `UNAUTHENTICATED` errors (up to 2 retries)
- Global error handler middleware
- `requireAuth` middleware — validates UID against Firebase Auth on every protected route
- Multer memory storage for streaming file uploads (no disk writes on server)
- Environment-based configuration via `dotenv`
- Graceful SMTP degradation — prints OTPs to console if not configured
- Nodemon hot-reload in development

### Frontend SPA

- Single-page application (no build step, pure HTML/CSS/Vanilla JS)
- Hash-based client-side routing (`#login`, `#dashboard`, `#workspace`)
- Custom CSS design system with design tokens (no framework)
- Google Fonts typography
- Toast notification system (success, error, warning)
- Modal and alert utilities
- Firebase Client SDK initialization for real-time features
- API wrapper module with centralized `fetch()` calls

### Repository & DevOps

- Professional `README.md` with feature table, architecture, setup guide
- `LICENSE` (MIT)
- `CHANGELOG.md`
- `CONTRIBUTING.md` with branch naming, commit style, PR guidelines
- `SECURITY.md` with responsible disclosure and credential rotation guide
- `.gitignore` with comprehensive secret and OS file patterns
- `serviceAccountKey.example.json` template (safe to commit)
- GitHub issue templates (bug report, feature request)
- GitHub PR template with checklist
- GitHub Actions CI workflow (`node.yml`)
- GitHub Actions CodeQL security analysis (`codeql.yml`)
- `.editorconfig` (UTF-8, LF, 2-space indent)
- `.gitattributes` (line ending normalization)
- `docs/API.md` — full API reference
- `docs/ARCHITECTURE.md` — system architecture with Mermaid diagrams
- `docs/DEPLOYMENT.md` — local + production deployment guide
- `docs/ROADMAP.md` — planned features

---

## Future Roadmap

See [`docs/ROADMAP.md`](./docs/ROADMAP.md) for the full list of planned features.
