/* ── VIEW 2 – Sign Up (2-step: fill fields → validate → send OTP → verify) */

/* ─ Password strength meter ─────────────────────────────────── */
function checkPWStrength() {
  const pw  = document.getElementById('signup-password').value;
  const bar = document.getElementById('pw-strength-bar');
  const lbl = document.getElementById('pw-strength-label');
  if (!bar || !lbl) return;

  let score = 0;
  if (pw.length >= 8)            score++;
  if (pw.length >= 12)           score++;
  if (/[A-Z]/.test(pw))         score++;
  if (/[0-9]/.test(pw))         score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;

  const levels = [
    { pct:'0%',   color:'#dee2e6', label:'' },
    { pct:'25%',  color:'#dc3545', label:'Weak' },
    { pct:'50%',  color:'#ffc107', label:'Fair' },
    { pct:'75%',  color:'#17a2b8', label:'Good' },
    { pct:'100%', color:'#28a745', label:'Strong ✓' },
  ];
  const lvl = levels[Math.min(score, 4)];
  bar.style.width      = lvl.pct;
  bar.style.background = lvl.color;
  lbl.textContent      = pw ? lvl.label : '';
  lbl.style.color      = lvl.color;
}

/* ─ Client-side password validation (mirrors backend rules) ──── */
function validatePassword(password) {
  if (!password || password.length < 8)
    return 'Password must be at least 8 characters.';
  if (!/[A-Z]/.test(password))
    return 'Password must contain at least one uppercase letter.';
  if (!/[a-z]/.test(password))
    return 'Password must contain at least one lowercase letter.';
  if (!/[0-9]/.test(password))
    return 'Password must contain at least one number.';
  if (!/[^A-Za-z0-9]/.test(password))
    return 'Password must contain at least one special character (e.g. @, #, $).';
  return null;
}

/* ─ OTP countdown UI ─────────────────────────────────────────── */
const RESEND_LOCKOUT_SEC = 60; // seconds before resend is allowed

function startOTPCountdown() {
  const wrap    = document.getElementById('otp-countdown-wrap');
  const barEl   = document.getElementById('otp-progress-bar');
  const timerEl = document.getElementById('otp-timer-text');
  const sendBtn = document.getElementById('btn-send-otp');
  if (!wrap) return;

  wrap.style.display = 'flex';
  if (sendBtn) {
    sendBtn.disabled      = true;
    sendBtn.style.opacity = '0.5';
    sendBtn.style.cursor  = 'not-allowed';
  }

  // Track when resend lock expires (60s from now)
  const resendUnlockAt = Date.now() + RESEND_LOCKOUT_SEC * 1000;

  if (AppState.otpTimerHandle) clearInterval(AppState.otpTimerHandle);

  AppState.otpTimerHandle = setInterval(() => {
    const now       = Date.now();
    const remaining = Math.max(0, Math.ceil((AppState.otpExpiry - now) / 1000));
    const pct       = (remaining / CONFIG.OTP_TTL) * 100;

    if (barEl)   barEl.style.width   = pct + '%';
    if (timerEl) timerEl.textContent = remaining + 's';

    // Color warning at 30s remaining
    if (remaining <= 30) {
      if (barEl)   barEl.classList.add('expiring');
      if (timerEl) timerEl.classList.add('expiring');
    } else {
      if (barEl)   barEl.classList.remove('expiring');
      if (timerEl) timerEl.classList.remove('expiring');
    }

    // Unlock resend button after 60 seconds
    if (now >= resendUnlockAt && sendBtn && sendBtn.disabled) {
      sendBtn.disabled      = false;
      sendBtn.style.opacity = '1';
      sendBtn.style.cursor  = 'pointer';
      sendBtn.innerHTML     = '<span class="material-symbols-outlined text-sm">refresh</span><span>Resend Code</span>';
    }

    // OTP fully expired
    if (remaining === 0) {
      clearInterval(AppState.otpTimerHandle);
      AppState.otpSent   = false;
      AppState.otpExpiry = 0;
      if (wrap) wrap.style.display = 'none';
      if (sendBtn) {
        sendBtn.disabled      = false;
        sendBtn.style.opacity = '1';
        sendBtn.style.cursor  = 'pointer';
        sendBtn.innerHTML     = '<span class="material-symbols-outlined text-sm">refresh</span><span>Resend Code</span>';
      }
      const alertEl = document.getElementById('signup-alert');
      if (alertEl) showTempError(alertEl, '⏱ Verification code expired. Please request a new one.', 5000);
    }
  }, 1000);
}

