// Mine Muster — interactive 3D logo.
// Usage: import { mountLogo } from './logo3d.js'; mountLogo(canvasElement, { wordmark: true });
//
// Options, with the defaults that keep the logo as it is on its own page:
//   wordmark: true        show MINE MUSTER and its rules under the mark
//   autoRotate: true      a slow turntable when nobody is touching it (never with reduced motion)
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

export function mountLogo(canvas, options = {}) {
  const opts = {
    wordmark: true, autoRotate: true, transparent: false, view: 'hero',
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

  const logo = new THREE.Group();
  scene.add(logo);

  // MM mark: faces in bright steel, side walls a shade darker so edges read.
  const markDepth = 0.9;
  const markGeo = new THREE.ExtrudeGeometry(MARK.map((p) => shapeFrom(p.map(toUnit))), {
    depth: markDepth, bevelEnabled: true, bevelThickness: 0.07, bevelSize: 0.05, bevelSegments: 3, curveSegments: 1,
  });
  markGeo.translate(0, 0, -markDepth / 2);
  const mark = new THREE.Mesh(markGeo, [steel, steelDark]);
  logo.add(mark);

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
  logo.add(word);

  // Glints on the blade tips, fading as each tip turns away from the viewer.
  const glintMat = new THREE.SpriteMaterial({ map: glintTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
  const glints = [[-5.06, 2.6], [5.06, 2.6], [-0.13, 2.5], [0.12, 2.5], [-5.28, -2.15], [5.28, -2.15]].map(([x, y], i) => {
    const s = new THREE.Sprite(glintMat.clone());
    s.position.set(x, y, markDepth / 2 + 0.05);
    s.userData = { size: i < 2 ? 1.5 : 0.9, phase: i * 1.7 };
    logo.add(s);
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
  const state = {
    yaw: startView[0], pitch: startView[1], zoom: 1,
    vYaw: 0, vPitch: 0, target: null, dragging: false, lastInput: -1e9,
    auto: opts.autoRotate && !reduceMotion,
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
  const touch = () => { state.lastInput = performance.now(); state.target = null; needsDraw = true; };
  // With touchScroll, a finger (or pen) is only "aiming" until it has moved far enough to tell a
  // sideways drag, which turns the logo, from a swipe up or down, which the browser scrolls.
  const aims = (e) => opts.touchScroll && e.pointerType !== 'mouse';
  const INTENT = 8;

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
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now(), live: false });
      return;
    }
    if (!opts.pinchZoom && pointers.size > 0) return;
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, live: true });
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
      const k = 0.0075;
      state.vYaw = dx * k * 0.5; state.vPitch = dy * k * 0.25;
      state.yaw += dx * k;
      state.pitch = THREE.MathUtils.clamp(state.pitch + dy * k, -1.45, 1.45);
      touch();
    }
  });
  const release = (e) => {
    const p = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    if (p && !p.live && e.type === 'pointerup' && performance.now() - p.t0 < 300) {
      // A tap that never became a drag; two in a row go back to the starting view.
      const now = performance.now();
      if (now - lastTap < 300) { api.setView(opts.view); lastTap = 0; } else lastTap = now;
    }
    if (pointers.size === 0 || ![...pointers.values()].some((q) => q.live)) {
      state.dragging = false; canvas.style.cursor = 'grab';
    }
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  // A context menu can swallow the button's release; never leave a pointer stuck turning the logo.
  canvas.addEventListener('lostpointercapture', (e) => { if (pointers.has(e.pointerId)) release(e); });
  canvas.addEventListener('contextmenu', letGo);
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
    touch();
  });

  /* ---- loop ---- */
  const clock = new THREE.Clock();
  const worldPos = new THREE.Vector3(), normal = new THREE.Vector3();
  let dist = fitDistance();

  function frame() {
    const dt = Math.min(clock.getDelta(), 0.05), t = clock.elapsedTime;
    const idle = performance.now() - state.lastInput > 2500;

    if (still()) {
      // Nothing moves by itself: a view is reached at once, a flick does not coast, and an
      // unchanged frame is not drawn again.
      if (state.target) {
        [state.yaw, state.pitch] = state.target;
        state.zoom = 1;
        state.target = null;
        needsDraw = true;
      }
      state.vYaw = state.vPitch = 0;
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
    } else if (!state.dragging && !still()) {
      // Coast after a flick, then drift into a slow turntable.
      state.yaw += state.vYaw; state.pitch = THREE.MathUtils.clamp(state.pitch + state.vPitch, -1.45, 1.45);
      const decay = Math.exp(-dt * 4);
      state.vYaw *= decay; state.vPitch *= decay;
      if (state.auto && idle) {
        state.yaw += dt * 0.28;
        state.pitch += (0.14 + Math.sin(t * 0.4) * 0.06 - state.pitch) * (1 - Math.exp(-dt * 1.2));
      }
    }

    logo.rotation.set(state.pitch, state.yaw, 0);
    centerY += (frameCenterY() - centerY) * (1 - Math.exp(-dt * 6));
    logo.position.y = -centerY;
    dist += (fitDistance() * state.zoom - dist) * (1 - Math.exp(-dt * 8));
    camera.position.set(0, 0, dist);

    normal.set(0, 0, 1).applyEuler(logo.rotation);
    const facing = Math.max(0, normal.z);
    for (const s of glints) {
      const pulse = reduceMotion ? 0.85 : 0.7 + 0.3 * Math.sin(t * 1.6 + s.userData.phase);
      s.material.opacity = Math.pow(facing, 6) * pulse;
      s.scale.setScalar(s.userData.size * (0.8 + 0.4 * pulse));
    }
    renderer.render(scene, camera);
    if (!drawn) { drawn = true; if (typeof opts.onReady === 'function') opts.onReady(api); }
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
      // Take the short way round to the requested yaw.
      const turns = Math.round((state.yaw - v[0]) / (Math.PI * 2));
      state.target = [v[0] + turns * Math.PI * 2, v[1]];
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
