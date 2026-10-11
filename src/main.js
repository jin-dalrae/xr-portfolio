import * as THREE from 'three';
import { STONES, makeSmallStones, makeBackground, makeGlassMaterial, makeStoneGeometry, makeGlowTexture } from './glass.js';
import { makeFloor, makeShadow, floorHeight, floorNormal } from './floor.js';
import { createHandLandmarker, pinchRatio, palmSize, fingerCurl, HAND_EDGES, WRIST, THUMB_TIP, INDEX_TIP } from './hands.js';

// ---------- tuning ----------
const PINCH_ON = 0.3, PINCH_OFF = 0.44;   // thumb–index ratio: grab / let go
const FIST_ON = 1.25, FIST_OFF = 1.45;    // finger curl: close / open
const PICK_SLACK_PX = 36;                 // forgiveness around a stone's silhouette
const Z_MIN = -7, Z_MAX = 3;              // depth of the room (camera sits at z = 10)

// Hand depth comes from palm size (palm / video height). Tune to your reach;
// open the page with #debug to see the live value next to your hand.
const HAND_NEAR = 0.36;                   // palm ratio with your hand close to the camera
const HAND_FAR = 0.12;                    // palm ratio at full arm's length
const LM_Z_GAIN = 1.0;                    // how much per-finger depth (from MediaPipe) is trusted

const TIP_RADIUS = 0.24, PALM_RADIUS = 0.5;
const TOUCH_BOUNCE = 0.4;                 // restitution for fast hand hits
const SQUISH_SPEED = 2.2;                 // slower than this, a fingertip dents instead of batting
const MAX_DENT = 0.35;                    // fraction of radius a stone can be dented
const TOUCH_GLOW_DIST = 0.8;              // stones glow when a fingertip is this close

const GRAVITY = 14;
const FLOAT_DRAG = 0.8, PILE_DRAG = 0.25, ESCAPE_DRAG = 0.12;
const RESTITUTION = 0.6, FLOOR_BOUNCE = 0.35, FLOOR_FRICTION = 2.5;
const ESCAPE_SPEED = 10;                  // throws faster than this leave the room
const THROW_BOOST = 1.35;
const FLICK_SPEED = 16;                   // fast hand + loosening grip = release now
const MAX_THROW = 50;
const MIN_SIZE = 0.35, MAX_SIZE = 3.2;    // two-hand stretch limits
const DOF_RANGE = 4.5;                    // depth distance at which a stone is fully defocused
const JELLY_K = 160, JELLY_C = 7;         // slime spring: stiffness / damping

// ---------- DOM ----------
const canvas = document.getElementById('gl');
const overlay = document.getElementById('overlay');
const ctx = overlay.getContext('2d');
const video = document.getElementById('video');
const intro = document.getElementById('intro');
const statusEl = document.getElementById('status');
const hintEl = document.getElementById('hint');
const toolbar = document.getElementById('toolbar');
const DEBUG = location.hash.includes('debug');

function setStatus(text) {
  if (text) statusEl.textContent = text; // keep old text while fading out
  statusEl.classList.toggle('hidden', !text);
}

// ---------- three ----------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
camera.position.set(0, 0, 10);
const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
const clamp = THREE.MathUtils.clamp;
const rand = THREE.MathUtils.randFloat;

const shared = {
  uVideo: { value: null },
  uHasVideo: { value: 0 },
  uVideoScale: { value: new THREE.Vector2(1, 1) },
  uResolution: { value: new THREE.Vector2(1, 1) },
  uTime: { value: 0 },
  uAspect: { value: 1 },
};
scene.add(makeBackground(shared));
const floor = makeFloor();
scene.add(floor);

let W = 1, H = 1;
function resize() {
  W = window.innerWidth; H = window.innerHeight;
  renderer.setSize(W, H, false);
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
  renderer.getDrawingBufferSize(shared.uResolution.value);
  shared.uAspect.value = W / H;
  const dpr = Math.min(window.devicePixelRatio, 2);
  overlay.width = W * dpr; overlay.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  updateVideoScale();
}

// "cover" fit: fraction of the video visible on each axis
function updateVideoScale() {
  if (!video.videoWidth) return;
  const va = video.videoWidth / video.videoHeight, sa = W / H;
  if (sa > va) shared.uVideoScale.value.set(1, va / sa);
  else shared.uVideoScale.value.set(sa / va, 1);
}
window.addEventListener('resize', resize);

const halfExtents = (z) => { const hh = tanHalf * (camera.position.z - z); return { hw: hh * camera.aspect, hh }; };
const perspective = (z) => camera.position.z / (camera.position.z - z); // on-screen scale vs z = 0

// ---------- world mode ----------
let gravityOn = true;   // "Pile": stones rest in the tray. "Float": zero-g.
let pileFade = 1;       // eases floor + shadows in and out

function setMode(mode) {
  gravityOn = mode === 'pile';
  for (const btn of toolbar.querySelectorAll('[data-mode]')) btn.classList.toggle('on', btn.dataset.mode === mode);
  if (!gravityOn) {
    // lift off the tray into the room
    for (const b of beads) if (b.state === 'free' && !b.holders.length) b.vel.y += rand(2.5, 5);
  }
}

// ---------- stones ----------
const ALL_STONES = [...STONES, ...makeSmallStones(22)];