/* ─ 6-Digit OTP Cluster Helpers ──────────────────────────────── */
function getEnteredOtp() {
  const boxes = document.querySelectorAll('#signup-otp-cluster .otp-digit-box');
  if (boxes && boxes.length === 6) {
    const code = Array.from(boxes).map(b => b.value.trim()).join('');
    const hiddenOtp = document.getElementById('signup-otp');
    if (hiddenOtp) hiddenOtp.value = code;
    return code;
  }
  const hiddenOtp = document.getElementById('signup-otp');
  return hiddenOtp ? hiddenOtp.value.trim() : '';
}

function clearOtpInputs() {
  const boxes = document.querySelectorAll('#signup-otp-cluster .otp-digit-box');
  boxes.forEach(b => { b.value = ''; });
  const hiddenOtp = document.getElementById('signup-otp');
  if (hiddenOtp) hiddenOtp.value = '';
}

function initOtpDigitCluster() {
  const boxes = Array.from(document.querySelectorAll('#signup-otp-cluster .otp-digit-box'));
  if (!boxes.length) return;

  boxes.forEach((box, index) => {
    if (box.dataset.otpBound === 'true') return;
    box.dataset.otpBound = 'true';

    // Handle single digit input & auto-advance
    box.addEventListener('input', e => {
      const val = e.target.value.replace(/\D/g, '');
      e.target.value = val ? val[val.length - 1] : '';
      getEnteredOtp();

      if (e.target.value && index < boxes.length - 1) {
        boxes[index + 1].focus();
        boxes[index + 1].select();
      }
    });

    // Handle backspace, arrows, enter
    box.addEventListener('keydown', e => {
      if (e.key === 'Backspace') {
        if (!e.target.value && index > 0) {
          boxes[index - 1].focus();
          boxes[index - 1].value = '';
          getEnteredOtp();
          e.preventDefault();
        } else {
          e.target.value = '';
          getEnteredOtp();
        }
      } else if (e.key === 'ArrowLeft' && index > 0) {
        boxes[index - 1].focus();
        e.preventDefault();
      } else if (e.key === 'ArrowRight' && index < boxes.length - 1) {
        boxes[index + 1].focus();
        e.preventDefault();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        handleSignup();
      }
    });

    // Handle multi-digit paste across cluster
    box.addEventListener('paste', e => {
      e.preventDefault();
      const pasteData = (e.clipboardData || window.clipboardData).getData('text') || '';
      const digits = pasteData.replace(/\D/g, '').slice(0, 6);
      if (!digits) return;

      digits.split('').forEach((d, i) => {
        if (boxes[i]) boxes[i].value = d;
      });

      getEnteredOtp();

      const nextIdx = Math.min(digits.length, boxes.length - 1);
      if (boxes[nextIdx]) boxes[nextIdx].focus();
      if (digits.length === 6 && boxes[5]) {
        boxes[5].focus();
      }
    });
  });
}

