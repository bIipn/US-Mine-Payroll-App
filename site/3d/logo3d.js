// Mine Muster — interactive 3D logo.
// Usage: import { mountLogo } from './logo3d.js'; mountLogo(canvasElement, { wordmark: true });
//
// Options, with the defaults that keep the logo as it is on its own page:
//   wordmark: true        show MINE MUSTER and its rules under the mark
//   autoRotate: true      a slow turntable when nobody is touching it (never with reduced motion). The
//                         turn eases in, eases out when a hand takes the logo, and eases back in a
//                         moment after it is let go
//   spinSpeed: 0.28       how fast it turns by itself, in radians a second (face on, with dwell)
//   dwell: 0              how much longer it lingers face on: 0 turns it at an even speed, 1 turns it
//                         twice as fast edge on as face on
//   bob: 0.06             how far it tilts back and forth as it turns, in radians
//   bobRate: 0.4          how quickly it tilts back and forth
//   spinDelay: 0          milliseconds after the first frame before it starts to turn by itself (time
//                         for whatever it replaces on the page to fade out)
//   resumeAfter: 2500     milliseconds after the last drag, key or pinch before it turns by itself again
//   pauseOnHover: false   true stops the turn while a mouse is over the logo or it has keyboard focus,
//                         so it can be read and looked at (WCAG 2.2.2); a finger scrolling past does not.
//                         Held far from a face, it eases on to the nearest face first, never stopping
//                         edge on
//   twoSided: false      true draws the back of the logo as its front, so the MM and MINE MUSTER read
//                         the right way round all the way round, like a sign painted on both sides. The
//                         swap is made as the logo passes edge on, where neither face can be seen
//   transparent: false    true clears to transparent, so the page behind shows
//   view: 'hero'          the angle it starts at and goes back to on a double tap
//   wheelZoom: true       false leaves the wheel and trackpad to scroll the page
//   pinchZoom: true       false ignores a second finger
//   touchScroll: false    true lets a vertical swipe scroll the page (touch-action: pan-y);
//                         a finger turns the logo only once it moves sideways
//   pauseOffscreen: false true stops drawing while the canvas is off screen or the tab is hidden
//   frame: null           the room { w, h } the camera leaves around the logo with its wordmark, in
//                         logo units; null is { w: 15.6, h: 8.4 }, which fits it face on. A short,
//                         wide canvas wants a taller frame, so the logo stays inside it as it turns
//   maxPixels: Infinity   the most pixels the drawing buffer may have; above it the pixel ratio drops
//   reducedMotionStill: false  true, with reduced motion: nothing moves that the person did not move
//                         (no coasting after a flick, no easing back on a double tap), and a frame is
//                         drawn only when something has changed
//   onReady: null         called after the first frame has been drawn, and again after the first
//                         frame once a lost WebGL context is back
//   onLost: null          called when the WebGL context is lost and nothing can be drawn
import * as THREE from 'three';

/* ---------- geometry: the MM mark, traced from the flat logo ---------- */
// Points are in the source artwork's pixel space (1536 wide); converted to units below.
const CX = 768, CY = 500, PX = 100;
const toUnit = ([x, y]) => new THREE.Vector2((x - CX) / PX, (CY - y) / PX);
const mirror = (pts) => pts.map(([x, y]) => [2 * CX - x, y]).reverse();

const LEFT_LEG = [[268, 292], [368, 452], [368, 570], [240, 715], [268, 560]];
const leftChevron = (spike) => [
  [262, 240], [520, 430], [755, 250], [755, 560], spike,
  [665, 600], [665, 455], [520, 560], [386, 448], [281, 284],
];
const MARK = [
  LEFT_LEG,
  leftChevron([682, 750]),
  mirror(LEFT_LEG),
  mirror(leftChevron([690, 668])), // right centre blade is shorter, as in the artwork
];

