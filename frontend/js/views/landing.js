/* ── Landing Page View Handler ─────────────────────────────────── */

function initLandingPage() {
  const revealObserverOptions = { threshold: 0.15, rootMargin: '0px 0px -50px 0px' };
  const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('animate-slide-up');
        revealObserver.unobserve(entry.target);
      }
    });
  }, revealObserverOptions);

  document.querySelectorAll('.reveal-on-scroll').forEach(el => {
    el.classList.remove('animate-slide-up');
    revealObserver.observe(el);
  });

  const statObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const el = entry.target.querySelector('.stat-number');
        if (el && !el.dataset.animated) {
          const target = parseInt(el.dataset.count);
          let count = 0;
          const duration = 2000;
          const step = target / (duration / 16);
          const updateCount = () => {
            count += step;
            if (count < target) {
              el.innerText = Math.floor(count).toLocaleString() + (el.innerText.includes('%') || target < 100 ? '' : '+');
              requestAnimationFrame(updateCount);
            } else {
              el.innerText = target.toLocaleString() + (target < 100 ? '' : '+');
            }
          };
          updateCount();
          el.dataset.animated = "true";
        }
      }
    });
  }, { threshold: 0.5 });

  document.querySelectorAll('.stat-card').forEach(card => statObserver.observe(card));
}

// Header scroll effect and section highlighting
window.addEventListener('scroll', () => {
  const landingView = document.getElementById('view-landing');
  if (!landingView || !landingView.classList.contains('active')) return;

  const sections = landingView.querySelectorAll('section[id]');
  const navLinks = landingView.querySelectorAll('.nav-link');
  let current = '';
  sections.forEach(section => {
    const sectionTop = section.offsetTop;
    if (window.pageYOffset >= (sectionTop - 150)) {
      current = section.getAttribute('id');
    }
  });
  navLinks.forEach(link => {
    link.classList.remove('active');
    const href = link.getAttribute('href');
    if (current && href && href.includes(current)) {
      link.classList.add('active');
    }
  });
  const header = document.getElementById('main-header');
  if (header) {
    const nav = header.querySelector('nav');
    if (window.scrollY > 50) {
      header.classList.add('h-16', 'shadow-sm');
      if (nav) {
        nav.classList.remove('h-20');
        nav.classList.add('h-16');
      }
    } else {
      header.classList.remove('h-16', 'shadow-sm');
      if (nav) {
        nav.classList.remove('h-16');
        nav.classList.add('h-20');
      }
    }
  }
});

// Run init on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  const landingView = document.getElementById('view-landing');
  if (landingView && landingView.classList.contains('active')) {
    initLandingPage();
  }
});
