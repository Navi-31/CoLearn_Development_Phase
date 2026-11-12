# CoLearn — API Reference

> **Base URL (local):** `http://localhost:3000/api`  
> **Base URL (production):** `https://yourdomain.com/api`

---

## Authentication

All **protected endpoints** require a valid Firebase user UID sent via **one of the following** (checked in priority order):

| Method | Key | Example |
|--------|-----|---------|
| Request body | `uid` | `{ "uid": "abc123..." }` |
| Query string | `uid` | `?uid=abc123...` |
| HTTP Header | `X-FS-UID` | `X-FS-UID: abc123...` |

The server validates the UID against Firebase Auth (checks user exists and is not disabled). If invalid, returns `401`.

---

## Rate Limiting

All endpoints are rate-limited. Exceeding the limit returns:

```json
HTTP 429
{ "success": false, "error": "Too many requests. Please wait 15 minutes and try again." }
```

| Limiter | Window | Max Requests | Applied To |
|---------|--------|-------------|-----------|
| `authLimiter` | 15 min | 10 | Login |
| `strictLimiter` | 15 min | 5 | Register, Reset Password |
| `otpLimiter` | 15 min | 10 | Send OTP |
| `workspaceReadLimiter` | 15 min | 200 | GET suites, tokens |
| `workspaceWriteLimiter` | 15 min | 100 | POST/DELETE suites |
| `inviteSendLimiter` | 15 min | 20 | Invite send/generate |
| `inviteValidateLimiter` | 5 min | 30 | Invite validate |
| `joinLimiter` | 5 min | 20 | Suite join |
| `driveReadLimiter` | 15 min | 200 | Drive status, list files |
| `driveUploadLimiter` | 15 min | 60 | Upload, delete, permissions |
| `driveAuthLimiter` | 15 min | 10 | Drive auth URL, callback |

---

## Health

### `GET /health`

Check if the backend is running.

**Authentication:** None

**Response:**
```json
{
  "status": "ok",
  "uptime": 1234.56,
  "timestamp": "2025-07-19T00:00:00.000Z"
}
```

---

## OTP — Signup Flow

### `POST /send-otp`

Send a 6-digit OTP to the given email address for account verification during signup.

**Authentication:** None  
**Rate limit:** `otpLimiter` (10 / 15 min)

**Request Body:**
```json
{ "email": "user@example.com" }
```

**Response — Success:**
```json
{ "success": true, "message": "OTP sent to user@example.com" }
```

**Response — Error:**
```json
{ "success": false, "error": "Email is required." }
{ "success": false, "error": "Please provide a valid email address." }
```

> **Note:** OTPs are stored as SHA-256 hashes in memory with a 5-minute TTL. Plaintext OTPs are never stored.

---

### `POST /verify-otp`

Verify a 6-digit signup OTP.

**Authentication:** None

**Request Body:**
```json
{ "email": "user@example.com", "otp": "123456" }
```

**Response — Success:**
```json
{ "success": true, "message": "OTP verified successfully." }
```

**Response — Error:**
```json
{ "success": false, "error": "Invalid or expired OTP." }
{ "success": false, "error": "Maximum OTP attempts exceeded. Please request a new OTP." }
```

---

## Authentication

### `POST /auth/register`

Register a new user account. Requires OTP to have been verified first.

**Authentication:** None  
**Rate limit:** `strictLimiter` (5 / 15 min)

**Request Body:**
```json
{
  "name": "Jane Smith",
  "username": "janesmith",
  "email": "jane@example.com",
  "password": "SecurePass123!"
}
```

**Validation Rules:**
- `name`: Required, max 100 characters
- `username`: Required, 3–30 characters, letters/numbers/underscores only
- `email`: Valid email format
- `password`: Required (minimum length enforced by Firebase)

**Response — Success:**
```json
{
  "success": true,
  "message": "Account created successfully.",
  "uid": "firebase-user-uid"
}
```