/* ---------- geometry: MINE MUSTER wordmark, squared techno glyphs ---------- */
const H = 0.62, T = 0.13, MID_HI = H / 2 + T / 2, MID_LO = H / 2 - T / 2;
const GLYPHS = {
  M: { w: 0.84, outer: (w) => [[0, 0], [0, H], [0.17, H], [w / 2, 0.23], [w - 0.17, H], [w, H], [w, 0], [w - T, 0], [w - T, 0.4], [w / 2, 0.05], [T, 0.4], [T, 0]] },
  I: { w: T, outer: (w) => [[0, 0], [0, H], [w, H], [w, 0]] },
  N: { w: 0.72, outer: (w) => [[0, 0], [0, H], [0.17, H], [w - T, 0.2], [w - T, H], [w, H], [w, 0], [w - 0.17, 0], [T, H - 0.2], [T, 0]] },
  E: { w: 0.62, outer: (w) => [[0, 0], [0, H], [w, H], [w, H - T], [T, H - T], [T, MID_HI], [w * 0.86, MID_HI], [w * 0.86, MID_LO], [T, MID_LO], [T, T], [w, T], [w, 0]] },
  U: { w: 0.7, outer: (w) => [[0, H], [T, H], [T, T], [w - T, T], [w - T, H], [w, H], [w, 0.1], [w - 0.1, 0], [0.1, 0], [0, 0.1]] },
  S: { w: 0.66, outer: (w) => [[0, H], [w, H], [w, H - T], [T, H - T], [T, MID_HI], [w, MID_HI], [w, 0], [0, 0], [0, T], [w - T, T], [w - T, MID_LO], [0, MID_LO]] },
  T: { w: 0.66, outer: (w) => [[0, H], [w, H], [w, H - T], [w / 2 + T / 2, H - T], [w / 2 + T / 2, 0], [w / 2 - T / 2, 0], [w / 2 - T / 2, H - T], [0, H - T]] },
  R: {
    w: 0.68,
    outer: (w) => [[0, 0], [0, H], [w, H], [w, MID_LO], [0.6, MID_LO], [w, 0], [w - 0.18, 0], [0.42, MID_LO], [T, MID_LO], [T, 0]],
    hole: (w) => [[T, H - T], [w - T, H - T], [w - T, MID_HI], [T, MID_HI]],
  },
};

function shapeFrom(points, holePoints) {
  const shape = new THREE.Shape(points);
  if (holePoints) shape.holes.push(new THREE.Path(holePoints));
  return shape;
}

function wordmarkShapes(text, targetWidth) {
  const GAP = 0.15, SPACE = 0.42;
  let x = 0;
  const placed = [];
  for (const ch of text) {
    if (ch === ' ') { x += SPACE; continue; }
    const g = GLYPHS[ch];
    placed.push({ g, x });
    x += g.w + GAP;
  }
  const width = x - GAP;
  const s = targetWidth / width;
  const at = (ox) => ([px, py]) => new THREE.Vector2((px + ox - width / 2) * s, py * s);
  return {
    height: H * s,
    shapes: placed.map(({ g, x: ox }) =>
      shapeFrom(g.outer(g.w).map(at(ox)), g.hole && g.hole(g.w).map(at(ox)))),
  };
}

/* ---------- surface: brushed steel + a studio to reflect ---------- */
function brushedTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#7a7a7a';
  ctx.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 2600; i++) {
    const y = Math.random() * 512, x = Math.random() * 512, len = 60 + Math.random() * 260;
    const v = 90 + Math.random() * 90;
    ctx.strokeStyle = `rgba(${v},${v},${v},${0.12 + Math.random() * 0.2})`;
    ctx.lineWidth = Math.random() * 1.2 + 0.3;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + len, y + (Math.random() - 0.5) * 2); ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(0.35, 0.35);
  tex.anisotropy = 8;
  return tex;
}

function studioEnvironment(renderer) {
  // A dark room with soft light panels: this is what the steel mirrors.
  const room = new THREE.Scene();
  room.background = new THREE.Color(0x0b0c0f);
  const panel = (w, h, pos, intensity) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(intensity, intensity, intensity * 1.04), side: THREE.DoubleSide }));
    m.position.set(...pos);
    m.lookAt(0, 0, 0);
    room.add(m);
  };
  panel(14, 3.5, [0, 9, 4], 5.5);     // key strip overhead
  panel(3, 12, [-11, 1, 5], 3.2);     // left soft box
  panel(3, 12, [11, 1, 5], 3.2);      // right soft box
  panel(10, 1.2, [0, -8, 6], 1.6);    // low fill
  panel(6, 6, [0, 2, 12], 0.9);       // front wash
  panel(16, 2, [0, 6, -10], 2.4);     // back rim
  panel(2, 8, [-9, 0, -8], 1.8);
  panel(2, 8, [9, 0, -8], 1.8);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(room, 0.03).texture;
  pmrem.dispose();
  return env;
}

function glintTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.12, 'rgba(235,242,255,0.55)');
  g.addColorStop(0.4, 'rgba(200,215,255,0.08)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const streak = ctx.createLinearGradient(0, 64, 128, 64);
  streak.addColorStop(0, 'rgba(255,255,255,0)');
  streak.addColorStop(0.5, 'rgba(255,255,255,0.9)');
  streak.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = streak;
  ctx.fillRect(0, 63, 128, 2);
  return new THREE.CanvasTexture(c);
}

/* ---------- mount ---------- */
const VIEWS = {
  front: [0, 0],
  hero: [-0.5, 0.16],
  side: [-Math.PI / 2 + 0.12, 0.05],
  top: [0, 1.15],
  back: [Math.PI, 0],
};
// With pauseOnHover, a hold that starts more than this far from a face (in radians, about 35
// degrees) eases on to the nearest face before it holds still, at this rate (a second and a half
// or so to arrive).
const SETTLE_FROM = 0.61;
const SETTLE_RATE = 2.6;

export function mountLogo(canvas, options = {}) {
  const opts = {
    wordmark: true, autoRotate: true, transparent: false, view: 'hero',
    spinSpeed: 0.28, dwell: 0, bob: 0.06, bobRate: 0.4, spinDelay: 0, resumeAfter: 2500,
    pauseOnHover: false, twoSided: false,
    wheelZoom: true, pinchZoom: true, touchScroll: false, pauseOffscreen: false,
    frame: null, maxPixels: Infinity, reducedMotionStill: false, onReady: null, onLost: null,
    ...options,
  };
  const startView = VIEWS[opts.view] || VIEWS.hero;
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reduceMotion = motionQuery.matches;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: opts.transparent, powerPreference: 'high-performance' });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.environment = studioEnvironment(renderer);
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 200);

  const brushed = brushedTexture();
  const steel = new THREE.MeshStandardMaterial({
    color: 0xd9dde3, metalness: 1, roughness: 0.34, roughnessMap: brushed,
    bumpMap: brushed, bumpScale: 0.6, envMapIntensity: 1.25,
  });
  const steelDark = steel.clone();
  steelDark.color.set(0xb4bac4);
  steelDark.roughness = 0.42;

  // The logo turns as a whole; its body is what is turned round so that, two-sided, the front faces
  // the camera all the way round.
  const logo = new THREE.Group();
  scene.add(logo);
  const body = new THREE.Group();
  logo.add(body);

  // MM mark: faces in bright steel, side walls a shade darker so edges read.
  const markDepth = 0.9;
  const markGeo = new THREE.ExtrudeGeometry(MARK.map((p) => shapeFrom(p.map(toUnit))), {
    depth: markDepth, bevelEnabled: true, bevelThickness: 0.07, bevelSize: 0.05, bevelSegments: 3, curveSegments: 1,
  });
  markGeo.translate(0, 0, -markDepth / 2);
  const mark = new THREE.Mesh(markGeo, [steel, steelDark]);
  body.add(mark);

  // Wordmark and its flanking rules.
  const word = new THREE.Group();
  const wm = wordmarkShapes('MINE MUSTER', 9.9);
  const wordDepth = 0.26;
  const wordGeo = new THREE.ExtrudeGeometry(wm.shapes, {
    depth: wordDepth, bevelEnabled: true, bevelThickness: 0.025, bevelSize: 0.018, bevelSegments: 2, curveSegments: 1,
  });
  wordGeo.translate(0, 0, -wordDepth / 2);
  const wordMesh = new THREE.Mesh(wordGeo, [steel, steelDark]);
  wordMesh.position.y = -3.62;
  word.add(wordMesh);
  for (const side of [-1, 1]) {
    const rule = new THREE.Shape([
      new THREE.Vector2(side * 5.3, 0.012 + wm.height / 2), new THREE.Vector2(side * 7.4, wm.height / 2),
      new THREE.Vector2(side * 5.3, -0.012 + wm.height / 2),
    ]);
    const ruleGeo = new THREE.ExtrudeGeometry(rule, { depth: 0.04, bevelEnabled: false });
    ruleGeo.scale(1, 2.2, 1);
    const ruleMesh = new THREE.Mesh(ruleGeo, steel);
    ruleMesh.position.set(0, -3.62 - wm.height * 0.6, -0.02);
    word.add(ruleMesh);
  }
  word.visible = opts.wordmark;
  body.add(word);

  // Glints on the blade tips, fading as each tip turns away from the viewer.
  const glintMat = new THREE.SpriteMaterial({ map: glintTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
  const glints = [[-5.06, 2.6], [5.06, 2.6], [-0.13, 2.5], [0.12, 2.5], [-5.28, -2.15], [5.28, -2.15]].map(([x, y], i) => {
    const s = new THREE.Sprite(glintMat.clone());
    s.position.set(x, y, markDepth / 2 + 0.05);
    s.userData = { size: i < 2 ? 1.5 : 0.9, phase: i * 1.7 };
    body.add(s);
    return s;
  });

  // A light that follows the pointer so highlights slide across the steel.
  const pointerLight = new THREE.PointLight(0xffffff, 60, 40, 1.6);
  pointerLight.position.set(0, 2, 9);
  scene.add(pointerLight);
  const rim = new THREE.DirectionalLight(0xbcd0ff, 0.6);
  rim.position.set(-6, 5, -8);
  scene.add(rim);

  /* ---- state ---- */
  // vYaw and vPitch are the speed a flick was let go at, in radians a second. spin is how much of
  // the turn by itself is running, from 0 to 1 (spinGoal is its first stage, for a soft start).
  // hovered and focused are a mouse over the logo and keyboard focus on it; wasHeld is whether it
  // was held still on the last frame, and settle the face a hold is easing it on to ({ goal, v }).
  const state = {
    yaw: startView[0], pitch: startView[1], zoom: 1,
    vYaw: 0, vPitch: 0, target: null, dragging: false, lastInput: -1e9,
    auto: opts.autoRotate && !reduceMotion,
    spin: 0, spinGoal: 0, hovered: false, focused: false, wasHeld: false, settle: null,
  };
  const onMotionChange = (e) => { reduceMotion = e.matches; state.auto = opts.autoRotate && !reduceMotion; needsDraw = true; };
  motionQuery.addEventListener('change', onMotionChange);
  const frameCenterY = () => (word.visible ? -0.9 : 0.05);
  const frameSize = () => (word.visible ? opts.frame || { w: 15.6, h: 8.4 } : { w: 11.6, h: 6 });
  let centerY = frameCenterY();
  // Set when something has changed that a still frame has to show (see reducedMotionStill).
  let needsDraw = true;
  const still = () => opts.reducedMotionStill && reduceMotion;

  function resize() {
    const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
    const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(opts.maxPixels / (w * h)));
    renderer.setPixelRatio(ratio);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    needsDraw = true;
  }
  function fitDistance() {
    const { w, h } = frameSize();
    const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    return Math.max(h / 2 / tan, w / 2 / (tan * camera.aspect)) + 1.2;
  }
  new ResizeObserver(resize).observe(canvas);
  resize();

  /* ---- input: drag to rotate, wheel or pinch to zoom, double-tap to reset ---- */
  const pointers = new Map();
  let pinchStart = 0, zoomStart = 1, lastTap = 0;
  const touch = () => { state.lastInput = performance.now(); state.target = null; state.settle = null; needsDraw = true; };
  // With touchScroll, a finger (or pen) is only "aiming" until it has moved far enough to tell a
  // sideways drag, which turns the logo, from a swipe up or down, which the browser scrolls.
  const aims = (e) => opts.touchScroll && e.pointerType !== 'mouse';
  const INTENT = 8;
  const DRAG = 0.0075; // radians the logo turns for each pixel dragged

  // With pinch zoom off, two fingers zoom the page as they would anywhere else on it.
  canvas.style.touchAction = opts.touchScroll ? (opts.pinchZoom ? 'pan-y' : 'pan-y pinch-zoom') : 'none';
  canvas.style.cursor = 'grab';
  const letGo = () => {
    for (const id of pointers.keys()) {
      try { if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id); } catch { /* already gone */ }
    }
    pointers.clear();
    state.dragging = false;
    canvas.style.cursor = 'grab';
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return; // only the main button turns it
    if (aims(e)) {
      // A second finger is a pinch, which is the page's to zoom: the first one stops turning the logo.
      if (!opts.pinchZoom && pointers.size > 0) { letGo(); return; }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now(), live: false, moves: [] });
      return;
    }
    if (!opts.pinchZoom && pointers.size > 0) return;
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, live: true, moves: [{ t: e.timeStamp, x: e.clientX, y: e.clientY }] });
    state.vYaw = state.vPitch = 0; // a hand on it stops a flick
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStart = Math.hypot(a.x - b.x, a.y - b.y);
      zoomStart = state.zoom;
    }
    const now = performance.now();
    if (pointers.size === 1 && now - lastTap < 300) api.setView(opts.view);
    else { state.dragging = true; touch(); }
    lastTap = now;
    canvas.style.cursor = 'grabbing';
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (e.pointerType === 'mouse' && !state.dragging) state.hovered = true;
    if (!aims(e) || (p && p.live)) { // a finger that is scrolling the page leaves the light where it is
      const r = canvas.getBoundingClientRect();
      pointerLight.position.x = ((e.clientX - r.left) / r.width - 0.5) * 16;
      pointerLight.position.y = -((e.clientY - r.top) / r.height - 0.5) * 10 + 1;
      needsDraw = true;
    }
    if (!p) return;
    if (!p.live) {
      const ax = Math.abs(e.clientX - p.x0), ay = Math.abs(e.clientY - p.y0);
      if (ay >= INTENT && ay >= ax) { pointers.delete(e.pointerId); return; } // a scroll: leave it to the page
      if (ax < INTENT) return;
      p.live = true; // a sideways drag: it turns the logo from here on
      // ...from where the finger is now: the distance it moved to show which way it was going is
      // not turned all at once, which would jump the logo and fling it off.
      p.x = e.clientX; p.y = e.clientY;
      p.moves = [{ t: e.timeStamp, x: e.clientX, y: e.clientY }];
      state.vYaw = state.vPitch = 0;
      try { canvas.setPointerCapture(e.pointerId); } catch { /* the pointer may already be gone */ }
      state.dragging = true;
      if (pointers.size === 2 && opts.pinchZoom) {
        const [a, b] = [...pointers.values()];
        pinchStart = Math.hypot(a.x - b.x, a.y - b.y);
        zoomStart = state.zoom;
      }
      touch();
    }
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pointers.size === 2 && opts.pinchZoom) {
      const [a, b] = [...pointers.values()];
      state.zoom = THREE.MathUtils.clamp(zoomStart * (pinchStart / Math.hypot(a.x - b.x, a.y - b.y)), 0.55, 2.2);
      touch();
    } else if (state.dragging) {
      state.yaw += dx * DRAG;
      state.pitch = THREE.MathUtils.clamp(state.pitch + dy * DRAG, -1.45, 1.45);
      // Where the pointer has been in the last moment, for the speed it is let go at.
      p.moves.push({ t: e.timeStamp, x: e.clientX, y: e.clientY });
      while (p.moves.length > 2 && e.timeStamp - p.moves[0].t > 120) p.moves.shift();
      touch();
    }
  });
  // A flick coasts on at the speed it was let go at, measured in time rather than per event, so it
  // goes as far on any screen. A drag that had stopped before it was let go does not coast.
  const fling = (p, at) => {
    state.vYaw = state.vPitch = 0;
    const last = p.moves[p.moves.length - 1];
    if (!last || at - last.t > 80) return;
    const first = p.moves.find((s) => last.t - s.t <= 100);
    const ms = last.t - first.t;
    if (ms < 8) return;
    state.vYaw = THREE.MathUtils.clamp((last.x - first.x) * DRAG * 1000 / ms, -4, 4);
    state.vPitch = THREE.MathUtils.clamp((last.y - first.y) * DRAG * 1000 / ms, -2, 2);
  };
  const release = (e) => {
    const p = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    if (p && p.live && state.dragging && e.type === 'pointerup' && pointers.size === 0) fling(p, e.timeStamp);
    if (p && !p.live && e.type === 'pointerup' && performance.now() - p.t0 < 300) {
      // A tap that never became a drag; two in a row go back to the starting view.
      const now = performance.now();
      if (now - lastTap < 300) { api.setView(opts.view); lastTap = 0; } else lastTap = now;
    }
    if (pointers.size === 0 || ![...pointers.values()].some((q) => q.live)) {
      state.dragging = false; canvas.style.cursor = 'grab';
    }
    if (e.pointerType === 'mouse') {
      // Let go outside the logo, the mouse is no longer over it.
      const r = canvas.getBoundingClientRect();
      state.hovered = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    }
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  // A context menu can swallow the button's release; never leave a pointer stuck turning the logo.
  canvas.addEventListener('lostpointercapture', (e) => { if (pointers.has(e.pointerId)) release(e); });
  canvas.addEventListener('contextmenu', letGo);
  // With pauseOnHover the turn stops while a mouse is over the logo, and while it has focus from the
  // keyboard (not from a click: a mouse that has moved off it lets it turn again).
  canvas.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') state.hovered = true; });
  canvas.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !state.dragging) state.hovered = false; });
  const focusVisible = () => { try { return canvas.matches(':focus-visible'); } catch { return true; } };
  canvas.addEventListener('focus', () => { state.focused = focusVisible(); });
  canvas.addEventListener('blur', () => { state.focused = false; });
  if (opts.wheelZoom) {
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      state.zoom = THREE.MathUtils.clamp(state.zoom * Math.exp(e.deltaY * 0.0012), 0.55, 2.2);
      touch();
    }, { passive: false });
  }
  canvas.addEventListener('keydown', (e) => {
    const step = 0.12;
    if (e.key === 'ArrowLeft') state.yaw -= step;
    else if (e.key === 'ArrowRight') state.yaw += step;
    else if (e.key === 'ArrowUp') state.pitch = Math.max(-1.45, state.pitch - step);
    else if (e.key === 'ArrowDown') state.pitch = Math.min(1.45, state.pitch + step);
    else if (e.key === '+' || e.key === '=') state.zoom = Math.max(0.55, state.zoom * 0.9);
    else if (e.key === '-') state.zoom = Math.min(2.2, state.zoom * 1.1);
    else return;
    e.preventDefault();
    state.focused = true; // turned from the keyboard: it holds still until focus moves on
    touch();
  });

  /* ---- loop ---- */
  const clock = new THREE.Clock();
  const toCamera = new THREE.Vector3(), normal = new THREE.Vector3();
  let dist = fitDistance();
  let readyAt = 0, glintTime = 0;

  function frame() {
    const dt = Math.min(clock.getDelta(), 0.05), t = clock.elapsedTime;
    const now = performance.now();
    const held = opts.pauseOnHover && (state.hovered || state.focused);
    const holdStarts = held && !state.wasHeld;
    state.wasHeld = held;

    if (still()) {
      state.settle = null;
      // Nothing moves by itself: a view is reached at once, a flick does not coast, and an
      // unchanged frame is not drawn again.
      if (state.target) {
        [state.yaw, state.pitch] = state.target;
        state.zoom = 1;
        state.target = null;
        needsDraw = true;
      }
      state.vYaw = state.vPitch = 0;
      state.spin = state.spinGoal = 0;
      if (drawn && !needsDraw) return;
      needsDraw = false;
      centerY = frameCenterY();
      dist = fitDistance() * state.zoom;
    }

    if (state.target) {
      const k = 1 - Math.exp(-dt * 6);
      state.yaw += (state.target[0] - state.yaw) * k;
      state.pitch += (state.target[1] - state.pitch) * k;
      state.zoom += (1 - state.zoom) * k;
      if (Math.abs(state.target[0] - state.yaw) + Math.abs(state.target[1] - state.pitch) < 0.002) state.target = null;
      state.spin = state.spinGoal = 0;
      state.settle = null;
    } else if (!still()) {
      // A hold that starts while it is turning by itself, far from a face, would stop it where it
      // is, perhaps edge on, a sliver that cannot be read. Instead it eases on to the nearest face
      // (forward or back), carrying on from the speed it had, and holds there.
      if (holdStarts && state.auto && !state.dragging && state.spin > 0.05) {
        const period = opts.twoSided ? Math.PI : Math.PI * 2;
        const goal = Math.round(state.yaw / period) * period;
        if (Math.abs(goal - state.yaw) > SETTLE_FROM) {
          const v = opts.spinSpeed * state.spin * (1 + opts.dwell * Math.sin(state.yaw) ** 2) + state.vYaw;
          state.settle = { goal, v };
          state.spin = state.spinGoal = 0;
          state.vYaw = 0;
        }
      }
      if (state.settle && (!held || state.dragging)) {
        // Let go on the way there: the turn by itself takes over from the speed it had.
        const { v } = state.settle;
        const full = opts.spinSpeed * (1 + opts.dwell * Math.sin(state.yaw) ** 2);
        state.spin = state.spinGoal = v > 0 ? Math.min(1, v / full) : 0;
        if (v <= 0) state.vYaw = v;
        state.settle = null;
      }
      if (state.settle) {
        // A critically damped ease: no jump in speed at the start, no swing past the face.
        const s = state.settle;
        s.v += (-2 * SETTLE_RATE * s.v - SETTLE_RATE * SETTLE_RATE * (state.yaw - s.goal)) * dt;
        state.yaw += s.v * dt;
        if (Math.abs(state.yaw - s.goal) < 0.002 && Math.abs(s.v) < 0.01) {
          state.yaw = s.goal;
          state.settle = null;
        }
      }
      if (!state.dragging) {
        // Coast after a flick, slowing to a stop.
        state.yaw += state.vYaw * dt;
        state.pitch = THREE.MathUtils.clamp(state.pitch + state.vPitch * dt, -1.45, 1.45);
        state.vYaw *= Math.exp(-dt * 4); state.vPitch *= Math.exp(-dt * 8);
      }
      // The turn by itself is eased, never switched: it comes in along a soft S curve once the
      // logo has been on the page a moment and nobody has touched it for resumeAfter, stops
      // quickly under a hand, and slows to a stop while a mouse rests on it or it has focus.
      const want = state.auto && drawn && !state.dragging && !held
        && now - readyAt > opts.spinDelay && now - state.lastInput > opts.resumeAfter;
      if (want) {
        const k = 1 - Math.exp(-dt * 3);
        state.spinGoal += (1 - state.spinGoal) * k;
        state.spin += (state.spinGoal - state.spin) * k;
      } else {
        state.spin *= Math.exp(-dt * (state.dragging ? 10 : 3));
        state.spinGoal = state.spin;
        if (state.spin < 1e-4) state.spin = state.spinGoal = 0;
      }
      if (state.spin > 0) {
        state.yaw += dt * opts.spinSpeed * state.spin * (1 + opts.dwell * Math.sin(state.yaw) ** 2);
        if (!state.dragging) {
          const tilt = 0.14 + Math.sin(t * opts.bobRate) * opts.bob;
          state.pitch += (tilt - state.pitch) * (1 - Math.exp(-dt * 1.2)) * state.spin;
        }
      }
      // A turn is a turn: keep the number small after hours of turning.
      if (Math.abs(state.yaw) > 1e4) state.yaw %= Math.PI * 2;
    }

    logo.rotation.set(state.pitch, state.yaw, 0);
    centerY += (frameCenterY() - centerY) * (1 - Math.exp(-dt * 6));
    logo.position.y = -centerY;
    dist += (fitDistance() * state.zoom - dist) * (1 - Math.exp(-dt * 8));
    camera.position.set(0, 0, dist);

    // Two-sided: once the camera is behind the plane through the middle of the logo, its body is
    // turned round, so the face toward the camera is always the front and nothing reads mirrored.
    // At that moment the camera is in the plane itself, both faces are edge on, and the swap does
    // not show.
    normal.set(0, 0, 1).applyEuler(logo.rotation);
    const behind = opts.twoSided && normal.dot(toCamera.copy(camera.position).sub(logo.position)) < 0;
    body.rotation.y = behind ? Math.PI : 0;
    const facing = Math.max(0, behind ? -normal.z : normal.z);
    if (!held) glintTime += dt; // the glints hold still too while the logo is held still
    for (const s of glints) {
      const pulse = reduceMotion ? 0.85 : 0.7 + 0.3 * Math.sin(glintTime * 1.6 + s.userData.phase);
      s.material.opacity = Math.pow(facing, 6) * pulse;
      s.scale.setScalar(s.userData.size * (0.8 + 0.4 * pulse));
    }
    renderer.render(scene, camera);
    // The wait before it turns counts from when the first frame is done, which is when onReady lets
    // the page fade over to it; a first frame can take a while to draw.
    if (!drawn) { drawn = true; readyAt = performance.now(); if (typeof opts.onReady === 'function') opts.onReady(api); }
  }

  // Draw only while it can be seen, when asked to, and only once the shaders are ready.
  let drawn = false, running = false, onScreen = true, ready = false, lost = false;
  const start = () => { if (!running) { running = true; clock.getDelta(); renderer.setAnimationLoop(frame); } };
  const stop = () => { if (running) { running = false; renderer.setAnimationLoop(null); } };
  const update = () => {
    if (!ready || lost) return stop();
    if (!opts.pauseOffscreen) return start();
    return onScreen && !document.hidden ? start() : stop();
  };
  let seen = null;
  if (opts.pauseOffscreen) {
    seen = new IntersectionObserver((entries) => { onScreen = entries[entries.length - 1].isIntersecting; update(); });
    seen.observe(canvas);
    document.addEventListener('visibilitychange', update);
  }

  // A phone can take the WebGL context away (a tab in the background, memory running short). While
  // it is gone nothing is drawn; when it comes back, the studio the steel reflects is made again,
  // since what was drawn into it went with the context.
  const onContextLost = (e) => {
    e.preventDefault();
    lost = true;
    drawn = false;
    update();
    if (typeof opts.onLost === 'function') opts.onLost(api);
  };
  const onContextRestored = () => {
    const old = scene.environment;
    scene.environment = studioEnvironment(renderer);
    if (old) old.dispose();
    // It comes back at the view it started at, which is how whatever stood in for it shows it,
    // and turns by itself again only once it has been back for spinDelay.
    [state.yaw, state.pitch] = startView;
    state.zoom = 1;
    state.target = null;
    state.vYaw = state.vPitch = state.spin = state.spinGoal = 0;
    dist = fitDistance();
    centerY = frameCenterY();
    lost = false;
    needsDraw = true;
    update();
  };
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);

  // Compile the shaders before the first frame, without holding up the page, where the browser can.
  const go = () => { ready = true; update(); };
  if (typeof renderer.compileAsync === 'function' && renderer.extensions.has('KHR_parallel_shader_compile')) {
    renderer.compileAsync(scene, camera).then(go, go);
  } else {
    go();
  }

  const api = {
    setView(name) {
      const v = VIEWS[name] || VIEWS.hero;
      // Take the short way round to the requested yaw. Two-sided, the logo looks the same every
      // half turn, so the nearest half turn will do.
      const period = opts.twoSided ? Math.PI : Math.PI * 2;
      const turns = Math.round((state.yaw - v[0]) / period);
      state.target = [v[0] + turns * period, v[1]];
      state.settle = null;
      state.vYaw = state.vPitch = 0;
      state.lastInput = performance.now();
      needsDraw = true;
    },
    setWordmark(on) { word.visible = !!on; needsDraw = true; },
    setAutoRotate(on) { state.auto = !!on; },
    get autoRotate() { return state.auto; },
    get wordmark() { return word.visible; },
    dispose() {
      ready = false;
      stop();
      if (seen) { seen.disconnect(); document.removeEventListener('visibilitychange', update); }
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      motionQuery.removeEventListener('change', onMotionChange);
      renderer.dispose();
    },
  };
  return api;
}
