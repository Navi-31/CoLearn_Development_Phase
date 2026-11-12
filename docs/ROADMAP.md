# CoLearn — Roadmap

This document tracks planned future improvements to CoLearn. Items are grouped by category. No implementation dates are promised.

> **Contributing:** If you'd like to work on any of these features, please open an issue first to discuss the approach before submitting a PR. See [CONTRIBUTING.md](../CONTRIBUTING.md).

---

## 🤝 Collaboration

### Persistent Whiteboard Sync
- Real-time multi-user whiteboard using Firebase Realtime Database or Yjs CRDT
- All users see the same canvas state; changes sync in real time
- Whiteboard history persisted across sessions
- Per-suite whiteboard isolation

### Collaborative Document Editing
- CRDT-based (Yjs or Automerge) real-time text editor embedded in the workspace
- No external dependencies — self-hosted
- Conflict-free concurrent editing by multiple suite members
- Document history and version diff

### Suite Activity Log
- Chronological audit trail of suite events (joins, uploads, whiteboard edits)
- Filterable by member and event type
- Exportable as CSV

---

## 🔔 Notifications

### Web Push Notifications
- Push notifications via the Web Push API (requires VAPID keys)
- Notify members of invite acceptance, file uploads, and suite events even when the tab is closed
- User preference controls (opt-in per notification type)

### Email Digest
- Optional daily/weekly email summary of suite activity
- Configurable frequency per user

---

## 👤 User & Account

### OAuth Social Login
- Sign in with Google
- Sign in with GitHub
- Link multiple providers to one account

### User Profile Page
- Edit display name, username, avatar
- View joined suites
- Account deletion

### Avatar / Profile Photo
- Upload to Firebase Storage
- Display in video call tile, member list, and chat

---

## 🏛️ Suite Management

### Suite Roles
- `host`: Full control — invite, remove, delete suite
- `admin`: Can invite, manage files, kick non-admin members
- `editor`: Can chat, upload files, use whiteboard
- `viewer`: Read-only — can view whiteboard and documents, cannot chat

### Public Suite Discovery
- Optional public listing for open study groups
- Search by subject, language, or tags
- "Request to join" flow for private suites

### Suite Templates
- Pre-configured suites for common use cases (Study Group, Team Sprint, Interview Prep)
- Template bundles: default whiteboard layout, suggested Drive folder structure

### Suite Archival
- Archive (soft-delete) suites instead of permanent deletion
- Restore archived suites within a retention period

---

## ☁️ Google Drive

### Multi-Provider File Storage
- Support OneDrive and Dropbox as alternatives to Google Drive
- Per-user choice of storage provider

### In-App Document Editing
- Embed Google Docs/Sheets/Slides editor via iframe
- Create new Drive documents from within the workspace

### File Previews
- Thumbnail preview grid in the document panel
- Inline PDF viewer without opening a new tab

---

## 📹 Video & Media

### Recording
- Record video call sessions to a local file or Google Drive
- Requires host permission

### Breakout Rooms
- Divide suite members into temporary sub-groups
- Each breakout room has its own video call and whiteboard

### Virtual Backgrounds
- Browser-side background blur or custom background using ML Segment API

### Bandwidth Adaptation
- Automatic video quality scaling based on network conditions

---

## 📱 Mobile & PWA

### Progressive Web App (PWA)
- Service worker for offline support
- Installable on Android and iOS home screen
- Push notification support via Web Push

### Mobile-First Responsive Layout
- Touch-optimized whiteboard (stylus / finger drawing)
- Swipeable panel navigation on small screens
- Bottom navigation bar on mobile

---

## 🔒 Security

### End-to-End Encrypted Private Chat
- E2EE for private (1:1) messages using WebCrypto API
- Messages encrypted on-device; backend stores only ciphertext

### Audit Logging
- Server-side log of authentication events, API calls, and permission changes
- Retention period configurable

### Rate Limiting Improvements
- Per-user rate limits (not just per-IP) for authenticated endpoints
- Distributed rate limiting with Redis for multi-instance deployments

---

## 🛠️ Developer Experience

### API Client Library
- Type-safe JavaScript/TypeScript SDK for the CoLearn API
- Published to npm

### OpenAPI / Swagger Documentation
- Auto-generated from route definitions
- Interactive API explorer at `/api/docs`

### Integration Tests
- Automated end-to-end test suite using Playwright or Cypress
- CI test runs on every pull request

### Docker Support
- `Dockerfile` for the backend
- `docker-compose.yml` for local development (Node + mock Firebase)

### Health Dashboard
- Detailed `/api/health` endpoint with Firebase connection status, SMTP status, Drive configuration status
- Uptime monitoring integration (UptimeRobot, BetterUptime)

---

## 🌐 Internationalization

### Multi-Language Support
- i18n via a lightweight message catalog
- Initial languages: English, Spanish, French, German
- User-selectable language preference

---

## 📊 Analytics (Privacy-Respecting)

### Self-Hosted Usage Analytics
- Simple event tracking (suite created, files uploaded, sessions started)
- No third-party trackers
- Aggregated-only, no individual tracking
