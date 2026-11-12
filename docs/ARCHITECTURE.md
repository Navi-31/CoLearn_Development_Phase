# CoLearn — Architecture

This document describes the complete system architecture of CoLearn — how the frontend, backend, Firebase, Google Drive, SMTP, WebRTC, and SSE components communicate.

---

## High-Level Overview

CoLearn is a **single-server SPA architecture**: the Express backend both serves the frontend static files and provides all REST API endpoints. Real-time features are layered on top via WebRTC (peer-to-peer) and Firebase Firestore (cloud sync) with Server-Sent Events (SSE) for server-push member updates.

```mermaid
graph TB
    subgraph Browser["Browser (Client)"]
        SPA["SPA — index.html\nVanilla JS"]
        SDK["Firebase Client SDK\nAuth + Firestore"]
        WRT["WebRTC Engine\nP2P Video/Audio/Screen"]
    end

    subgraph Server["Express Server (backend/server.js)"]
        API["REST API\n/api/*"]
        STF["Static File Server\nfrontend/"]
        SSE["SSE Endpoint\n/api/suite/:id/members/stream"]
    end

    subgraph Firebase["Firebase (Google Cloud)"]
        FAUTH["Firebase Auth\nEmail/Password"]
        FST["Firestore\nUsers, Suites, Files, Notifications"]
        RTDB["Realtime DB\nScreen Share State"]
    end

    subgraph External["External Services"]
        GDR["Google Drive API\nOAuth2 + File Storage"]
        SMTP["Gmail SMTP\nOTP + Invite Emails"]
    end

    SPA -->|HTTP REST| API
    SPA -->|SSE connection| SSE
    SPA <-->|SDK calls| SDK
    SDK <-->|Auth tokens + Firestore| Firebase
    SPA <-->|WebRTC signaling via Firestore| WRT
    WRT <-->|P2P media streams| WRT
    API -->|Admin SDK| FAUTH
    API -->|Firestore writes| FST
    API -->|RTDB writes| RTDB
    API -->|OAuth2 token exchange + file ops| GDR
    API -->|SMTP send| SMTP
    STF -->|Serves| SPA
```

---

## Component Architecture

### Frontend (SPA)

The frontend is a **single-page application** built with pure HTML, CSS, and Vanilla JavaScript. There is no build step — the browser loads `frontend/index.html` and all JS modules.

```mermaid
graph TD
    subgraph Frontend["frontend/"]
        IDX["index.html — SPA shell"]
        RTR["router.js — View navigation"]
        
        subgraph Views["js/views/"]
            LGN["login.js"]
            SGN["signup.js"]
            FGT["forgot.js"]
            DSH["dashboard.js"]
            WSP["workspace.js"]
        end
        
        subgraph Modules["js/ — Shared Modules"]
            API2["api.js — fetch() wrappers"]
            CFG["config.js — API_BASE, constants"]
            FBC["firebase-client.js — Client SDK init"]
            STA["state.js — Global app state"]
            UTL["utils.js — Toast, modal, alerts"]
        end
        
        subgraph Features["js/ — Feature Modules"]
            WBD["whiteboard.js — Canvas engine"]
            VID["video-call.js — WebRTC video"]
            SCR["screen-share.js — WebRTC screen"]
            CHT["private-chat.js — DM system"]
            INV["invite.js — Invite flow"]
            NTF["notifications.js — Bell + badge"]
            DOC["document-service.js — Drive viewer"]
            WBM["webrtc-manager.js — Peer connections"]
        end

        IDX --> RTR
        RTR --> Views
        Views --> Modules
        Views --> Features
    end
```

**View Routing:** The router intercepts hash changes (`#login`, `#dashboard`, `#workspace`, etc.) and renders the appropriate view without a page reload.

**State Management:** `state.js` holds the global mutable state (current user, active suite, WebRTC peers) as a plain JS object, shared across modules.

**Firebase Client SDK:** Used directly in the browser for:
- Listening to Firestore document changes (whiteboard sync, screen share state)
- Getting ID tokens for authenticated API calls
- Real-time notification updates

---

### Backend (Express Server)

```mermaid
graph TD
    subgraph Backend["backend/"]
        SRV["server.js — Entry point"]
        
        subgraph Middleware["middleware/"]
            HLM["helmet — Security headers"]
            CRS["CORS — Origin whitelist"]
            RLM["rate-limit — Per-endpoint limits"]
            RAU["requireAuth.js — UID validation"]
            EHN["errorHandler.js — Global error handler"]
        end

        subgraph Routes["routes/"]
            RAT["auth.js — /api/auth/* + /api/suites/*"]
            RDR["drive.js — /api/drive/*"]
            RIN["invite.js — /api/invite/* + SSE"]
            RST["suite.js — /api/suite/*"]
        end

        subgraph Controllers["controllers/"]
            CAT["authController.js — Register, Login, OTP, Suite CRUD"]
            CDC["driveController.js — Drive OAuth + File ops"]
            CIN["inviteController.js — Invite generation + Suite join"]
        end

        subgraph Services["services/"]
            SEM["emailService.js — HTML email templates"]
            SDA["driveAuthService.js — OAuth2 token management"]
            SDS["driveService.js — Drive folder/file/permission ops"]
        end

        subgraph Models["models/"]
            MST["store.js — In-memory OTP store (SHA-256 hashed)"]
            MIN["inviteStore.js — In-memory invite + SSE client registry"]
        end

        subgraph Config["config/"]
            CFB["firebase.js — Admin SDK init + warmup"]
            CEM["email.js — Nodemailer transporter"]
        end

        SRV --> Middleware
        SRV --> Routes
        Routes --> Controllers
        Controllers --> Services
        Controllers --> Models
        Controllers --> Config
    end
```

