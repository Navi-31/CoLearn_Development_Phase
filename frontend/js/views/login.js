/* ── VIEW 1 – Login ──────────────────────────────────────────── */

/* ── Password Reveal Toggle (Issue 1) ────────────────────────── */
/**
 * Toggles the login password field between type="password" and type="text".
 * Preserves the entered value and cursor position.
 * Does NOT trigger login or reset validation state.
 */
function toggleLoginPassword() {
  const input      = document.getElementById('login-password');
  const eyeIcon    = document.getElementById('login-eye-icon');
  const eyeOffIcon = document.getElementById('login-eye-off-icon');
  const btn        = document.getElementById('login-pw-toggle');

  if (!input) return;

  // Save cursor position (selectionStart/End are lost on type change in some browsers)
  const selStart = input.selectionStart;
  const selEnd   = input.selectionEnd;

  if (input.type === 'password') {
    input.type = 'text';
    if (eyeIcon)    eyeIcon.style.display    = 'none';
    if (eyeOffIcon) eyeOffIcon.style.display = '';
    if (btn) btn.setAttribute('aria-label', 'Hide password');
  } else {
    input.type = 'password';
    if (eyeIcon)    eyeIcon.style.display    = '';
    if (eyeOffIcon) eyeOffIcon.style.display = 'none';
    if (btn) btn.setAttribute('aria-label', 'Show password');
  }

  // Restore cursor position
  try {
    input.setSelectionRange(selStart, selEnd);
  } catch (_) {}

  // Return focus to input (keyboard accessibility)
  input.focus();
}

/**
 * Maps Firebase Auth client error codes to clean, user-friendly messages.
 */
function getFirebaseAuthErrorMessage(err) {
  if (!err) return 'Login failed. Please try again.';
  const code = (err.code || '').toLowerCase();
  const msg  = (err.message || '').toLowerCase();

  if (code.includes('api-key') || msg.includes('api-key') || code.includes('invalid-api-key')) {
    return 'Firebase Web API key is not valid or could not be loaded from backend. Please verify your backend server is running.';
  }
  if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found')) {
    return 'Incorrect email or password. Please try again.';
  }
  if (code.includes('invalid-email')) {
    return 'Please enter a valid email address.';
  }
  if (code.includes('user-disabled')) {
    return 'This account has been disabled. Please contact support.';
  }
  if (code.includes('too-many-requests')) {
    return 'Access temporarily disabled due to many failed login attempts. Please reset your password or try again later.';
  }
  if (code.includes('network-request-failed') || msg.includes('network') || msg.includes('failed to fetch')) {
    return 'Network connection error. Please check your internet connection.';
  }
  return err.message || 'Login failed. Please check your credentials or try again.';
}

async function handleLogin() {
  const email   = document.getElementById('login-email').value.trim().toLowerCase();
  const pw      = document.getElementById('login-password').value;
  const alertEl = document.getElementById('login-alert');
  const btn     = document.querySelector('#view-login .btn-primary') || document.getElementById('btn-login-submit');

  // Clear any stale error immediately (before the async request)
  alertEl.className = 'hidden';
  alertEl.innerHTML = '';

  // Basic presence checks
  if (!email || !pw) {
    showTempError(alertEl, 'Please fill in all fields.', 3000);
    return;
  }

  // Disable button during request
  if (btn) { btn.disabled = true; btn.textContent = 'Logging in…'; }

  try {
    // Ensure client SDK is ready with active configuration before attempting sign in
    if (typeof window.ensureFirebaseClientReady === 'function') {
      await window.ensureFirebaseClientReady().catch(() => {});
    }

    // Verify Firebase Client Auth is initialized and configured with valid credentials
    const isConfigured = (typeof window.isFirebaseConfigured === 'function')
      ? window.isFirebaseConfigured()
      : (typeof window.fsAuth !== 'undefined' && window.fsAuth && typeof window.fsAuth.signInWithEmailAndPassword === 'function');

    if (!isConfigured) {
      const errorMsg = '⚠️ Cannot connect to backend server or Firebase authentication service is not ready. Please ensure the backend server is running.';
      console.warn('[Login] Firebase Client Auth service unavailable or using placeholder configuration.');
      showTempError(alertEl, errorMsg, 6000);
      if (btn) { btn.disabled = false; btn.textContent = 'Sign In'; }
      return;
    }

    // Canonical Client-Side Authentication:
    // Browser authenticates directly with Firebase Auth via Web SDK.
    // This runs directly in the user browser and automatically supplies HTTP referrers,
    // avoiding server-side REST API key restrictions.
    let idToken = null;
    try {
      const userCred = await window.fsAuth.signInWithEmailAndPassword(email, pw);
      if (userCred && userCred.user) {
        idToken = await userCred.user.getIdToken();
      }
    } catch (clientAuthErr) {
      console.warn('[Login] Firebase Client SDK authentication failed:', clientAuthErr.code || clientAuthErr.message);
      const friendlyMsg = getFirebaseAuthErrorMessage(clientAuthErr);
      showTempError(alertEl, friendlyMsg, 6000);
      if (btn) { btn.disabled = false; btn.textContent = 'Sign In'; }
      return; // Strict halt: never fall back to unauthenticated backend call
    }

    if (!idToken) {
      showTempError(alertEl, 'Failed to obtain authentication token. Please try again.', 6000);
      if (btn) { btn.disabled = false; btn.textContent = 'Sign In'; }
      return;
    }

    // Send verified ID token to backend for Admin SDK verification and session setup
    const data = await API.login({ email, idToken });

    if (data.success) {
      // Store user profile from server (no password)
      AppState.currentUser = data.user;
      if (data.token) {
        AppState.token = data.token;
      }
      alertEl.className = 'hidden';

      // Persist session to localStorage so refresh doesn't log out
      AppState.saveSession();

      // Authenticate Firebase Client SDK services (Firestore chat + RTDB signaling)
      if (typeof window.authenticateFirebaseClient === 'function') {
        window.authenticateFirebaseClient(data.user.uid).catch(() => {});
      } else if (typeof window.fsAuth !== 'undefined' && window.fsAuth && data.customToken) {
        window.fsAuth.signInWithCustomToken(data.customToken).catch(() => {});
      }

      // Clear inputs
      document.getElementById('login-email').value    = '';
      document.getElementById('login-password').value = '';

      // Check for a pending invite (from /invite/:token URL or join-code entered pre-login)
      if (typeof resumePendingInvite === 'function') {
        const handled = await resumePendingInvite(data.user);
        if (handled) return; // invite.js will navigate to workspace
      }

      // No pending invite → go to dashboard and load suites
      navigate('view-dashboard');
      loadUserSuites();
    } else {
      // Capture safe error diagnostic in browser console without leaking credentials
      const errorCode = data.code || 'UNKNOWN_AUTH_ERROR';
      const errorMsg = data.error || data.message || 'Login failed. Please try again.';
      console.warn('[Login] Authentication failure diagnostic:', {
        code: errorCode,
        error: errorMsg,
        stage: data.stage || 'auth-response',
      });

      // Display server error message (exact text from spec / safe user-facing message)
      showTempError(alertEl, errorMsg, 6000);
    }
  } catch (err) {
    console.error('[Login] Request exception:', err);
    // err.message contains full LAN guidance from api.js apiFetch()
    const msg = (err && err.message && err.message.includes('Cannot connect'))
      ? '⚠️ Cannot connect to server. Check that both devices are on the same Wi-Fi/LAN and the backend is running.'
      : `⚠️ Login Error: ${err.message || 'Server unreachable'}`;
    showTempError(alertEl, msg, 6000);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Submit'; }
  }
}