**Response — Errors:**
```json
{ "success": false, "error": "Username already taken." }
{ "success": false, "error": "An account with this email already exists." }
{ "success": false, "errors": [{ "msg": "Username must be 3–30 characters.", "path": "username" }] }
```

---

### `POST /auth/login`

Authenticate a user via Firebase REST API and return a session UID.

**Authentication:** None  
**Rate limit:** `authLimiter` (10 / 15 min)

**Request Body:**
```json
{
  "email": "jane@example.com",
  "password": "SecurePass123!"
}
```

**Response — Success:**
```json
{
  "success": true,
  "uid": "firebase-user-uid",
  "name": "Jane Smith",
  "username": "janesmith",
  "email": "jane@example.com"
}
```

**Response — Errors:**
```json
{ "success": false, "error": "Invalid email or password." }
{ "success": false, "error": "Please verify your email address before logging in." }
{ "success": false, "error": "Your account has been disabled." }
```

---

### `POST /auth/token`

Generate a short-lived Firebase Custom Token so the frontend Client SDK can sign into Firestore and RTDB with security rules.

**Authentication:** Required (UID in body/header)  
**Rate limit:** `workspaceReadLimiter` (200 / 15 min)

**Request Body:**
```json
{ "uid": "firebase-user-uid" }
```

