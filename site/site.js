// minemuster.com: the small-screen menu, and the 3D logo on the hero.
// three.js is loaded only for the hero, and only where WebGL works; until the 3D logo has drawn
// its first frame (or for good, if it cannot), the flat logo stands in its place.

/* ---------- Menu ---------- */
const menuButton = document.querySelector('.menu-button');
const menu = document.getElementById('menu');
const bar = document.querySelector('.top-bar');
if (menuButton && menu) {
  const isOpen = () => menuButton.getAttribute('aria-expanded') === 'true';
  const setOpen = (open) => {
    menuButton.setAttribute('aria-expanded', String(open));
    menu.classList.toggle('is-open', open);
    if (bar) bar.classList.toggle('menu-open', open);
  };
  menuButton.addEventListener('click', () => setOpen(!isOpen()));
  menu.addEventListener('click', (e) => { if (e.target.closest('a')) setOpen(false); });
  // The open menu covers the top of the page, so it closes once the keyboard's focus leaves the
  // menu and its button (a Tab past its last link would otherwise land on a link hidden under it),
  // and when a finger or the mouse presses anywhere outside it.
  const inMenu = (node) => node instanceof Node && (menu.contains(node) || menuButton.contains(node));
  (bar || menu).addEventListener('focusout', (e) => {
    if (isOpen() && e.relatedTarget && !inMenu(e.relatedTarget)) setOpen(false);
  });
  document.addEventListener('pointerdown', (e) => {
    if (isOpen() && !inMenu(e.target)) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menuButton.getAttribute('aria-expanded') === 'true') {
      setOpen(false);
      menuButton.focus();
    }
  });
  window.matchMedia('(min-width: 64rem)').addEventListener('change', () => setOpen(false));
}

/* ---------- Rows of screens you swipe ---------- */
// On a small screen a row of phones scrolls sideways; it then takes keyboard focus, so the arrow
// keys can scroll it in every browser. On a wide screen nothing scrolls and it is not a tab stop.
const swipeRows = document.querySelectorAll('.shots-many');
const swipes = window.matchMedia('(max-width: 43.99rem)');
const markSwipeRows = () => {
  for (const row of swipeRows) {
    if (swipes.matches) row.setAttribute('tabindex', '0');
    else row.removeAttribute('tabindex');
  }
};
markSwipeRows();
swipes.addEventListener('change', markSwipeRows);

/* ---------- The 3D logo ---------- */
const stage = document.querySelector('[data-logo-stage]');

// three.js r170 draws with WebGL 2 only, so a browser with WebGL 1 alone keeps the flat logo
// and never downloads it.
function webglWorks() {
  try {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2');
    if (!gl) return false;
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return true;
  } catch {
    return false;
  }
}

// Fetch the logo and three.js side by side, rather than one after the other.
function preload() {
  for (const href of ['3d/logo3d.js', '3d/three.module.min.js']) {
    const link = document.createElement('link');
    link.rel = 'modulepreload';
    link.href = href;
    document.head.append(link);
  }
}

const whenIdle = (fn) => ('requestIdleCallback' in window ? window.requestIdleCallback(fn, { timeout: 1200 }) : setTimeout(fn, 200));

// How the logo is turned, said the way that works on this screen: a mouse or trackpad drags it
// (or the arrow keys turn it); on a touch screen only a sideways swipe turns it, since a swipe up
// or down scrolls the page.
const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
const HOW_TO_TURN = {
  fine: { hint: 'Drag to turn the logo', label: 'The MineMuster logo in 3D. Drag it, or use the arrow keys, to turn it.' },
  touch: { hint: 'Swipe sideways to turn the logo', label: 'The MineMuster logo in 3D. Swipe sideways across it to turn it.' },
};

function sayHowToTurn(canvas, hint) {
  const how = finePointer.matches ? HOW_TO_TURN.fine : HOW_TO_TURN.touch;
  canvas.setAttribute('aria-label', how.label);
  if (!hint) return;
  const text = hint.querySelector('[data-logo-hint-text]');
  if (text) text.textContent = how.hint;
  else {
    // No span for the words: they are the hint's last line of text.
    const line = [...hint.childNodes].reverse().find((n) => n.nodeType === Node.TEXT_NODE && n.data.trim());
    if (line) line.data = ` ${how.hint} `;
  }
}

function startLogo() {
  const canvas = stage.querySelector('canvas');
  const flat = stage.querySelector('.stage-flat');
  const hint = document.querySelector('[data-logo-hint]');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  sayHowToTurn(canvas, hint);
  finePointer.addEventListener('change', () => sayHowToTurn(canvas, hint));
  preload();
  import('./3d/logo3d.js')
    .then(({ mountLogo }) => new Promise((resolve) => {
      // Build the scene once the page has settled, so a tap on the menu never waits on it.
      const mount = () => whenIdle(() => resolve(mountLogo));
      if (document.readyState === 'complete') mount();
      else window.addEventListener('load', mount, { once: true });
    }))
    .then((mountLogo) => {
      canvas.hidden = false;
      mountLogo(canvas, {
        transparent: true,
        // It starts face on, where the flat logo was; with reduced motion it stays at an angle, so it still reads as 3D.
        view: reduce ? 'hero' : 'front',
        // The stage is short and wide: a taller frame keeps the turning logo inside it.
        frame: { w: 15.6, h: 10.8 },
        maxPixels: 2.6e6,
        wheelZoom: false,
        pinchZoom: false,
        touchScroll: true,
        pauseOffscreen: true,
        reducedMotionStill: true,
        // It turns all the way round by itself, a turn about every 15 seconds, lingering face on and
        // tilting gently, and reads the right way round on both sides. It starts once the flat logo
        // has faded out, holds still while a mouse is over it or it has keyboard focus, and turns
        // again 0.7 seconds after it is let go.
        twoSided: true,
        spinSpeed: 0.3,
        dwell: 1,
        bob: 0.09,
        bobRate: 0.6,
        spinDelay: 500,
        resumeAfter: 700,
        pauseOnHover: true,
        onReady() {
          stage.classList.add('is-live');
          flat.setAttribute('aria-hidden', 'true');
          if (hint) hint.hidden = false;
        },
        // The phone took WebGL away: the flat logo stands in until the 3D one draws again.
        onLost() {
          stage.classList.remove('is-live');
          flat.removeAttribute('aria-hidden');
          if (hint) hint.hidden = true;
        },
      });
    })
    .catch(() => {
      canvas.hidden = true; // the flat logo stays
    });
}

if (stage && webglWorks()) {
  // Opened further down the page (at #faq, say), three.js waits until the hero is near the screen.
  if ('IntersectionObserver' in window) {
    const near = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        near.disconnect();
        startLogo();
      }
    }, { rootMargin: '400px 0px' });
    // The browser scrolls to a link's section only after the page has loaded, so look once it is there.
    const target = window.location.hash.length > 1 && document.getElementById(decodeURIComponent(window.location.hash.slice(1)));
    if (target && target !== document.body) {
      let watching = false;
      const watch = () => { if (!watching) { watching = true; near.observe(stage); } };
      window.addEventListener('load', () => {
        window.addEventListener('scrollend', watch, { once: true });
        setTimeout(watch, 1500);
      }, { once: true });
    } else {
      near.observe(stage);
    }
  } else {
    startLogo();
  }
}