/* ─ Stage Transition Helpers ─────────────────────────────────── */
function showSignupStage2(email) {
  const s1 = document.getElementById('signup-stage-1');
  const s2 = document.getElementById('signup-stage-2');
  const bar1 = document.getElementById('step-bar-1');
  const bar2 = document.getElementById('step-bar-2');
  const subtext = document.getElementById('signup-step-subtext');
  const emailTarget = document.getElementById('signup-otp-email');

  if (s1) {
    s1.style.display = 'none';
    s1.classList.add('hidden');
  }
  if (s2) {
    s2.style.display = 'block';
    s2.classList.remove('hidden');
  }
  if (bar1) {
    bar1.classList.remove('bg-[#E1DFE2]');
    bar1.classList.add('bg-[#0247AE]');
  }
  if (bar2) {
    bar2.classList.remove('bg-[#E1DFE2]');
    bar2.classList.add('bg-[#0247AE]');
  }
  if (subtext) {
    subtext.textContent = 'Step 2 of 2: Enter the 6-digit verification code sent to your email';
  }
  if (emailTarget && email) {
    emailTarget.textContent = email;
  }

  clearOtpInputs();
  initOtpDigitCluster();

  // Focus the first OTP box
  setTimeout(() => {
    const firstBox = document.getElementById('signup-otp-1');
    if (firstBox) firstBox.focus();
  }, 100);
}

function showSignupStage1() {
  const s1 = document.getElementById('signup-stage-1');
  const s2 = document.getElementById('signup-stage-2');
  const bar2 = document.getElementById('step-bar-2');
  const subtext = document.getElementById('signup-step-subtext');
  const contBtn = document.getElementById('btn-signup-continue');
  const alertEl = document.getElementById('signup-alert');

  if (s2) {
    s2.style.display = 'none';
    s2.classList.add('hidden');
  }
  if (s1) {
    s1.style.display = 'block';
    s1.classList.remove('hidden');
  }
  if (bar2) {
    bar2.classList.remove('bg-[#0247AE]');
    bar2.classList.add('bg-[#E1DFE2]');
  }
  if (subtext) {
    subtext.textContent = 'Step 1 of 2: Researcher Profile & Credentials';
  }
  if (contBtn) {
    contBtn.disabled = false;
    contBtn.innerHTML = '<span>Continue to Verification</span><span class="material-symbols-outlined text-base">arrow_forward</span>';
  }
  if (alertEl) {
    alertEl.className = 'hidden';
    alertEl.innerHTML = '';
  }
}

// Aliases for compatibility
window.showSignupStage1 = showSignupStage1;
window.showSignupStage2 = showSignupStage2;
window.showSignupStep1  = showSignupStage1;
window.showSignupStep2  = showSignupStage2;