**Response — Success:**
```json
{
  "success": true,
  "customToken": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

---

## Password Reset

### `POST /auth/send-reset-otp`

Step 1 of 3: Send a password reset OTP to the given email.

**Authentication:** None  
**Rate limit:** `strictLimiter` (5 / 15 min)

**Request Body:**
```json
{ "email": "jane@example.com" }
```

**Response — Success:**
```json
{ "success": true, "message": "Reset OTP sent to jane@example.com" }
```

**Response — Error:**
```json
{ "success": false, "error": "No account found with this email." }
```

---

### `POST /auth/verify-reset-otp`

Step 2 of 3: Verify the 6-digit reset OTP. Returns a short-lived `resetToken` for the final step.

**Authentication:** None  
**Rate limit:** `authLimiter` (10 / 15 min)

**Request Body:**
```json
{ "email": "jane@example.com", "otp": "654321" }
```

**Response — Success:**
```json
{
  "success": true,
  "resetToken": "base64-encoded-short-lived-token",
  "message": "OTP verified. Proceed to set your new password."
}
```

**Response — Error:**
```json
{ "success": false, "error": "Invalid or expired OTP." }
```

---

### `POST /auth/reset-password`

Step 3 of 3: Set a new password using the `resetToken` from step 2.

**Authentication:** None  
**Rate limit:** `strictLimiter` (5 / 15 min)

**Request Body:**
```json
{
  "email": "jane@example.com",
  "resetToken": "base64-encoded-short-lived-token",
  "newPassword": "NewSecurePass456!"
}
```

**Response — Success:**
```json
{ "success": true, "message": "Password reset successfully." }
```

**Response — Error:**
```json
{ "success": false, "error": "Invalid or expired reset token." }
{ "success": false, "error": "Password must be at least 8 characters." }
```

---

## Suites

### `GET /suites`

Get all suites the authenticated user is a member of or owns.

**Authentication:** Required  
**Rate limit:** `workspaceReadLimiter` (200 / 15 min)

**Query Params:** `?uid=<uid>` (or in body/header)

**Response — Success:**
```json
{
  "success": true,
  "suites": [
    {
      "id": "suite-firestore-id",
      "name": "Study Group A",
      "ownerUid": "uid",
      "type": "permanent",
      "members": [...],
      "memberUids": ["uid1", "uid2"],
      "createdAt": "2025-07-19T00:00:00.000Z"
    }
  ]
}
```

---

### `GET /suites/:id`

Get a specific suite by ID.

**Authentication:** Required  
**Rate limit:** `workspaceReadLimiter`

**Response — Success:**
```json
{
  "success": true,
  "suite": { "id": "...", "name": "...", ... }
}
```

**Response — Error:**
```json
{ "success": false, "error": "Suite not found." }
{ "success": false, "error": "Access denied." }
```

---

### `POST /suites`

Create a new suite.

**Authentication:** Required  
**Rate limit:** `workspaceWriteLimiter` (100 / 15 min)

**Request Body:**
```json
{
  "uid": "firebase-user-uid",
  "name": "My Study Suite",
  "type": "permanent"
}
```

**Response — Success:**
```json
{
  "success": true,
  "suite": {
    "id": "suite-firestore-id",
    "name": "My Study Suite",
    "ownerUid": "firebase-user-uid",
    "type": "permanent",
    "createdAt": "2025-07-19T00:00:00.000Z"
  }
}
```

---

### `DELETE /suites/:id`

Delete a suite. Only the suite owner (host) can delete.

**Authentication:** Required  
**Rate limit:** `workspaceWriteLimiter`

**Query/Body:** `uid` (required)

**Response — Success:**
```json
{ "success": true, "message": "Suite deleted." }
```

**Response — Error:**
```json
{ "success": false, "error": "Only the suite owner can delete this suite." }
{ "success": false, "error": "Suite not found." }
```

---

### `GET /suite/:suiteId` *(from suite router)*

Get suite details. Returns full suite object including members array.

**Authentication:** Required (via `X-FS-UID` header)

**Response:**
```json
{
  "success": true,
  "suite": { "id": "...", "name": "...", "members": [...], ... }
}
```

---

### `GET /suite/:suiteId/members`

Get the current member list with user profiles.

**Authentication:** Required

**Response:**
```json
{
  "success": true,
  "members": [
    { "uid": "...", "name": "Jane", "username": "janesmith", "isHost": true }
  ]
}
```

---

### `DELETE /suite/:suiteId/members/:memberId`

Remove a member from a suite. Only the host can do this.

**Authentication:** Required (host UID via `X-FS-UID`)

**Response — Success:**
```json
{ "success": true, "message": "Member removed from suite." }
```

---

### `POST /suite/:suiteId/screen-share`

Update the screen-sharing state for a suite.

**Authentication:** Required

**Request Body:**
```json
{
  "presenterUid": "uid",
  "presenterName": "Jane",
  "action": "start"
}
```

`action` must be `"start"` or `"stop"`.

**Response:**
```json
{ "success": true }
```

---

## Invitations

### `POST /invite/send`

Generate an invite and send it by email. Only the suite host may call this.

**Authentication:** Required  
**Rate limit:** `inviteSendLimiter` (20 / 15 min)

**Request Body:**
```json
{
  "uid": "host-uid",
  "suiteId": "suite-firestore-id",
  "email": "invitee@example.com"
}
```

**Response — Success:**
```json
{
  "success": true,
  "inviteCode": "84291",
  "inviteUrl": "https://colearn.app/invite/abc123token"
}
```

**Response — Warning (email failed, invite generated):**
```json
{
  "success": true,
  "warning": "Invite generated but email delivery failed. Share the code/link manually.",
  "inviteCode": "84291",
  "inviteUrl": "https://colearn.app/invite/abc123token"
}
```

---

### `POST /invite/generate`

Generate an invite code + link without sending email.

**Authentication:** Required  
**Rate limit:** `inviteSendLimiter`

**Request Body:**
```json
{ "uid": "host-uid", "suiteId": "suite-firestore-id" }
```

**Response:**
```json
{
  "success": true,
  "inviteCode": "84291",
  "inviteUrl": "https://colearn.app/invite/abc123token"
}
```

---

### `POST /invite/code`

Validate a 5-digit invite code. Public endpoint (no auth needed — called before login).

**Authentication:** None  
**Rate limit:** `inviteValidateLimiter` (30 / 5 min)

**Request Body:**
```json
{ "code": "84291" }
```

**Response — Success:**
```json
{
  "success": true,
  "suiteId": "suite-firestore-id",
  "suiteName": "Study Group A"
}
```

**Response — Error:**
```json
{ "success": false, "error": "This invite code is invalid or has expired." }
```

---

### `POST /invite/link`

Validate an invite token from a URL link.

**Authentication:** None  
**Rate limit:** `inviteValidateLimiter`

**Request Body:**
```json
{ "token": "abc123token" }
```

**Response:**
```json
{
  "success": true,
  "suiteId": "suite-firestore-id",
  "suiteName": "Study Group A"
}
```

---

### `POST /suite/join`

Join a suite (adds user to Firestore members list, grants Drive access).

**Authentication:** Required  
**Rate limit:** `joinLimiter` (20 / 5 min)

**Request Body:**
```json
{ "uid": "user-uid", "suiteId": "suite-firestore-id" }
```

**Response — Success:**
```json
{
  "success": true,
  "suite": { "id": "...", "name": "...", "members": [...] },
  "member": { "uid": "...", "name": "Jane", "username": "janesmith", "isHost": false, "joinedAt": "..." }
}
```

**Response — Error:**
```json
{ "success": false, "error": "You're already a member of this suite." }
{ "success": false, "error": "Suite not found." }
```

---

### `POST /invite/invalidate`

Invalidate all active invites for a host (called when host goes offline/logs out).

**Authentication:** Required  
**Rate limit:** `inviteSendLimiter`

**Request Body:**
```json
{ "uid": "host-uid" }
```

**Response:**
```json
{ "success": true, "invalidated": 2 }
```

---

### `GET /suite/:id/members/stream`

**Server-Sent Events (SSE)** — Subscribe to real-time member list updates for a suite.

**Authentication:** None (public SSE stream; suite ID scoped)

**Response:** `Content-Type: text/event-stream`

On connect, immediately sends the current member list:
```
data: {"type":"members","members":[...]}