**Startup Sequence:**
1. Load `.env` via `dotenv`
2. Initialize Nodemailer SMTP transporter
3. Initialize Firebase Admin SDK (loads `serviceAccountKey.json`)
4. Warm up Firebase Auth token (prefetch access token)
5. Register middleware (Helmet, CORS, JSON body parser, rate limiters)
6. Mount routes
7. Serve static frontend files from `../frontend`
8. Start HTTP server on `0.0.0.0:PORT`

---

### Authentication Flow

```mermaid
sequenceDiagram
    participant B as Browser
    participant E as Express
    participant F as Firebase Auth
    participant FS as Firestore

    Note over B,FS: Signup Flow
    B->>E: POST /send-otp { email }
    E->>B: { success: true }
    Note over E: OTP stored as SHA-256 in memory, TTL 5min
    B->>E: POST /verify-otp { email, otp }
    E->>B: { success: true }
    B->>E: POST /auth/register { name, username, email, password }
    E->>F: admin.createUser()
    F-->>E: uid
    E->>FS: users.doc(uid).set(profile)
    E->>B: { success: true, uid }

    Note over B,FS: Login Flow
    B->>E: POST /auth/login { email, password }
    E->>F: signInWithPassword (REST API)
    F-->>E: { uid, idToken }
    E->>FS: users.doc(uid).get()
    E->>B: { success: true, uid, name, username }
    
    Note over B,FS: Session — Every subsequent request
    B->>E: Any protected route + uid in body/header
    E->>F: admin.getUser(uid) [requireAuth middleware]
    F-->>E: userRecord (or 401/403)
    E->>B: Route response
```

---

### Google Drive OAuth Flow

CoLearn uses **one Google Cloud OAuth client for the entire app**. Each user individually authorizes their own Google Drive — this is the same architecture as Notion, Slack, and Canva.

```mermaid
sequenceDiagram
    participant B as Browser (Popup)
    participant E as Express
    participant G as Google OAuth
    participant FS as Firestore

    B->>E: GET /api/drive/auth-url (uid in header)
    E->>B: { url: "https://accounts.google.com/o/oauth2/auth?state=uid&..." }
    B->>B: window.open(url) — opens popup
    B->>G: User sees consent screen
    G->>E: GET /api/drive/callback?code=...&state=uid
    E->>G: Exchange code for { access_token, refresh_token }
    E->>FS: driveTokens.doc(uid).set({ refreshToken, email, ... })
    E->>B: Popup renders "✅ Connected" + window.close()
    B->>B: postMessage received — UI updates
```

**Token Storage:** OAuth refresh tokens are stored in Firestore (`driveTokens` collection, keyed by UID). Access tokens are obtained on-demand by refreshing the stored refresh token.

**Drive Scope:** `https://www.googleapis.com/auth/drive.file` — the app can only access files it created. It cannot access the user's existing Drive files.

---

### File Upload Flow

```mermaid
sequenceDiagram
    participant B as Browser
    participant E as Express
    participant GD as Google Drive
    participant FS as Firestore
    participant SSE as SSE Clients

    B->>E: POST /api/drive/upload (multipart, uid + suiteId + file)
    E->>FS: Verify user is suite member
    E->>FS: Get/refresh Drive access token for uid
    E->>GD: Get or create suite folder
    E->>GD: Upload file buffer → driveFileId
    E->>GD: Grant read permissions to all suite member emails
    E->>FS: suites/{suiteId}/files.add(metadata)
    E->>SSE: Broadcast { type: 'file_added', file: {...} }
    E->>B: { success: true, file: { driveWebViewLink, driveEmbedUrl, ... } }
```

---

### WebRTC Architecture

WebRTC peer connections are managed **entirely client-side** using Firebase Firestore as the signaling channel. The backend has no involvement in the WebRTC handshake.