const beads = ALL_STONES.map((stone, i) => {
  const geo = makeStoneGeometry(stone.kind, i + 1, stone.small ? 14 : 24);
  const mat = makeGlassMaterial(shared, stone);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.set(rand(0, 6), rand(0, 6), rand(0, 6));
  scene.add(mesh);
  const { shadow, caustic } = makeShadow(stone.tint);
  scene.add(shadow, caustic);
  const baseR = geo.boundingSphere.radius * stone.size * 0.92;
  return {
    stone, mesh, mat, shadow, caustic,
    baseR, r: baseR, size: stone.size, sizeMul: 1,
    mass: baseR ** 3,
    pos: mesh.position,
    vel: new THREE.Vector3(),
    prev: new THREE.Vector3(),
    angVel: new THREE.Vector3(rand(-0.3, 0.3), rand(-0.3, 0.3), rand(-0.2, 0.2)),
    idleSpin: new THREE.Vector3(rand(-0.15, 0.15), rand(-0.25, 0.25), rand(-0.1, 0.1)),
    seed: Math.random() * 100,
    state: 'gone', goneTimer: 0.2 + i * 0.05,
    spawnT: 1, spawnFrom: 0, spawnTo: 0,
    holders: [], stretch0: 0, size0: 1,
    hover: 0, near: 0, grabPop: 0, onFloor: false,
    escaping: false,
    // slime state
    jx: 0, jv: 0, jTarget: 0, jAxis: new THREE.Vector3(0, 1, 0),
    dent: 0, dv: 0, dentTarget: 0, dentDir: new THREE.Vector3(0, 0, 1),
  };
});
const isHeld = (b) => b.holders.length > 0;

function setSize(b, mul) {
  b.sizeMul = mul;
  b.r = b.baseR * mul;
  b.mass = b.r ** 3;
}

function spawn(b) {
  b.vel.set(0, 0, 0);
  b.escaping = false;
  b.spawnT = 0;
  b.jx = b.jv = b.dent = b.dv = 0;
  b.mesh.visible = true;
  if (gravityOn) {
    // drop in from above, toward the middle of the tray
    const z = rand(-3, 1.2);
    const { hw, hh } = halfExtents(z);
    b.pos.set(rand(-hw, hw) * 0.45, hh + b.r + rand(0, 1.5), z);
    b.state = 'free';
    return;
  }
  // float: emerge from the depth into the least crowded spot
  let best = null, bestScore = -Infinity;
  for (let k = 0; k < 16; k++) {
    const z = rand(-5, 1.5);
    const { hw, hh } = halfExtents(z);
    const c = new THREE.Vector3(rand(-hw + b.r, hw - b.r) * 0.85, rand(-hh + b.r, hh - b.r) * 0.8, z);
    let score = Infinity;
    for (const o of beads) if (o !== b && o.state !== 'gone') score = Math.min(score, c.distanceTo(o.pos) - o.r - b.r);
    if (score > bestScore) { bestScore = score; best = c; }
  }
  b.pos.set(best.x, best.y, best.z - 7);
  b.spawnFrom = best.z - 7; b.spawnTo = best.z;
  b.state = 'spawning';
}

function resetAll() {
  for (const p of pointers) p.held = null;
  beads.forEach((b, i) => {
    b.holders.length = 0;
    setSize(b, 1);
    b.state = 'gone'; b.mesh.visible = false; b.goneTimer = i * 0.04;
  });
}

// ---------- pointers (hands + mouse share one model) ----------
const TIP_IDS = [4, 8, 12, 16, 20];          // fingertips (get glowing orbs)
const KNUCKLE_IDS = [6, 10, 14, 18];         // middle joints, so sideways sweeps connect
const glowTex = makeGlowTexture();

function makeCollider(r) {
  return { r, pos: new THREE.Vector3(), prev: new THREE.Vector3(), vel: new THREE.Vector3(), fresh: false };
}