/* ─ STEP 1: "Continue" – validate all fields, then send OTP ──── */
async function handleSignupContinue() {
  const name     = document.getElementById('signup-name').value.trim();
  const username = document.getElementById('signup-username').value.trim().toLowerCase();
  const email    = document.getElementById('signup-email').value.trim().toLowerCase();
  const password = document.getElementById('signup-password').value;
  const confirm  = document.getElementById('signup-confirm-password').value;
  const alertEl  = document.getElementById('signup-alert');
  const contBtn  = document.getElementById('btn-signup-continue');

  // 1. All fields present
  if (!name) { showTempError(alertEl, 'Please enter your full name.', 3000); return; }
  if (!username) { showTempError(alertEl, 'Please enter a username.', 3000); return; }
  if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
    showTempError(alertEl, 'Username: 3-30 chars, letters/numbers/underscores only.', 3000);
    return;
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showTempError(alertEl, 'Please enter a valid institutional email address.', 3000);
    return;
  }

  // 2. Password validation
  const pwErr = validatePassword(password);
  if (pwErr) { showTempError(alertEl, pwErr, 4000); return; }

  // 3. Password match
  if (password !== confirm) {
    showTempError(alertEl, '❌ Passwords do not match.', 3000);
    return;
  }

  // 4. Send OTP with in-flight lock to prevent duplicate clicks
  if (contBtn) {
    contBtn.disabled = true;
    contBtn.innerHTML = '<span class="material-symbols-outlined text-sm animate-spin">progress_activity</span><span>Sending Code…</span>';
  }

  try {
    const data = await API.sendOTP(email);

    if (data.success) {
      AppState.otpSent   = true;
      AppState.otpExpiry = Date.now() + CONFIG.OTP_TTL * 1000;

      // Transition to Stage 2 OTP input interface
      showSignupStage2(email);

      showAlert(alertEl, 'success',
        `✉️ Verification code sent to <strong>${escapeHtml(email)}</strong>. Check your inbox!`);
      setTimeout(() => { if (alertEl) alertEl.className = 'hidden'; }, 6000);

      startOTPCountdown();
    } else {
      if (contBtn) {
        contBtn.disabled = false;
        contBtn.innerHTML = '<span>Continue to Verification</span><span class="material-symbols-outlined text-base">arrow_forward</span>';
      }
      showTempError(alertEl, data.error || data.message || 'Failed to send verification code. Try again.', 4000);
    }
  } catch (err) {
    if (contBtn) {
      contBtn.disabled = false;
      contBtn.innerHTML = '<span>Continue to Verification</span><span class="material-symbols-outlined text-base">arrow_forward</span>';
    }
    console.error('[Signup] Send OTP failed:', err);
    showTempError(alertEl, err.message && err.message.includes('Cannot connect')
      ? '⚠️ Cannot connect to server. Check Wi-Fi/LAN and backend.'
      : (err.message || '⚠️ Server unreachable.'), 5000);
  }
}

/* ─ Resend OTP (standalone, callable from Resend Code button) ─── */
async function sendOTP() {
  const email   = document.getElementById('signup-email').value.trim().toLowerCase();
  const alertEl = document.getElementById('signup-alert');
  const sendBtn = document.getElementById('btn-send-otp');

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showTempError(alertEl, 'Please enter a valid institutional email address first.', 3000);
    return;
  }

  if (sendBtn) {
    sendBtn.disabled      = true;
    sendBtn.innerHTML     = '<span class="material-symbols-outlined text-sm animate-spin">progress_activity</span><span>Sending…</span>';
    sendBtn.style.opacity = '0.7';
  }

  try {
    const data = await API.sendOTP(email);
    if (data.success) {
      AppState.otpSent   = true;
      AppState.otpExpiry = Date.now() + CONFIG.OTP_TTL * 1000;
      if (sendBtn) {
        sendBtn.innerHTML = '<span class="material-symbols-outlined text-sm">check</span><span>Sent ✓</span>';
        sendBtn.style.opacity = '1';
      }
      showAlert(alertEl, 'success',
        `✉️ New verification code sent to <strong>${escapeHtml(email)}</strong>.`);
      setTimeout(() => { if (alertEl) alertEl.className = 'hidden'; }, 5000);

      clearOtpInputs();
      startOTPCountdown();

      const firstBox = document.getElementById('signup-otp-1');
      if (firstBox) firstBox.focus();
    } else {
      if (sendBtn) {
        sendBtn.disabled      = false;
        sendBtn.innerHTML     = '<span class="material-symbols-outlined text-sm">refresh</span><span>Resend Code</span>';
        sendBtn.style.opacity = '1';
        sendBtn.style.cursor  = 'pointer';
      }
      showTempError(alertEl, data.error || data.message || 'Failed to send verification code.', 4000);
    }
  } catch (err) {
    if (sendBtn) {
      sendBtn.disabled      = false;
      sendBtn.innerHTML     = '<span class="material-symbols-outlined text-sm">refresh</span><span>Resend Code</span>';
      sendBtn.style.opacity = '1';
      sendBtn.style.cursor  = 'pointer';
    }
    console.error('[Signup] Resend OTP failed:', err);
    showTempError(alertEl, err.message && err.message.includes('Cannot connect')
      ? '⚠️ Cannot connect to server. Check Wi-Fi/LAN and backend.'
      : (err.message || '⚠️ Server unreachable.'), 4000);
  }
}

