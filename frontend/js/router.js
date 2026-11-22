/* ── Client-side router (state machine) ──────────────────────── */

const VIEW_IDS = [
  'view-landing', 'view-login', 'view-signup', 'view-forgot',
  'view-dashboard', 'view-workspace',
];

function navigate(viewId, fromPopState = false) {
  // Capture the view being navigated away from BEFORE clearing classes
  const previousView = VIEW_IDS.find(id => document.getElementById(id)?.classList.contains('active'));

  VIEW_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('active');
  });

  const target = document.getElementById(viewId);
  if (!target) { console.error('Unknown view:', viewId); return; }
  target.classList.add('active');

  // Track active view in sessionStorage to distinguish in-session refreshes from initial visits
  try {
    sessionStorage.setItem('colearn_active_view', viewId);
  } catch (_) {}

  // Scroll to top when navigating views
  window.scrollTo(0, 0);

  // Cleanup workspace presence when leaving workspace view
  if (viewId !== 'view-workspace' && typeof cleanupSuitePresence === 'function') {
    cleanupSuitePresence();
  }

  // View-specific on-enter hooks
  if (viewId === 'view-landing') {
    if (typeof initLandingPage === 'function') initLandingPage();
  }
  if (viewId === 'view-signup') {
    if (typeof showSignupStage1 === 'function' && (!window.AppState || !window.AppState.otpSent)) {
      showSignupStage1();
    }
  }
  if (viewId === 'view-dashboard') {
    if (typeof updateProfileDisplay === 'function') updateProfileDisplay();
    // Always reload suites from backend on every dashboard visit
    if (typeof loadUserSuites === 'function' && AppState.currentUser) {
      loadUserSuites();
    }
  }
  if (viewId === 'view-workspace') {
    if (typeof initWorkspace === 'function') initWorkspace();
  }

  // Manage browser history state
  if (!fromPopState) {
    if (viewId === 'view-dashboard') {
      const wasWorkspaceOrAuth = previousView === 'view-workspace' || previousView === 'view-login' || previousView === 'view-signup';
      if (wasWorkspaceOrAuth) {
        history.replaceState({ view: 'view-dashboard' }, '');
      } else {
        history.pushState({ view: 'view-dashboard' }, '');
      }
    } else if (viewId === 'view-workspace') {
      history.pushState({ view: 'view-workspace', suiteId: AppState.currentSuite?.id, wsState: AppState.wsCurrentState || 'invite' }, '');
    } else if (viewId === 'view-signup' || viewId === 'view-forgot') {
      history.pushState({ view: viewId }, '');
    } else if (viewId === 'view-login') {
      history.pushState({ view: 'view-login' }, '');
    } else if (viewId === 'view-landing') {
      history.pushState({ view: 'view-landing' }, '');
    }
  }
}

// Handle browser back/forward buttons
window.addEventListener('popstate', event => {
  const state = event.state;
  if (state && state.view) {
    const isProtected = state.view === 'view-dashboard' || state.view === 'view-workspace';
    if (isProtected && !AppState.currentUser) {
      history.replaceState({ view: 'view-login' }, '');
      navigate('view-login', true);
      return;
    }
    if (state.view === 'view-workspace') {
      if (!AppState.currentSuite || !AppState.currentSuite.id) {
        history.replaceState({ view: 'view-dashboard' }, '');
        navigate('view-dashboard', true);
        return;
      }
      navigate('view-workspace', true);
      if (state.wsState && typeof setWSState === 'function') {
        setWSState(state.wsState, true);
      }
      return;
    }
    // Do NOT auto-redirect users from auth pages to view-dashboard even if AppState.currentUser exists.
    // Users must be able to view the login form, enter credentials, use browser autofill, or re-authenticate.
    navigate(state.view, true);
  } else {
    navigate('view-landing', true);
  }
});

/* ── Global keyboard shortcuts ───────────────────────────────── */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    // 1. Close all open modal overlays
    document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(el => el.classList.add('hidden'));

    // 2. Close notification dropdown
    const notifDropdown = document.getElementById('notification-dropdown');
    if (notifDropdown && !notifDropdown.classList.contains('hidden')) {
      notifDropdown.classList.add('hidden');
    }

    // 3. Close context menus
    if (typeof closeDocContextMenu === 'function') closeDocContextMenu();
    if (typeof closeMemberContextMenu === 'function') closeMemberContextMenu();

    // 4. Close category modal and notepad
    if (typeof closeCategoryModal === 'function') closeCategoryModal();
    if (typeof closeNotepad === 'function') closeNotepad();

    // 5. Close private chat panel
    if (typeof closePrivateChatPanel === 'function') closePrivateChatPanel();

    // 6. Minimize video call and screen share overlays
    const vcOverlay = document.getElementById('video-call-overlay');
    if (vcOverlay && !vcOverlay.classList.contains('hidden')) {
      vcOverlay.classList.add('hidden');
    }
    const ssOverlay = document.getElementById('screen-share-overlay');
    if (ssOverlay && !ssOverlay.classList.contains('hidden')) {
      ssOverlay.classList.add('hidden');
    }

    // 7. Close AI study buddy if open
    if (typeof closeAIBuddy === 'function') closeAIBuddy();

    // 8. Dismiss flowchart more menu and smart recognition card if open
    if (typeof hideDrawflowMoreMenu === 'function') hideDrawflowMoreMenu();
    if (typeof _dismissSmartPredictionCard === 'function') _dismissSmartPredictionCard();
  }
  if (e.key === 'Enter' && document.getElementById('view-login')?.classList.contains('active')) {
    // Do not trigger login if focus is on the password toggle button
    const focused = document.activeElement;
    const isToggleBtn = focused && focused.id === 'login-pw-toggle';
    if (!isToggleBtn && typeof handleLogin === 'function') handleLogin();
  }
});