function makePointer(kind) {
  const p = {
    kind, visible: false, lastSeen: 0,
    x: 0, y: 0,                    // pinch point (screen px)
    palmX: 0, palmY: 0, palmZ: 0,  // palm center, used for fist grabs
    gx: 0, gy: 0, gz: null,        // active grab point
    pinch: false, fist: false, wasGrip: false,
    pinchAmt: 0, ratio: 1, curl: 2, squeeze: 0,
    palmR: 0, handZ: 0, pinchZ: 0, zOffset: 0,
    held: null, gripMode: 'pinch', grabZ: 0, depthSm: 0, wheelZ: 0,
    target: new THREE.Vector3(), raw: new THREE.Vector3(),
    history: [], fresh: false,
    hover: null, landmarks: null, wrist: null,
    colliders: [], orbs: [],
  };
  if (kind === 'hand') {
    p.colliders = [...TIP_IDS, ...KNUCKLE_IDS].map(() => makeCollider(TIP_RADIUS));
    p.colliders.push(makeCollider(PALM_RADIUS));
    p.orbs = TIP_IDS.map((id) => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      s.visible = false;
      s.renderOrder = 1;
      s.userData.base = id === THUMB_TIP || id === INDEX_TIP ? 0.42 : 0.3;
      scene.add(s);
      return s;
    });
  }
  return p;
}
const handPtrs = [makePointer('hand'), makePointer('hand')];
const mouse = makePointer('mouse');
const pointers = [...handPtrs, mouse];

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function screenToWorld(x, y, z, out) {
  ndc.set((x / W) * 2 - 1, -(y / H) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const o = raycaster.ray.origin, d = raycaster.ray.direction;
  const t = (z - o.z) / d.z;
  return out.copy(o).addScaledVector(d, t);
}
const tmpV = new THREE.Vector3();
function worldToScreen(v) {
  tmpV.copy(v).project(camera);
  return [(tmpV.x * 0.5 + 0.5) * W, (-tmpV.y * 0.5 + 0.5) * H];
}
const screenRadius = (b) => (b.r / (2 * tanHalf * (camera.position.z - b.pos.z))) * H;

// 2D proximity decides; depth only breaks ties, since judging depth by eye is hard.
// A stone already held by one hand can be taken by a second hand (to stretch it).
function pick(x, y, z, p, slackMul = 1) {
  let best = null, bestScore = Infinity;
  for (const b of beads) {
    if (b.state === 'gone' || (b.state === 'spawning' && b.spawnT < 0.5)) continue;
    if (isHeld(b) && (b.holders.length > 1 || b.holders[0] === p)) continue;
    const [sx, sy] = worldToScreen(b.pos);
    const score = Math.hypot(sx - x, sy - y) / (screenRadius(b) + PICK_SLACK_PX * slackMul);
    if (score >= 1) continue;
    const adj = score + (z == null ? -b.pos.z * 0.01 : Math.abs(b.pos.z - z) * 0.12);
    if (adj < bestScore) { bestScore = adj; best = b; }
  }
  return best;
}

function grab(p, b, mode) {
  p.held = b;
  p.gripMode = mode;
  p.grabZ = b.pos.z; p.depthSm = b.pos.z; p.wheelZ = 0;
  p.zOffset = p.gz == null ? 0 : b.pos.z - p.gz;   // stone eases from its depth to your hand's
  p.history.length = 0;
  screenToWorld(p.gx, p.gy, b.pos.z, p.raw);
  p.target.copy(p.raw);
  if (b.holders.length === 1) {
    // second hand: start a stretch
    const o = b.holders[0];
    b.stretch0 = Math.max(Math.hypot(o.target.x - p.raw.x, o.target.y - p.raw.y), 0.4);
    b.size0 = b.sizeMul;
    b.holders.push(p);
  } else {
    b.holders = [p];
  }
  b.escaping = false;
  b.grabPop = 1;
  b.state = 'free';
  b.spawnT = Math.max(b.spawnT, 0.99);
  hideHintSoon();
}

// Peak hand velocity over short windows of the most recent *tracked* samples.
// Anchored to the last sample (not "now") so a throw survives the hand blurring
// out of tracking mid-flick.
function throwVelocity(h) {
  if (h.length < 2) return null;
  const tEnd = h[h.length - 1].t;
  let best = null, bestS = -1;
  for (let i = h.length - 1; i >= 1; i--) {
    if (tEnd - h[i].t > 200) break;
    for (let j = i - 1; j >= 0; j--) {
      const dt = (h[i].t - h[j].t) / 1000;
      if (dt < 0.045) continue;
      if (dt > 0.16) break;
      const v = h[i].p.clone().sub(h[j].p).divideScalar(dt);
      const s = v.length();
      if (s > bestS) { bestS = s; best = v; }
      break;
    }
  }
  return best;
}

function release(p) {
  const b = p.held;
  p.held = null;
  if (!b) return;
  b.holders = b.holders.filter((h) => h !== p);
  const v = throwVelocity(p.history) || b.vel.clone();
  p.history.length = 0;
  if (b.holders.length) return; // the other hand still has it
  v.multiplyScalar(THROW_BOOST);
  v.z *= 0.6; // depth from palm size is noisy; don't let it dominate a throw
  if (v.length() > MAX_THROW) v.setLength(MAX_THROW);
  b.vel.copy(v);
  b.angVel.set(-v.y, v.x, rand(-1, 1)).multiplyScalar(0.45 / b.sizeMul);
  b.escaping = Math.hypot(v.x, v.y) > ESCAPE_SPEED || v.z < -ESCAPE_SPEED;
  // let go: the slime boings back
  b.jv += Math.min(v.length() * 0.05, 1.5);
}

function updatePointer(p, dt, now) {
  if (!p.visible) {
    if (p.held) release(p);
    p.hover = null; p.wasGrip = false;
    return;
  }
  // where this pointer grabs from: palm for a fist, between thumb & index for a pinch
  const usePalm = p.kind === 'hand' && (p.held ? p.gripMode === 'fist' : p.fist);
  if (usePalm) { p.gx = p.palmX; p.gy = p.palmY; p.gz = p.palmZ; }
  else { p.gx = p.x; p.gy = p.y; p.gz = p.kind === 'hand' ? p.pinchZ : null; }

  const grip = p.pinch || p.fist;
  if (grip && !p.wasGrip && !p.held) {
    const b = pick(p.gx, p.gy, p.gz, p, p.fist ? 2 : 1);
    if (b) grab(p, b, p.fist ? 'fist' : 'pinch');
  }
  if (p.held && !(p.gripMode === 'fist' ? p.fist : p.pinch)) release(p);

  // flick: hand moving fast while the grip loosens -> let go now, not 100ms later
  if (p.held && p.kind === 'hand') {
    const loosening = p.gripMode === 'fist' ? p.curl > FIST_ON + 0.08 : p.ratio > PINCH_ON + 0.06;
    const v = loosening && throwVelocity(p.history);
    if (v && v.length() > FLICK_SPEED) { release(p); p.pinch = p.fist = false; }
  }
  p.wasGrip = p.pinch || p.fist;

  if (p.held) {
    const b = p.held;
    let z;
    if (p.kind === 'hand') {
      p.zOffset *= Math.exp(-dt * 2.5);
      z = p.gz + p.zOffset;
    } else {
      z = p.grabZ + p.wheelZ;
    }
    z = clamp(z, Z_MIN + b.r, Z_MAX - b.r);
    p.depthSm += (z - p.depthSm) * (1 - Math.exp(-dt * 12));
    screenToWorld(p.gx, p.gy, p.depthSm, p.raw);
    if (p.fresh) {
      p.history.push({ t: now, p: p.raw.clone() });
      while (p.history.length && now - p.history[0].t > 400) p.history.shift();
    }
    const { hw, hh } = halfExtents(p.depthSm);
    p.target.copy(p.raw);
    p.target.x = clamp(p.target.x, -hw - b.r * 0.5, hw + b.r * 0.5);
    p.target.y = clamp(p.target.y, -hh - b.r * 0.5, hh + b.r * 0.5);
    p.hover = null;
  } else {
    p.hover = grip ? null : pick(p.gx, p.gy, p.gz, p);
  }
  p.fresh = false;
}

// ---------- mouse ----------
canvas.addEventListener('pointerdown', (e) => {
  Object.assign(mouse, { visible: true, x: e.clientX, y: e.clientY, pinch: true, fresh: true });
});
window.addEventListener('pointermove', (e) => {
  Object.assign(mouse, { visible: true, x: e.clientX, y: e.clientY, fresh: true });
});
window.addEventListener('pointerup', () => { mouse.pinch = false; });
document.addEventListener('pointerleave', () => { mouse.visible = false; mouse.pinch = false; });
canvas.addEventListener('wheel', (e) => {
  if (!mouse.held) return;
  e.preventDefault();
  if (e.shiftKey || e.altKey) {
    const b = mouse.held;
    setSize(b, clamp(b.sizeMul * Math.exp(-(e.deltaY || e.deltaX) * 0.002), MIN_SIZE, MAX_SIZE));
    b.jv += 0.3;
  } else {
    mouse.wheelZ -= e.deltaY * 0.004;
  }
}, { passive: false });
window.addEventListener('keydown', (e) => {
  if (e.key === 'r' || e.key === 'R') resetAll();
  if (e.key === 'g' || e.key === 'G') setMode(gravityOn ? 'float' : 'pile');
});

// ---------- hands ----------
let landmarker = null;
let lastVideoTime = -1;
const HAND_GRACE_MS = 180;

function lmToScreen(l) {
  const s = shared.uVideoScale.value;
  return [(((1 - l.x) - 0.5) / s.x + 0.5) * W, ((l.y - 0.5) / s.y + 0.5) * H];
}

// palm ratio -> world z, linear in apparent distance (1 / size)
function handDepth(palmR) {
  const near = 1 / HAND_NEAR, far = 1 / HAND_FAR;
  const t = clamp((1 / Math.max(palmR, 1e-3) - near) / (far - near), 0, 1);
  return THREE.MathUtils.lerp(Z_MAX - 0.3, Z_MIN + 0.5, t);
}

function placeCollider(c, sx, sy, z, dtS, continuous) {
  c.prev.copy(c.pos);
  screenToWorld(sx, sy, z, c.pos);
  if (!continuous) { c.prev.copy(c.pos); c.vel.set(0, 0, 0); }
  else c.vel.subVectors(c.pos, c.prev).divideScalar(Math.max(dtS, 1 / 120));
  c.fresh = true;
}

function hideHand(p) {
  p.visible = false; p.pinch = false; p.fist = false; p.landmarks = null;
  for (const o of p.orbs) o.visible = false;
}

function processHands(result, now) {
  const hands = result.landmarks || [];
  const vw = video.videoWidth, vh = video.videoHeight;
  const wrists = hands.map((lm) => lmToScreen(lm[WRIST]));

  // keep each physical hand in the same slot across frames
  const cost = (slot, i) => (slot.visible && slot.wrist ? Math.hypot(slot.wrist[0] - wrists[i][0], slot.wrist[1] - wrists[i][1]) : 1e5);
  let assign = [];
  if (hands.length === 1) assign = cost(handPtrs[0], 0) <= cost(handPtrs[1], 0) ? [0] : [1];
  else if (hands.length >= 2) {
    const straight = cost(handPtrs[0], 0) + cost(handPtrs[1], 1);
    const swapped = cost(handPtrs[1], 0) + cost(handPtrs[0], 1);
    assign = straight <= swapped ? [0, 1] : [1, 0];
  }

  assign.forEach((slotIdx, i) => {
    const p = handPtrs[slotIdx];
    const lm = hands[i];
    const dtS = (now - p.lastSeen) / 1000;
    const continuous = p.visible && dtS < 0.2;
    p.visible = true;
    p.lastSeen = now;
    p.landmarks = lm;
    p.wrist = wrists[i];

    // depth of the hand in the room
    p.palmR = palmSize(lm, vw, vh) / vh;
    const zRaw = handDepth(p.palmR);
    p.handZ = continuous ? p.handZ + (zRaw - p.handZ) * 0.4 : zRaw;
    const { hw } = halfExtents(p.handZ);
    const zScale = (LM_Z_GAIN * 2 * hw) / shared.uVideoScale.value.x; // MediaPipe z is in image-width units
    const lmZ = (id) => p.handZ - lm[id].z * zScale;

    // pinch point
    p.thumb = lmToScreen(lm[THUMB_TIP]);
    p.index = lmToScreen(lm[INDEX_TIP]);
    const a = continuous ? 0.65 : 1;
    p.x += ((p.thumb[0] + p.index[0]) / 2 - p.x) * a;
    p.y += ((p.thumb[1] + p.index[1]) / 2 - p.y) * a;
    p.pinchZ = (lmZ(THUMB_TIP) + lmZ(INDEX_TIP)) / 2;

    p.ratio = pinchRatio(lm, vw, vh);
    if (!p.pinch && p.ratio < PINCH_ON) p.pinch = true;
    else if (p.pinch && p.ratio > PINCH_OFF) p.pinch = false;
    p.pinchAmt = clamp((0.85 - p.ratio) / (0.85 - PINCH_ON), 0, 1);

    p.curl = fingerCurl(lm, vw, vh);
    if (!p.fist && p.curl < FIST_ON) p.fist = true;
    else if (p.fist && p.curl > FIST_OFF) p.fist = false;
    p.squeeze = clamp((FIST_ON + 0.05 - p.curl) / 0.35, 0, 1);

    // physical colliders: fingertips, knuckles, palm
    [...TIP_IDS, ...KNUCKLE_IDS].forEach((id, k) => {
      const [sx, sy] = lmToScreen(lm[id]);
      placeCollider(p.colliders[k], sx, sy, lmZ(id), dtS, continuous);
    });
    let px = 0, py = 0, pz = 0;
    for (const id of [0, 5, 9, 17]) { const [sx, sy] = lmToScreen(lm[id]); px += sx; py += sy; pz += lmZ(id); }
    px /= 4; py /= 4; pz /= 4;
    p.palmX += (px - p.palmX) * a; p.palmY += (py - p.palmY) * a; p.palmZ = pz;
    placeCollider(p.colliders[p.colliders.length - 1], px, py, pz, dtS, continuous);

    p.fresh = true;
  });

  for (const p of handPtrs) if (p.visible && now - p.lastSeen > HAND_GRACE_MS) hideHand(p);
}

// ---------- physics ----------
const n = new THREE.Vector3(), rv = new THREE.Vector3(), axis = new THREE.Vector3();
const seg = new THREE.Vector3(), closest = new THREE.Vector3(), tang = new THREE.Vector3();
const mid = new THREE.Vector3(), tmpQ = new THREE.Quaternion();
let time = 0;

// open hand = physical; pinch or fist = grabbing (so fingers don't shove the stone you're reaching for)
const handIsTouching = (p) => p.visible && !p.held && !p.fist && p.pinchAmt < 0.45;

function jellyKick(b, normal, speed) {
  if (speed < 1.2) return;
  b.jAxis.copy(normal);
  b.jv -= Math.min(speed * 0.12, 2.2) / Math.sqrt(b.sizeMul);
}

function handTouches() {
  for (const b of beads) b.dentTarget = 0;
  for (const p of handPtrs) {
    if (!handIsTouching(p)) { for (const c of p.colliders) c.fresh = false; continue; }
    for (const c of p.colliders) {
      // swept test: on a new tracking frame the finger travelled prev -> pos, catch anything in between
      const A = c.fresh ? c.prev : c.pos;
      seg.subVectors(c.pos, A);
      const len2 = seg.lengthSq();
      const speed = c.vel.length();
      for (const b of beads) {
        if (b.state !== 'free' || isHeld(b)) continue;
        const t = len2 > 1e-8 ? clamp(rv.subVectors(b.pos, A).dot(seg) / len2, 0, 1) : 0;
        closest.copy(A).addScaledVector(seg, t);
        n.subVectors(b.pos, closest);
        const d = n.length(), minD = b.r + c.r;
        if (d >= minD) continue;
        if (d < 1e-5) n.copy(seg).normalize(); else n.divideScalar(d);
        const overlap = minD - d;

        if (speed < SQUISH_SPEED && t >= 1) {
          // slow press: the slime gives way first, then the stone moves
          const give = Math.min(overlap, b.r * MAX_DENT);
          if (give > b.dentTarget) { b.dentTarget = give; b.dentDir.copy(n).negate(); }
          b.pos.addScaledVector(n, overlap - give);
          rv.subVectors(b.vel, c.vel);
          const vn = rv.dot(n);
          if (vn < 0) b.vel.addScaledVector(n, -vn * 0.6);
          continue;
        }

        if (t < 1 && len2 > 1e-8) n.addScaledVector(seg, 1 / Math.sqrt(len2)).normalize(); // swept hit: follow the swing
        b.pos.copy(closest).addScaledVector(n, minD);
        rv.subVectors(b.vel, c.vel);
        const vn = rv.dot(n);
        if (vn < 0) {
          b.vel.addScaledVector(n, -(1 + TOUCH_BOUNCE) * vn);
          // a little friction drags the stone along with the finger, and spins it
          tang.copy(rv).addScaledVector(n, -vn);
          b.vel.addScaledVector(tang, -0.25);
          b.angVel.add(axis.crossVectors(n, tang).multiplyScalar(-0.6));
          b.grabPop = Math.max(b.grabPop, clamp(-vn / 12, 0.15, 0.8));
          jellyKick(b, n, -vn);
          if (Math.hypot(b.vel.x, b.vel.y) > ESCAPE_SPEED * 1.4) b.escaping = true;
          hideHintSoon();
        }
      }
      c.fresh = false;
    }
  }
}

function collideStones() {
  for (let i = 0; i < beads.length; i++) {
    const a = beads[i];
    if (a.state !== 'free') continue;
    for (let j = i + 1; j < beads.length; j++) {
      const b = beads[j];
      if (b.state !== 'free') continue;
      n.copy(a.pos).sub(b.pos);
      const minD = a.r + b.r;
      const d2 = n.lengthSq();
      if (d2 >= minD * minD || d2 < 1e-12) continue;
      const d = Math.sqrt(d2);
      n.divideScalar(d);
      const ia = isHeld(a) ? 0 : 1 / a.mass, ib = isHeld(b) ? 0 : 1 / b.mass;
      if (ia + ib === 0) continue;
      const overlap = minD - d;
      a.pos.addScaledVector(n, (overlap * ia) / (ia + ib));
      b.pos.addScaledVector(n, (-overlap * ib) / (ia + ib));
      rv.copy(a.vel).sub(b.vel);
      const vn = rv.dot(n);
      if (vn < 0) {
        const e = vn > -1 ? 0 : RESTITUTION; // resting contacts don't bounce, so piles settle
        const jImp = (-(1 + e) * vn) / (ia + ib);
        a.vel.addScaledVector(n, jImp * ia);
        b.vel.addScaledVector(n, -jImp * ib);
        tang.copy(rv).addScaledVector(n, -vn);
        const fr = gravityOn ? 0.15 : 0;  // contact friction keeps stacks from sliding apart
        a.vel.addScaledVector(tang, (-fr * ia) / (ia + ib));
        b.vel.addScaledVector(tang, (fr * ib) / (ia + ib));
        a.angVel.add(axis.crossVectors(n, tang).multiplyScalar(-0.3 * ia * a.mass));
        b.angVel.add(axis.crossVectors(n, tang).multiplyScalar(0.3 * ib * b.mass));
        if (vn < -1.5) { jellyKick(a, n, -vn); jellyKick(b, n, -vn); }
      }
    }
  }
}

function bounds(dt) {
  for (const b of beads) {
    if (b.state !== 'free' || isHeld(b)) continue;
    const { hw, hh } = halfExtents(b.pos.z);
    if (b.escaping) {
      if (Math.abs(b.pos.x) > hw + b.r * 1.5 || b.pos.z < -40 || (!gravityOn && Math.abs(b.pos.y) > hh + b.r * 1.5)) {
        b.state = 'gone'; b.mesh.visible = false; b.goneTimer = 0.9;
        continue;
      }
    } else {
      if (b.pos.x > hw - b.r) { b.pos.x = hw - b.r; if (b.vel.x > 0) b.vel.x *= -RESTITUTION; }
      if (b.pos.x < -hw + b.r) { b.pos.x = -hw + b.r; if (b.vel.x < 0) b.vel.x *= -RESTITUTION; }
      if (!gravityOn) {
        if (b.pos.y > hh - b.r) { b.pos.y = hh - b.r; if (b.vel.y > 0) b.vel.y *= -RESTITUTION; }
        if (b.pos.y < -hh + b.r) { b.pos.y = -hh + b.r; if (b.vel.y < 0) b.vel.y *= -RESTITUTION; }
      }
      if (b.pos.z < Z_MIN + b.r) { b.pos.z = Z_MIN + b.r; if (b.vel.z < 0) b.vel.z *= -RESTITUTION; }
    }
    if (b.pos.z > Z_MAX - b.r) { b.pos.z = Z_MAX - b.r; if (b.vel.z > 0) b.vel.z *= -RESTITUTION; }

    if (gravityOn) {
      const pen = floorHeight(b.pos.x, b.pos.z) + b.r - b.pos.y;
      if (pen > 0) {
        floorNormal(b.pos.x, b.pos.z, n);
        b.pos.addScaledVector(n, pen * n.y);
        const vn = b.vel.dot(n);
        if (vn < 0) {
          b.vel.addScaledVector(n, -(1 + (vn < -1.5 ? FLOOR_BOUNCE : 0)) * vn);
          jellyKick(b, n, -vn);
        }
        tang.copy(b.vel).addScaledVector(n, -b.vel.dot(n));
        b.vel.addScaledVector(tang, -(1 - Math.exp(-dt * FLOOR_FRICTION)));
        b.onFloor = true;
      }
    }
  }
}

function physics(dt) {
  for (const b of beads) { b.jTarget = 0; b.onFloor = false; }

  for (const b of beads) {
    if (b.state === 'gone') {
      b.goneTimer -= dt;
      if (b.goneTimer <= 0) spawn(b);
      continue;
    }
    b.spawnT = Math.min(1, b.spawnT + dt / 1.2);
    if (b.state === 'spawning') {
      const e = 1 - Math.pow(1 - b.spawnT, 3);
      b.pos.z = b.spawnFrom + (b.spawnTo - b.spawnFrom) * e;
      if (b.spawnT >= 1) b.state = 'free';
    }

    b.prev.copy(b.pos);
    if (isHeld(b)) {
      const [h0, h1] = b.holders;
      if (h1) {
        // two hands: the stone sits between them and scales with their spread
        mid.addVectors(h0.target, h1.target).multiplyScalar(0.5);
        b.pos.lerp(mid, 1 - Math.exp(-dt * 20));
        const spread = Math.hypot(h0.target.x - h1.target.x, h0.target.y - h1.target.y);
        const ratio = spread / b.stretch0;
        const want = clamp(b.size0 * ratio, MIN_SIZE, MAX_SIZE);
        setSize(b, b.sizeMul + (want - b.sizeMul) * (1 - Math.exp(-dt * 10)));
        b.jAxis.subVectors(h1.target, h0.target).normalize();
        b.jTarget = clamp((ratio - 1) * 0.2, -0.2, 0.35);
      } else {
        b.pos.lerp(h0.target, 1 - Math.exp(-dt * 24));
        if (h0.gripMode === 'fist') {
          // squeezing a fist squishes the slime flat
          b.jAxis.set(0, 1, 0);
          b.jTarget = -0.35 * h0.squeeze;
        }
      }
      b.vel.copy(b.pos).sub(b.prev).divideScalar(Math.max(dt, 1e-4));
      if (!h1 && b.jTarget === 0) {
        // carried slime stretches along its motion
        const sp = b.vel.length();
        if (sp > 1) { b.jAxis.copy(b.vel).divideScalar(sp); b.jTarget = Math.min(sp * 0.012, 0.3); }
      }
      b.angVel.lerp(axis.set(-b.vel.y, b.vel.x, 0).multiplyScalar(0.25 / b.sizeMul), 1 - Math.exp(-dt * 6));
    } else if (b.state === 'free') {
      if (gravityOn) {
        b.vel.y -= GRAVITY * dt;
      } else {
        // gentle buoyant float; drift back only if a stone wanders out of the comfortable range
        b.vel.y += Math.sin(time * 0.6 + b.seed) * 0.05 * dt;
        b.vel.x += Math.cos(time * 0.45 + b.seed * 1.7) * 0.035 * dt;
        if (!b.escaping) b.vel.z += (clamp(b.pos.z, -5.5, 1.8) - b.pos.z) * 0.8 * dt;
      }
      b.vel.multiplyScalar(Math.exp(-dt * (b.escaping ? ESCAPE_DRAG : gravityOn ? PILE_DRAG : FLOAT_DRAG)));
      b.pos.addScaledVector(b.vel, dt);
      if (!gravityOn) b.angVel.lerp(b.idleSpin, 1 - Math.exp(-dt * 0.6));
      if (b.escaping && b.vel.length() < 4) b.escaping = false;
    }
  }

  handTouches();
  const iterations = gravityOn ? 4 : 1;
  for (let k = 0; k < iterations; k++) { collideStones(); bounds(dt / iterations); }

  for (const b of beads) {
    if (b.state === 'gone') continue;
    // rolling on the tray
    if (b.onFloor && !isHeld(b)) {
      b.angVel.lerp(axis.set(b.vel.z, 0, -b.vel.x).divideScalar(b.r), 1 - Math.exp(-dt * 8));
      if (b.vel.lengthSq() < 0.01) b.vel.multiplyScalar(0.5); // settle
    }
    const w = b.angVel.length();
    if (w > 1e-5) b.mesh.rotateOnWorldAxis(axis.copy(b.angVel).divideScalar(w), w * dt);

    // slime springs
    b.jv += (-(b.jx - b.jTarget) * JELLY_K - b.jv * JELLY_C) * dt;
    b.jx = clamp(b.jx + b.jv * dt, -0.5, 1.0);
    b.dv += (-(b.dent - b.dentTarget) * 260 - b.dv * 12) * dt;
    b.dent = clamp(b.dent + b.dv * dt, -0.05 * b.r, b.r * MAX_DENT);
  }
}

// ---------- visuals ----------
let focusZ = 0;

function updateVisuals(dt) {
  pileFade += ((gravityOn ? 1 : 0) - pileFade) * (1 - Math.exp(-dt * 3));
  floor.material.uniforms.uOpacity.value = pileFade;
  floor.visible = pileFade > 0.01;

  // camera focus follows what you're interacting with
  const holder = pointers.find((p) => p.held);
  const hand = handPtrs.find((p) => p.visible);
  const focusTarget = holder ? holder.held.pos.z : hand ? hand.handZ : gravityOn ? 0.5 : 0;
  focusZ += (focusTarget - focusZ) * (1 - Math.exp(-dt * 4));

  const hovered = new Set(pointers.map((p) => p.hover).filter(Boolean));
  for (const b of beads) {
    const show = b.state !== 'gone';
    b.shadow.visible = b.caustic.visible = show && pileFade > 0.01;
    if (!show) continue;

    // proximity glow: lights up when a fingertip is at the stone's depth and close
    let near = 0;
    for (const p of handPtrs) {
      if (!handIsTouching(p)) continue;
      for (const c of p.colliders) {
        const gap = c.pos.distanceTo(b.pos) - b.r - c.r;
        near = Math.max(near, 1 - clamp(gap / TOUCH_GLOW_DIST, 0, 1));
      }
    }
    b.near += (near - b.near) * (1 - Math.exp(-dt * 14));

    const target = isHeld(b) ? 1 : Math.max(hovered.has(b) ? 0.55 : 0, b.near * 0.7);
    b.hover += (target - b.hover) * (1 - Math.exp(-dt * 12));
    b.grabPop *= Math.exp(-dt * 7);
    const t = b.spawnT;
    const back = t >= 1 ? 1 : 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2); // easeOutBack
    const s = b.size * b.sizeMul * back * (1 + 0.07 * b.hover + 0.1 * b.grabPop * Math.sin(b.grabPop * 9));
    b.mesh.scale.setScalar(Math.max(s, 0.0001));

    const u = b.mat.uniforms;
    u.uHover.value = b.hover;
    u.uLensR.value = b.r / (2 * tanHalf * (camera.position.z - b.pos.z));
    u.uDof.value = isHeld(b) ? 0 : Math.pow(clamp(Math.abs(b.pos.z - focusZ) / DOF_RANGE, 0, 1), 1.2) * 0.9;
    u.uHaze.value = clamp((-b.pos.z - 1.5) / 9, 0, 0.45);

    // slime: hand the deformation to the vertex shader in the stone's own frame
    tmpQ.copy(b.mesh.quaternion).invert();
    u.uJAxis.value.copy(b.jAxis).applyQuaternion(tmpQ).normalize();
    u.uJAmt.value = b.jx;
    u.uDentDir.value.copy(b.dentDir).applyQuaternion(tmpQ).normalize();
    u.uDent.value = b.dent / Math.max(s, 1e-3);

    // contact shadow + caustic on the tray, softer and fainter the higher the stone
    if (pileFade > 0.01) {
      const fy = floorHeight(b.pos.x, b.pos.z);
      const height = Math.max(0, b.pos.y - b.r - fy);
      const k = clamp(1 - height / 5, 0, 1) * pileFade * back;
      b.shadow.position.set(b.pos.x, fy + 0.01, b.pos.z);
      b.shadow.scale.setScalar(b.r * 2.6 * (1 + height * 0.25));
      b.shadow.material.opacity = 0.55 * k;
      b.caustic.position.set(b.pos.x + 0.12 * b.r, fy + 0.02, b.pos.z + 0.25 * b.r);
      b.caustic.scale.setScalar(b.r * 1.3 * (1 + height * 0.15));
      b.caustic.material.opacity = 0.55 * k * (0.4 + b.stone.tintAmt);
    }
  }

  // fingertip orbs live in 3D, so stones in front of your hand occlude them
  for (const p of handPtrs) {
    p.orbs.forEach((o, k) => {
      o.visible = p.visible;
      if (!p.visible) return;
      o.position.copy(p.colliders[k].pos);
      const isPinchFinger = TIP_IDS[k] === THUMB_TIP || TIP_IDS[k] === INDEX_TIP;
      const boost = isPinchFinger ? 1 + 0.5 * p.pinchAmt : 1 - 0.5 * p.pinchAmt;
      o.scale.setScalar(o.userData.base * boost);
      o.material.opacity = isPinchFinger ? 0.95 : 0.55;
    });
  }
}

