# Contributing to CoLearn

Thank you for your interest in contributing to **CoLearn**! 🎉  
We welcome bug reports, feature suggestions, code improvements, and documentation updates.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Branch Naming](#branch-naming)
- [Commit Style](#commit-style)
- [Pull Request Guidelines](#pull-request-guidelines)
- [Coding Conventions](#coding-conventions)
- [Security Vulnerabilities](#security-vulnerabilities)

---

## Code of Conduct

Be respectful, inclusive, and constructive. We follow the [Contributor Covenant](https://www.contributor-covenant.org/).

---

## Getting Started

1. **Fork** the repository on GitHub.
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/your-username/colearn.git
   cd colearn
   ```
3. **Install dependencies**:
   ```bash
   cd backend && npm install
   ```
4. **Set up environment**:
   ```bash
   cp backend/.env.example backend/.env
   # Fill in your Firebase, SMTP, and Google OAuth credentials
   cp backend/config/serviceAccountKey.example.json backend/config/serviceAccountKey.json
   # Replace placeholder values with your real Firebase Admin SDK key
   ```
5. **Start the backend**:
   ```bash
   npm run backend
   # or: cd backend && npm run dev
   ```
6. Open `http://localhost:3000` in your browser.

---

## Branch Naming

Use the following prefixes:

| Prefix      | Purpose                         | Example                         |
|-------------|----------------------------------|----------------------------------|
| `feat/`     | New feature                     | `feat/persistent-whiteboard`    |
| `fix/`      | Bug fix                         | `fix/otp-timer-reset`           |
| `docs/`     | Documentation only              | `docs/update-readme`            |
| `refactor/` | Code cleanup, no behaviour change | `refactor/email-service`       |
| `chore/`    | Build scripts, config, CI       | `chore/update-dependencies`     |
| `test/`     | Add or fix tests                | `test/invite-controller`        |

---

## Commit Style

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(scope): short description

Optional longer description.

Closes #issue-number
```

**Examples:**
```
feat(drive): add per-suite folder creation on first upload
fix(otp): clear stale OTP store entry after max attempts
docs(readme): add Firebase setup instructions
refactor(auth): extract password strength validator to shared util
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `style`, `perf`

---

## Pull Request Guidelines

1. **Open an issue first** for significant changes so we can discuss the approach.
2. **Keep PRs focused** — one feature or fix per PR.
3. **Write a clear description** explaining what changed and why.
4. **Test manually** — verify the feature works end-to-end before submitting.
5. **Do not commit secrets** — no `.env` files, no `serviceAccountKey.json`, no API keys.
6. **Do not break existing APIs** without discussion and a migration plan.

### PR Checklist

- [ ] Code follows the project's style (2-space indent, `'use strict'`, meaningful variable names)
- [ ] No hardcoded credentials or API keys
- [ ] No `console.log` left for debug-only purposes (use `console.warn` / `console.error` for real issues)
- [ ] Backend routes are tested with Postman or equivalent
- [ ] Frontend changes tested in Chrome (primary) and at least one other browser
- [ ] README updated if any public-facing behaviour changed

---

## Coding Conventions

### JavaScript (Backend — Node.js / Express)
- `'use strict'` at the top of every file
- 2-space indentation
- Use `const` by default; `let` only when reassignment is necessary
- Async/await over raw Promises where possible
- Always handle errors explicitly — never swallow exceptions silently
- Input validation at the route/controller level
- Comments on non-obvious logic; no comments repeating what the code already says

### JavaScript (Frontend — Vanilla)
- Global functions attached to `window` via the module pattern
- No framework — plain ES6+ Vanilla JS
- Keep view logic in `js/views/`, shared utilities in `js/utils.js`
- Avoid inline event handlers in HTML where possible

### File Structure
- Backend: feature-grouped by `routes/`, `controllers/`, `services/`, `models/`, `middleware/`
- Frontend: `js/views/` for page-level logic, `js/` for shared modules

---

## Security Vulnerabilities

**Do not open a public GitHub issue for security vulnerabilities.**

Please read [SECURITY.md](./SECURITY.md) and follow the responsible disclosure process.