```mermaid
graph LR
    subgraph Suite["Suite (e.g., 3 members)"]
        A["User A\nwebrtc-manager.js"]
        B["User B\nwebrtc-manager.js"]
        C["User C\nwebrtc-manager.js"]
    end

    subgraph Firestore["Firestore — Signaling"]
        OFR["offers/{suiteId}"]
        ANS["answers/{suiteId}"]
        ICE["iceCandidates/{suiteId}"]
    end

    A -->|Write offer| OFR
    B -->|Read offer, write answer| OFR
    B -->|Write answer| ANS
    A -->|Read answer| ANS
    A <-->|ICE candidates| ICE
    B <-->|ICE candidates| ICE
    A <-->|P2P: video/audio/screen| B
    A <-->|P2P: video/audio/screen| C
    B <-->|P2P: video/audio/screen| C
```

Each pair of users establishes a separate RTCPeerConnection. With N members, there are N×(N-1)/2 peer connections.

---

### Whiteboard Architecture

The whiteboard uses an HTML5 `<canvas>` element. Drawing state is **not currently persisted** — it is local to the session.

```mermaid
graph LR
    WB["whiteboard.js\nCanvas drawing engine"]
    TOOL["Tool bar\nPen / Eraser / Color / Size"]
    PAGE["Page nav\nMulti-page support"]
    SAVE["Save PNG\ntoDataURL()"]
    WB --> TOOL
    WB --> PAGE
    WB --> SAVE
```

Future: Persistent whiteboard sync via Firebase Realtime Database or CRDT.

---

### Server-Sent Events (SSE)

SSE provides **server-push member list updates** without polling.

```mermaid
sequenceDiagram
    participant C1 as Client (User A)
    participant C2 as Client (User B)
    participant E as Express SSE

    C1->>E: GET /api/suite/:id/members/stream
    Note over E: Registers C1 in inviteStore.sseClients Map
    E->>C1: data: { type: "members", members: [...] }
    
    C2->>E: POST /api/suite/join { uid, suiteId }
    Note over E: Updates Firestore, then broadcasts
    E->>C1: data: { type: "members", members: [...updated...] }
    
    loop Every 25s
        E->>C1: : heartbeat
    end

    Note over C1: Browser closes tab
    C1--xE: Connection closed
    Note over E: Removes C1 from sseClients
```

**In-memory SSE store:** `inviteStore.sseClients` is a `Map<suiteId, Set<Response>>` — each entry holds the active `res` objects for all connected clients watching that suite.

---

### Notification System

Notifications are stored in Firestore and read by the Firebase Client SDK in real-time.

```mermaid
graph LR
    subgraph Firestore["Firestore"]
        NC["notifications/{uid}/items\n{type, title, body, read, timestamp}"]
    end
    
    subgraph Backend["Backend"]
        SJ["joinSuite → writes notification\nto removed member"]
        SD["deleteSuite → writes notification\nto all members"]
    end

    subgraph Frontend["Frontend"]
        NF["notifications.js\nonSnapshot listener"]
        BL["Bell icon + unread badge count"]
    end

    Backend -->|write| NC
    NC -->|real-time snapshot| NF
    NF --> BL
```

---

## Data Model (Firestore)

### `users/{uid}`
```
{
  name: string,
  username: string,
  email: string,
  createdAt: timestamp
}
```

### `suites/{suiteId}`
```
{
  name: string,
  ownerUid: string,
  type: "permanent" | "quick",
  members: [{ uid, name, username, isHost, joinedAt }],
  memberUids: string[],
  createdAt: timestamp,
  updatedAt: timestamp
}
```

### `suites/{suiteId}/files/{fileId}`
```
{
  driveFileId: string,
  driveFolderId: string,
  fileName: string,
  mimeType: string,
  fileSize: number,
  uploadedAt: timestamp,
  ownerUid: string,
  ownerEmail: string,
  uploadedByName: string,
  driveWebViewLink: string,
  driveDownloadLink: string,
  driveEmbedUrl: string,
  permissionIds: { [email]: permissionId }
}
```

### `driveTokens/{uid}`
```
{
  refreshToken: string,
  email: string,
  connectedAt: timestamp
}
```

### `notifications/{uid}/items/{notifId}`
```
{
  type: string,
  title: string,
  body: string,
  icon: string,
  data: object,
  timestamp: timestamp,
  read: boolean
}
```

### `screenSharing/{suiteId}`
```
{
  isSharing: boolean,
  presenterUid: string,
  presenterName: string,
  startedAt: timestamp,
  suiteId: string
}
```

---

## Security Architecture

| Layer | Mechanism |
|-------|-----------|
| HTTP Headers | Helmet (X-Frame-Options, CSP, HSTS, etc.) |
| CORS | Explicit origin allowlist via `ALLOWED_ORIGINS` env var |
| Authentication | Firebase Admin SDK `getUser(uid)` on every protected route |
| Rate limiting | Per-endpoint express-rate-limit (5–200 req/window) |
| Input validation | express-validator on auth routes |
| OTP security | SHA-256 hashed, 5-min TTL, max 5 attempts |
| Drive scope | `drive.file` only — cannot access user's existing files |
| Secrets | All credentials gitignored, loaded via environment variables |
| Firebase rules | Firestore security rules enforce per-user data isolation |