// ---------- overlay: visionOS-like hand cursors ----------
function drawOverlay() {
  ctx.clearRect(0, 0, W, H);
  for (const p of handPtrs) {
    if (!p.visible || !p.landmarks) continue;
    const pts = p.landmarks.map(lmToScreen);
    const persp = perspective(p.handZ);

    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    for (const [a, b] of HAND_EDGES) { ctx.moveTo(...pts[a]); ctx.lineTo(...pts[b]); }
    ctx.stroke();

    const fistMode = p.held ? p.gripMode === 'fist' : p.fist;
    const amt = p.held ? 1 : fistMode ? 1 : p.pinchAmt;
    ctx.save();
    ctx.shadowColor = 'rgba(255,255,255,0.9)';
    ctx.shadowBlur = 12;

    if (!fistMode) {
      ctx.strokeStyle = `rgba(255,255,255,${0.45 * (1 - amt)})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(...p.thumb); ctx.lineTo(...p.index); ctx.stroke();
    }

    // focus ring at the grab point; its size follows the hand's depth
    const base = fistMode ? 34 : 22 - 11 * amt;
    const r = base * clamp(persp, 0.55, 1.6);
    ctx.strokeStyle = p.hover || p.held ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(p.gx, p.gy, r, 0, Math.PI * 2); ctx.stroke();
    if (p.held) {
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.beginPath(); ctx.arc(p.gx, p.gy, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();

    if (DEBUG) {
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = '12px ui-monospace, monospace';
      ctx.fillText(`palm ${p.palmR.toFixed(3)}  z ${p.handZ.toFixed(2)}  pinch ${p.ratio.toFixed(2)}  curl ${p.curl.toFixed(2)}`, p.gx + 30, p.gy - 30);
    }
  }
}

// ---------- intro / camera / toolbar ----------
let hintTimer = null;
function hideHintSoon() {
  if (hintTimer) return;
  hintTimer = setTimeout(() => hintEl.classList.add('hidden'), 8000);
}

function enter() {
  intro.classList.add('leaving');
  hintEl.classList.remove('hidden');
  toolbar.classList.remove('hidden');
}

for (const btn of toolbar.querySelectorAll('[data-mode]')) btn.addEventListener('click', () => setMode(btn.dataset.mode));
document.getElementById('reset').addEventListener('click', resetAll);

document.getElementById('nocam').addEventListener('click', () => {
  enter();
  setStatus('Mouse mode · drag to throw · scroll = depth · shift+scroll = size');
  setTimeout(() => setStatus(''), 6000);
});

document.getElementById('start').addEventListener('click', async () => {
  enter();
  setStatus('Requesting camera…');
  const landmarkerPromise = createHandLandmarker().catch((e) => { console.error(e); return null; });
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    updateVideoScale();
    const tex = new THREE.VideoTexture(video);
    tex.colorSpace = THREE.SRGBColorSpace;
    shared.uVideo.value = tex;
    shared.uHasVideo.value = 1;
  } catch (e) {
    console.error(e);
    setStatus('Camera unavailable — mouse mode');
    return;
  }
  setStatus('Loading hand tracking…');
  landmarker = await landmarkerPromise;
  setStatus(landmarker ? 'Raise a hand ✋' : 'Hand tracking failed to load — mouse still works');
});
video.addEventListener('loadedmetadata', updateVideoScale);

// ---------- loop ----------
let last = performance.now();
let everSawHand = false;
function frame(now) {
  const dt = Math.min((now - last) / 1000, 1 / 30);
  last = now;
  time += dt;
  shared.uTime.value = time;

  if (landmarker && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    processHands(landmarker.detectForVideo(video, now), now);
    if (!everSawHand && handPtrs.some((p) => p.visible)) {
      everSawHand = true;
      setStatus('Open hand to touch · pinch or fist to grab · two hands to stretch');
      setTimeout(() => setStatus(''), 5000);
    }
  } else {
    for (const p of handPtrs) if (p.visible && now - p.lastSeen > HAND_GRACE_MS) hideHand(p);
  }

  for (const p of pointers) updatePointer(p, dt, now);
  physics(dt);
  updateVisuals(dt);
  renderer.render(scene, camera);
  drawOverlay();
  requestAnimationFrame(frame);
}

resize();
requestAnimationFrame(frame);

// handy from the devtools console: __glass.beads, __glass.hands, __glass.reset()
window.__glass = { beads, hands: handPtrs, reset: resetAll, setMode, worldToScreen, processHands, shared };