```

On member join/leave, sends updated list:
```
data: {"type":"members","members":[...]}

```

Heartbeat every 25 seconds:
```
: heartbeat

```

---

## Google Drive

### `GET /drive/status`

Check if the authenticated user has Google Drive connected.

**Authentication:** Required  
**Rate limit:** `driveReadLimiter`

**Response — Connected:**
```json
{
  "success": true,
  "connected": true,
  "email": "user@gmail.com",
  "connectedAt": "2025-07-19T00:00:00.000Z"
}
```

**Response — Not connected:**
```json
{ "success": true, "connected": false }
```

---

### `GET /drive/auth-url`

Get the Google OAuth2 consent URL to connect Drive. The frontend opens this in a popup.

**Authentication:** Required  
**Rate limit:** `driveAuthLimiter` (10 / 15 min)

**Response:**
```json
{
  "success": true,
  "url": "https://accounts.google.com/o/oauth2/auth?client_id=..."
}
```

**Response — Drive not configured:**
```json
{
  "success": false,
  "error": "DRIVE_NOT_CONFIGURED",
  "message": "Google Drive credentials are not configured..."
}
```

---

### `GET /drive/callback`

OAuth2 callback from Google. Exchanges the authorization code for tokens.

**Authentication:** None (UID is passed via the OAuth `state` parameter)  
**Rate limit:** `driveAuthLimiter`

> This endpoint is called by Google's OAuth redirect — not directly by the frontend.  
> It renders an HTML page that sends a `postMessage` to the opener window and closes the popup.

**Query Params:** `code`, `state` (uid), `error` (if user denied)

**Response:** HTML page (self-closing popup)

---

### `POST /drive/disconnect`

Revoke the user's Google Drive access and delete stored tokens.

**Authentication:** Required  
**Rate limit:** `driveAuthLimiter`

**Request Body:** `{ "uid": "user-uid" }`

**Response:**
```json
{ "success": true, "message": "Google Drive disconnected." }
```

---

### `POST /drive/upload`

Upload a file to the user's Google Drive into the suite's dedicated folder.

**Authentication:** Required  
**Rate limit:** `driveUploadLimiter` (60 / 15 min)  
**Content-Type:** `multipart/form-data`  
**Max file size:** 200 MB

**Form Fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | File | Yes | The file to upload |
| `uid` | string | Yes | Uploader's Firebase UID |
| `suiteId` | string | Yes | Suite ID (determines Drive folder) |

**Request Header (optional):**
```
X-Duplicate-Action: keep_both | replace
```
- `keep_both` (default): auto-renames duplicate files
- `replace`: deletes the existing file and replaces it

**Response — Success (201):**
```json
{
  "success": true,
  "file": {
    "id": "firestore-doc-id",
    "driveFileId": "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2",
    "fileName": "report.pdf",
    "mimeType": "application/pdf",
    "fileSize": 204800,
    "uploadedAt": "2025-07-19T00:00:00.000Z",
    "uploadedByName": "Jane Smith",
    "driveWebViewLink": "https://drive.google.com/file/d/.../view",
    "driveDownloadLink": "https://drive.google.com/uc?export=download&id=...",
    "driveEmbedUrl": "https://drive.google.com/file/d/.../preview",
    "suiteId": "suite-id",
    "ownerUid": "user-uid",
    "ownerEmail": "jane@gmail.com"
  }
}
```

**Response — Drive not connected:**
```json
{
  "success": false,
  "error": "DRIVE_NOT_CONNECTED",
  "message": "Please connect your Google Drive before uploading."
}
```

---

### `GET /drive/files/:suiteId`

List all files for a suite (ordered by upload date descending, max 100).

**Authentication:** Required  
**Rate limit:** `driveReadLimiter`

**Response:**
```json
{
  "success": true,
  "files": [
    {
      "id": "firestore-doc-id",
      "fileName": "notes.pdf",
      "mimeType": "application/pdf",
      "fileSize": 102400,
      "uploadedAt": "2025-07-19T00:00:00.000Z",
      "driveWebViewLink": "...",
      "driveEmbedUrl": "..."
    }
  ]
}
```

---

### `DELETE /drive/files/:fileId`

Delete a file from Drive and remove its Firestore metadata. Only file owner or suite host may delete.

**Authentication:** Required  
**Rate limit:** `driveUploadLimiter`

**Query/Body:** `suiteId` (required)

**Response:**
```json
{ "success": true, "message": "File deleted." }
```

**Response — Error:**
```json
{ "success": false, "error": "Only the file owner or suite host can delete files." }
```

---

### `POST /drive/grant-member`

Grant a newly joined member read access to all existing suite Drive files.

> This is called automatically when a user joins a suite. No manual call needed.

**Authentication:** Required (suite host UID)  
**Rate limit:** `driveUploadLimiter`

**Request Body:**
```json
{
  "uid": "host-uid",
  "suiteId": "suite-firestore-id",
  "memberEmail": "newmember@gmail.com"
}
```

**Response:**
```json
{ "success": true, "granted": 3 }
```

---

### `POST /drive/revoke-member`

Revoke a removed member's Drive access from all suite files.

> This is called automatically when the host removes a member. No manual call needed.

**Authentication:** Required (suite host UID)  
**Rate limit:** `driveUploadLimiter`

**Request Body:**
```json
{
  "uid": "host-uid",
  "suiteId": "suite-firestore-id",
  "memberEmail": "removed@gmail.com"
}
```

**Response:**
```json
{ "success": true, "revoked": 3 }
```

---

## Error Response Format

All API errors follow a consistent format:

```json
{
  "success": false,
  "error": "Human-readable error message."
}
```

Validation errors (from `express-validator`) return:

```json
{
  "success": false,
  "errors": [
    { "msg": "Username must be 3–30 characters.", "path": "username" }
  ]
}
```

## HTTP Status Codes

| Code | Meaning |
|------|---------|
| `200` | Success |
| `201` | Created (file upload) |
| `400` | Bad Request — missing or invalid parameters |
| `401` | Unauthorized — missing or invalid UID |
| `403` | Forbidden — authenticated but not authorized |
| `404` | Not Found — resource doesn't exist |
| `409` | Conflict — e.g., already a suite member |
| `429` | Too Many Requests — rate limit exceeded |
| `500` | Internal Server Error |
| `503` | Service Unavailable — dependency not configured |