/* ── Close modals on backdrop click (Delegated) ──────────────── */
document.addEventListener('click', function(e) {
  if (e.target && e.target.classList && e.target.classList.contains('modal-overlay')) {
    e.target.classList.add('hidden');
  }
});

/* ── App Initialisation ──────────────────────────────────────── */
/**
 * Runs once on DOMContentLoaded.
 * Restores session from localStorage BEFORE any view is shown.
 * This prevents the flash to login page on refresh.
 */
async function initApp() {
  // Ensure centralized configuration has loaded before session/API initialization
  if (typeof window.ensureConfigReady === 'function') {
    try {
      await window.ensureConfigReady();
    } catch (_) {}
  }

  const hadSession = AppState.restoreSession();

  // Re-authenticate Firebase Client SDK if session was restored
  if (hadSession && AppState.currentUser && typeof window.authenticateFirebaseClient === 'function') {
    window.authenticateFirebaseClient(AppState.currentUser.uid).catch(() => {});
  }

  // Handle /invite/:token URL first
  if (typeof handleInviteUrlOnLoad === 'function') {
    handleInviteUrlOnLoad().then(() => {
      _initAppNav(hadSession);
    }).catch(() => {
      _initAppNav(hadSession);
    });
  } else {
    _initAppNav(hadSession);
  }
}

function _initAppNav(hadSession) {
  // Determine if this is an explicit in-session refresh on an authenticated page (workspace or dashboard)
  let lastActiveView = '';
  try {
    lastActiveView = sessionStorage.getItem('colearn_active_view') || '';
  } catch (_) {}

  const stateView = history.state && history.state.view;
  const targetView = stateView || lastActiveView;
  const isAuthSessionRefresh = hadSession && (targetView === 'view-dashboard' || targetView === 'view-workspace');

  if (isAuthSessionRefresh) {
    // Check if we were in a suite when we refreshed
    if (AppState.currentSuite && AppState.currentSuite.id) {
      // Verify suite still exists, then navigate to workspace
      if (typeof API !== 'undefined') {
        API.getSuite(AppState.currentSuite.id).then(data => {
          if (data && data.success && data.suite) {
            // Update suite data in case it changed
            AppState.currentSuite = {
              ...AppState.currentSuite,
              name:      data.suite.name,
              isPrivate: data.suite.isPrivate,
              ownerUid:  data.suite.ownerUid,
            };
            AppState.saveSession();
            history.replaceState({ view: 'view-workspace', suiteId: AppState.currentSuite.id }, '');
            navigate('view-workspace', true);
          } else {
            // Suite no longer exists — clear it and go to dashboard
            AppState.saveSuite(null);
            history.replaceState({ view: 'view-dashboard' }, '');
            navigate('view-dashboard', true);
          }
        }).catch(() => {
          // Network error — try to restore workspace anyway
          history.replaceState({ view: 'view-workspace', suiteId: AppState.currentSuite.id }, '');
          navigate('view-workspace', true);
        });
      } else {
        history.replaceState({ view: 'view-workspace', suiteId: AppState.currentSuite.id }, '');
        navigate('view-workspace', true);
      }
    } else {
      // Logged in, was on dashboard — restore dashboard
      history.replaceState({ view: 'view-dashboard' }, '');
      navigate('view-dashboard', true);
    }
  } else {
    // Not an active protected session refresh — check if path explicitly requests an auth route
    const path = (window.location.pathname || '').replace(/\/$/, '');
    if (path === '/login' || path.endsWith('/login')) {
      history.replaceState({ view: 'view-login' }, '');
      navigate('view-login', true);
    } else if (path === '/signup' || path.endsWith('/signup')) {
      history.replaceState({ view: 'view-signup' }, '');
      navigate('view-signup', true);
    } else if (path === '/forgot' || path.endsWith('/forgot')) {
      history.replaceState({ view: 'view-forgot' }, '');
      navigate('view-forgot', true);
    } else {
      // Root / landing visit: always show landing page
      history.replaceState({ view: 'view-landing' }, '');
      navigate('view-landing', true);
    }
  }
}

// Bootstrap the app when DOM is ready
document.addEventListener('DOMContentLoaded', initApp);