/* ─ STEP 2: Sign Up submit – verify OTP + register account ───── */
async function handleSignup() {
  const name      = document.getElementById('signup-name').value.trim();
  const username  = document.getElementById('signup-username').value.trim().toLowerCase();
  const email     = document.getElementById('signup-email').value.trim().toLowerCase();
  const password  = document.getElementById('signup-password').value;
  const confirm   = document.getElementById('signup-confirm-password').value;
  const otp       = getEnteredOtp();
  const alertEl   = document.getElementById('signup-alert');
  const submitBtn = document.getElementById('btn-signup-submit');

  // Validate OTP entry
  if (!AppState.otpSent) {
    showTempError(alertEl, 'Please click "Continue" first to receive your verification code.', 3000);
    return;
  }
  if (!otp || otp.length !== 6) {
    showTempError(alertEl, 'Please enter the complete 6-digit authorization code.', 3000);
    return;
  }

  // Prevent duplicate submissions
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="material-symbols-outlined text-sm animate-spin">progress_activity</span><span>Verifying Code…</span>';
  }

  // 1. Verify OTP
  try {
    const otpData = await API.verifyOTP(email, otp);
    if (!otpData.success) {
      showTempError(alertEl, otpData.error || otpData.message || 'Invalid verification code. Please try again.', 3000);
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<span class="material-symbols-outlined text-base">verified</span><span>Verify &amp; Register</span>';
      }
      return;
    }
  } catch (err) {
    console.error('[Signup] OTP verification failed:', err);
    showTempError(alertEl, '⚠️ Server error during verification. Please try again.', 3000);
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<span class="material-symbols-outlined text-base">verified</span><span>Verify &amp; Register</span>';
    }
    return;
  }

  // 2. Register account via backend
  if (submitBtn) {
    submitBtn.innerHTML = '<span class="material-symbols-outlined text-sm animate-spin">progress_activity</span><span>Creating Account…</span>';
  }

  try {
    const data = await API.register({ name, username, email, password, confirm });

    if (data.success) {
      // Clean up OTP state
      if (AppState.otpTimerHandle) clearInterval(AppState.otpTimerHandle);
      AppState.otpSent   = false;
      AppState.otpExpiry = 0;

      showAlert(alertEl, 'success', '✅ Academic account created! Redirecting to login…');

      // Reset form fields
      ['signup-name','signup-username','signup-email','signup-password','signup-confirm-password'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      clearOtpInputs();

      // Reset step visibility back to stage 1
      showSignupStage1();

      const wrap = document.getElementById('otp-countdown-wrap');
      if (wrap) wrap.style.display = 'none';

      const bar = document.getElementById('pw-strength-bar');
      if (bar) bar.style.width = '0%';
      const lbl = document.getElementById('pw-strength-label');
      if (lbl) lbl.textContent = '';

      const sendBtn = document.getElementById('btn-send-otp');
      if (sendBtn) {
        sendBtn.disabled      = false;
        sendBtn.innerHTML     = '<span class="material-symbols-outlined text-sm">refresh</span><span>Resend Code</span>';
        sendBtn.style.opacity = '1';
        sendBtn.style.cursor  = 'pointer';
      }

      setTimeout(() => navigate('view-login'), 1800);
    } else {
      showTempError(alertEl, data.message || data.error || 'Registration failed. Please try again.', 5000);
    }
  } catch (err) {
    console.error('[Signup] Registration failed:', err);
    showTempError(alertEl, '⚠️ Server error during account creation. Please try again.', 3000);
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<span class="material-symbols-outlined text-base">verified</span><span>Verify &amp; Register</span>';
    }
  }
}

// Initialise OTP cluster when document is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initOtpDigitCluster);
} else {
  initOtpDigitCluster();
}
