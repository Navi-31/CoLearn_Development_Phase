# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.0.x   | ✅ Yes    |

---

## Reporting a Vulnerability

**Do not report security vulnerabilities via public GitHub issues.**

If you discover a security vulnerability in CoLearn, please follow responsible disclosure:

1. **Email us** at the address listed in the repository owner's GitHub profile, with subject: `[CoLearn Security] Brief description`
2. **Describe the vulnerability** clearly: what it affects, how to reproduce it, and potential impact.
3. **Allow reasonable time** (7–14 days) for acknowledgment and a fix before public disclosure.
4. **Do not exploit** the vulnerability beyond what is necessary to demonstrate the issue.

We will acknowledge your report, investigate promptly, and credit you in the changelog if a fix is released.

---

## Secrets Policy

### What Must Never Be Committed to Git

| Type | File(s) | Status |
|------|---------|--------|
| Firebase Admin SDK private key | `backend/config/serviceAccountKey.json` | ❌ **Never commit** |
| SMTP credentials | `backend/.env`, `.env` | ❌ **Never commit** |
| Google OAuth client secret | `backend/.env` | ❌ **Never commit** |
| Firebase API key | `backend/.env` | ❌ **Never commit** |
| Google refresh tokens | Any file | ❌ **Never commit** |
| Database passwords | Any file | ❌ **Never commit** |

All of the above are covered by `.gitignore`.

### Safe to Commit

| Type | File | Notes |
|------|------|-------|
| Example env templates | `backend/.env.example` | Placeholder values only |
| Example env templates | `backend/.env.production.example` | Placeholder values only |
| Service account template | `backend/config/serviceAccountKey.example.json` | No real keys |

---

## Firebase Admin SDK Key Handling

### First-Time Setup
1. Go to [Firebase Console](https://console.firebase.google.com/) → Your Project → Project Settings → Service Accounts
2. Click **Generate new private key**
3. Download the JSON file
4. **Rename it** to `serviceAccountKey.json`
5. **Place it** at `backend/config/serviceAccountKey.json`
6. **Verify** it is gitignored: `git check-ignore -v backend/config/serviceAccountKey.json`

### If the Key Was Accidentally Committed

If `serviceAccountKey.json` was ever committed to your repository history:

1. **Immediately rotate the key**:
   - Firebase Console → Project Settings → Service Accounts → Delete the compromised key → Generate a new key
2. **Purge from git history** using [git-filter-repo](https://github.com/newren/git-filter-repo):
   ```bash
   pip install git-filter-repo
   git filter-repo --path backend/config/serviceAccountKey.json --invert-paths --force
   git push --force
   ```
   Or use [BFG Repo Cleaner](https://rtyley.github.io/bfg-repo-cleaner/):
   ```bash
   bfg --delete-files serviceAccountKey.json
   git push --force
   ```
3. **Notify collaborators** to re-clone the repository (force-pushed history changes all SHA hashes)

---

## SMTP Credentials

The application uses Gmail SMTP with an App Password (not your main Gmail password).

- App Passwords can be revoked at: [https://myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
- If compromised: revoke the app password and generate a new one, then update `backend/.env`

---

## Google OAuth Credentials

OAuth Client ID and Secret are stored in `backend/.env`.

- If compromised: revoke in [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials → Delete the OAuth client → Create a new one
- Update all authorized redirect URIs for the new client

---

## Credential Hygiene Checklist

Before any commit:

- [ ] `git status` — no `.env` files listed as staged
- [ ] `git status` — no `serviceAccountKey.json` listed
- [ ] No API keys hardcoded in source files
- [ ] No passwords hardcoded in source files
- [ ] `git diff --staged` reviewed for any accidentally included credentials

---

## Known Security Design Decisions

| Decision | Rationale |
|----------|-----------|
| OTPs stored as SHA-256 hashes | Never store plaintext OTPs |
| OTP TTL = 5 minutes | Limits brute-force window |
| Max OTP attempts = 5 | Rate-limits guessing |
| SMTP password never logged | Prevents credential leak in logs |
| `X-FS-UID` header for auth | Internal session identifier, validated server-side |
| Helmet middleware | Sets secure HTTP headers by default |
| CORS configured per origin | Prevents unauthorized cross-origin requests in production |
| Rate limiting on auth routes | Mitigates brute-force attacks |
| Input validation via express-validator | Prevents injection at the API boundary |
| Google Drive scoped to `drive.file` | App only accesses files it creates — not the user's entire Drive |
