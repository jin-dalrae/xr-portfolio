import * as THREE from 'three';
import { STONES, makeSmallStones, makeBackground, makeGlassMaterial, makeStoneGeometry, makeGlowTexture } from './glass.js';
import { makeFloor, makeShadow, trayProbe, trayPlane, trayRim, rayTray, trayAt, TRAY_RADIUS, RIM_TUBE } from './floor.js';
import { createRoomProbe, createHandMask } from './room.js';
import { createWall } from './wall.js';
import {
  createHandLandmarker, createFaceLandmarker, pinchRatio, palmSize, fingerCurl,
  solveHandPosition, faceDistance, focalPx, HAND_EDGES, WRIST, THUMB_TIP, INDEX_TIP,
} from './hands.js';

// ---------- tuning ----------
const PINCH_ON = 0.3, PINCH_OFF = 0.44;   // thumb–index ratio: grab / let go
const FIST_ON = 1.25, FIST_OFF = 1.45;    // finger curl: close / open
const PICK_SLACK_PX = 36;                 // forgiveness around a stone's silhouette
const Z_MIN = -7, Z_MAX = 3;              // depth of the room (camera sits at z = 10)

// Hand depth. Three methods, switchable live in the depth panel (press D):
//   mirror: hand distance / face distance. The screen is a mirror; a hand at your face
//           is at the back of the room, a hand reaching to the screen is at the front.
//           Independent of the camera lens, since both distances scale with it.
//   metric: hand distance in meters (3D hand pose fit), mapped onto a self-calibrating
//           range of your reach.
//   palm:   apparent palm size only (the original heuristic).
const MIRROR_NEAR = 0.3;                  // hand/face distance ratio at the front of the room
const MIRROR_FAR = 0.95;                  // ... and at the back (hand level with your face)
const HAND_NEAR = 0.36, HAND_FAR = 0.12;  // palm method: palm / video height, near & far
const LM_Z_GAIN = 1.0;                    // palm method: trust in MediaPipe's per-joint z
// Screen height as depth: over the tilted tray (lower half of the screen), where the
// hand sits on screen says where it is on the tray, like a table seen in perspective.
// Lower = nearer, higher = farther back. Blended with the measured depth.
const TRAY_DEPTH = 0.65;                  // max share of hand depth taken from screen height
const PILE_LIFT = 0.7;                    // hover this far above the tray surface (toward camera)

const TIP_RADIUS = 0.2, PALM_RADIUS = 0.42;
const TOUCH_BOUNCE = 0.15;                // restitution for fast hand hits
const TOUCH_STRENGTH = 0.45;              // share of the hand's speed passed to a stone
const TOUCH_MAX_SPEED = 7;                // cap on how fast a hit can send a stone
const HAND_STILL = 0.9;                   // hand speeds below this are tracking jitter, not motion
const SQUISH_SPEED = 2.5;                 // slower than this, a fingertip dents instead of batting
const MAX_DENT = 0.35;                    // fraction of radius a stone can be dented
const TOUCH_GLOW_DIST = 0.8;              // stones glow when a fingertip is this close

const GRAVITY = 22;                       // heavy glass: falls and settles fast
const FLOAT_DRAG = 0.8, PILE_DRAG = 0.25;
const TABLE_Y = -3.6;                     // invisible table under the bowl (pile mode)
const PILE_FRONT_Z = 1.0;                 // keeps stones on the table in view
const RESTITUTION = 0.35, FLOOR_BOUNCE = 0.15;
const TRAY_GRIP = 0.9;                    // friction in the bowl: stones settle, then stay where they settle
const THROW_BOOST = 0.85;                 // heavy stones leave the hand a little slower
const FLICK_SPEED = 16;                   // fast hand + loosening grip = release now
const MAX_THROW = 30;
const WALL_THROW = 9;                     // released over the wall slower than this: it sticks
const SPIN = 0.25;                        // overall spin multiplier (throws, hits, collisions)
const MAX_SPIN = 2.5;                     // rad/s cap
const SPIN_DAMP = 1.2;                    // how quickly spin settles
const HOLD_FOLLOW = 13;                   // how tightly a held stone follows the hand (lower = heavier lag)
const MIN_SIZE = 0.35, MAX_SIZE = 3.2;    // two-hand stretch limits
const DOF_RANGE = 4.5;                    // depth distance at which a stone is fully defocused
const JELLY_K = 120, JELLY_C = 9;         // slime spring: stiffness / damping (heavier = slower, calmer)

// ---------- DOM ----------
const canvas = document.getElementById('gl');
const overlay = document.getElementById('overlay');
const ctx = overlay.getContext('2d');
const video = document.getElementById('video');
const intro = document.getElementById('intro');
const statusEl = document.getElementById('status');
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
  // real-room matching (camera mode)
  uHandMask: { value: null },
  uMaskZ: { value: new THREE.Vector2(Z_MIN, Z_MAX) },
  uShadows: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) },
  uAmbient: { value: new THREE.Color(0.4, 0.4, 0.4) },
  uKeyColor: { value: new THREE.Color(1, 1, 1) },
  uKeyDir: { value: new THREE.Vector3(0.4, 0.6, 0.7).normalize() },
  uKeyStrength: { value: 2 },
  uEnv: { value: null },
  uGrain: { value: 0 },
  uExposure: { value: 1 },
  uBlack: { value: 0 },
};
const room = createRoomProbe(video);
const handMask = createHandMask();
shared.uHandMask.value = handMask.tex;
shared.uEnv.value = room.envTex;
scene.add(makeBackground(shared));
const floor = makeFloor();
scene.add(floor);
const wall = createWall(shared);
scene.add(wall.mesh);

let W = 1, H = 1;
function resize() {
  W = window.innerWidth; H = window.innerHeight;
  renderer.setPixelRatio(renderPixelRatio());
  renderer.setSize(W, H, false);
  handMask.resize(W, H);
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
  wall.place(halfExtents);
  for (const b of beads) if (b.state === 'stuck') stickTarget(b);
  renderer.getDrawingBufferSize(shared.uResolution.value);
  shared.uAspect.value = W / H;
  const dpr = Math.min(window.devicePixelRatio, 2);
  overlay.width = W * dpr; overlay.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  updateVideoScale();
}

// With the camera on, render the glass at roughly the camera's own resolution:
// webcam video is soft, and razor-sharp CG on top of it reads as a sticker.
function renderPixelRatio() {
  const dpr = Math.min(window.devicePixelRatio, 2);
  if (!shared.uHasVideo.value || !video.videoWidth) return dpr;
  const visibleVideoPx = video.videoWidth * shared.uVideoScale.value.x;
  return clamp((visibleVideoPx / window.innerWidth) * 1.3, 1, dpr);
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
const ALL_STONES = [...STONES, ...makeSmallStones(14)];

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
    id: i, stone, mesh, mat, shadow, caustic,
    wall: null, wallTarget: new THREE.Vector3(),
    baseR, r: baseR, size: stone.size, sizeMul: 1,
    mass: baseR ** 3,
    pos: mesh.position,
    vel: new THREE.Vector3(),
    prev: new THREE.Vector3(),
    angVel: new THREE.Vector3(rand(-0.3, 0.3), rand(-0.3, 0.3), rand(-0.2, 0.2)),
    idleSpin: new THREE.Vector3(rand(-0.15, 0.15), rand(-0.25, 0.25), rand(-0.1, 0.1)),
    seed: Math.random() * 100,
    state: 'free',
    spawnT: 1, spawnFrom: 0, spawnTo: 0,
    holders: [], stretch0: 0, size0: 1,
    hover: 0, near: 0, grabPop: 0, onFloor: false, floorN: new THREE.Vector3(0, 1, 0),
    // slime state
    jx: 0, jv: 0, jTarget: 0, jAxis: new THREE.Vector3(0, 1, 0),
    dent: 0, dv: 0, dentTarget: 0, dentDir: new THREE.Vector3(0, 0, 1),
  };
});
const isHeld = (b) => b.holders.length > 0;

// Where each stone is poured from: a sunflower spiral over the bowl, big stones in the
// middle and chips toward the rim, relaxed so neighbors just touch.
(function layoutPlatter() {
  const order = [...beads].sort((a, b) => b.baseR - a.baseR);
  const usable = (TRAY_RADIUS - RIM_TUBE * 2) * 0.85;
  const pts = order.map((b, i) => {
    const r = usable * 0.92 * Math.sqrt((i + 0.5) / order.length), a = i * 2.39996;
    return { b, x: Math.cos(a) * r, z: Math.sin(a) * r };
  });
  for (let it = 0; it < 80; it++) {
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      const A = pts[i], B = pts[j];
      const dx = B.x - A.x, dz = B.z - A.z, d = Math.hypot(dx, dz) || 1e-4;
      const min = (A.b.baseR + B.b.baseR) * 0.98;
      if (d < min) { const k = (min - d) / d / 2; A.x -= dx * k; A.z -= dz * k; B.x += dx * k; B.z += dz * k; }
    }
    for (const P of pts) {
      const d = Math.hypot(P.x, P.z), max = usable - P.b.baseR;
      if (d > max) { P.x *= max / d; P.z *= max / d; }
    }
  }
  pts.forEach((P, i) => { P.b.home = { x: P.x, z: P.z }; P.b.homeOrder = i; });
})();

function setSize(b, mul) {
  b.sizeMul = mul;
  b.r = b.baseR * mul;
  b.mass = b.r ** 3;
}

// Stones are never generated or removed: they're poured into the bowl and then only
// ever moved by physics and hands.
function pour(b, k) {
  b.vel.set(rand(-0.3, 0.3), 0, rand(-0.3, 0.3));
  b.jx = b.jv = b.dent = b.dv = 0;
  b.mesh.visible = true;
  b.state = 'free';
  b.spawnT = 1;
  // from just above its own spot (spots don't overlap), in three staggered layers;
  // they drop into the bowl, roll to the bottom and stack
  trayAt(b.home.x, b.home.z, b.pos).y += b.r + 0.15 + (k % 3) * 0.35;
}

// ---------- the wall: stones stick to it in category rows, and can be pulled off ----------
const stuck = () => beads.filter((b) => b.state === 'stuck');
function stickTarget(b) { wall.toWorld(b.wall.x, b.wall.y, b.r * 0.85, b.wallTarget); }
function stick(b, slot) {
  b.state = 'stuck';
  b.wall = slot;
  stickTarget(b);
  b.vel.set(0, 0, 0);
  b.jv -= 0.6; // a soft press as it lands on the glass
  b.jAxis.copy(wall.normal);
  wall.remember(b.id, slot);
}
function unstick(b) {
  if (b.state !== 'stuck') return;
  b.state = 'free';
  b.wall = null;
  wall.remember(b.id, null);
}

function resetAll() {
  for (const p of pointers) p.held = null;
  wall.forgetAll();
  for (const b of beads) b.wall = null;
  if (!gravityOn) setMode('pile');
  beads.forEach((b) => {
    b.holders.length = 0;
    setSize(b, 1);
    pour(b, b.homeOrder);
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
    wallSlot: null, wallMag: 0,
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
const wallPt = new THREE.Vector3();
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
  unstick(b);
  p.held = b;
  p.gripMode = mode;
  p.grabZ = b.pos.z; p.depthSm = b.pos.z; p.wheelZ = 0;
  p.zOffset = p.gz == null ? 0 : b.pos.z - p.gz;   // the stone keeps its own depth; only hand motion moves it
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
  b.grabPop = 1;
  b.state = 'free';
  b.spawnT = Math.max(b.spawnT, 0.99);
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
  const slot = p.wallSlot;
  p.wallSlot = null;
  if (b.holders.length) return; // the other hand still has it
  if (slot && v.length() < WALL_THROW) { stick(b, slot); return; }
  v.multiplyScalar(THROW_BOOST);
  v.z *= 0.6; // depth from palm size is noisy; don't let it dominate a throw
  if (v.length() > MAX_THROW) v.setLength(MAX_THROW);
  b.vel.copy(v);
  b.angVel.set(-v.y, v.x, rand(-1, 1)).multiplyScalar((0.12 * SPIN) / b.sizeMul);
  // let go: the slime boings back
  b.jv += Math.min(v.length() * 0.03, 0.8);
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

    // carried over the wall: drawn onto its glass, into a free spot in that row
    p.wallSlot = null;
    if (b.holders.length === 1) {
      ndc.set((p.gx / W) * 2 - 1, -(p.gy / H) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const hit = wall.hit(raycaster.ray.origin, raycaster.ray.direction, 0.2);
      if (hit) p.wallSlot = wall.slot(b, hit.x, hit.y, stuck());
    }
    p.wallMag += ((p.wallSlot ? 1 : 0) - p.wallMag) * (1 - Math.exp(-dt * 8));
    if (p.wallSlot) p.target.lerp(wall.toWorld(p.wallSlot.x, p.wallSlot.y, b.r * 1.4, wallPt), p.wallMag * 0.85);
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
  if (e.key === 'd' || e.key === 'D') togglePanel();
});

// ---------- hands ----------
let landmarker = null;
let lastVideoTime = -1;
const HAND_GRACE_MS = 180;

function lmToScreen(l) {
  const s = shared.uVideoScale.value;
  return [(((1 - l.x) - 0.5) / s.x + 0.5) * W, ((l.y - 0.5) / s.y + 0.5) * H];
}

// ---------- depth sensing ----------
const depth = {
  method: 'mirror',
  hfov: 62,                 // assumed webcam horizontal FOV; only scales the cm readouts
  faceDist: 0, faceSeen: -1e9,
  lo: 0.22, hi: 0.55,       // self-calibrating reach (meters) for the metric method
};
let faceLandmarker = null;
const trayHit = new THREE.Vector3();
let lastFaceTime = -1, faceFrame = 0;

// 0 = front of the room (near the screen), 1 = back
const zFromT = (t) => THREE.MathUtils.lerp(Z_MAX - 0.3, Z_MIN + 0.5, clamp(t, 0, 1));
const faceFresh = (now) => depth.faceDist > 0 && now - depth.faceSeen < 1500;

// palm ratio -> world z, linear in apparent distance (1 / size)
function palmDepth(palmR) {
  const near = 1 / HAND_NEAR, far = 1 / HAND_FAR;
  return zFromT((1 / Math.max(palmR, 1e-3) - near) / (far - near));
}

function metersToZ(d, method) {
  if (method === 'mirror') return zFromT((d / depth.faceDist - MIRROR_NEAR) / (MIRROR_FAR - MIRROR_NEAR));
  return zFromT((d - depth.lo) / (depth.hi - depth.lo));
}

// Widen instantly to cover where the hand goes; tighten slowly so one glitch doesn't stick.
function adaptReach(d) {
  if (d < depth.lo) depth.lo = d; else depth.lo += (d - depth.lo) * 0.0004;
  if (d > depth.hi) depth.hi = d; else depth.hi += (d - depth.hi) * 0.0004;
  if (depth.hi - depth.lo < 0.12) { const m = (depth.hi + depth.lo) / 2; depth.lo = m - 0.06; depth.hi = m + 0.06; }
}

function processFace(result, now) {
  const lm = result.faceLandmarks?.[0];
  if (!lm) return;
  const d = faceDistance(lm, video.videoWidth, video.videoHeight, focalPx(video.videoWidth, depth.hfov));
  if (!(d > 0.1 && d < 3)) return;
  depth.faceDist = faceFresh(now) ? depth.faceDist + (d - depth.faceDist) * 0.15 : d;
  depth.faceSeen = now;
}

function placeCollider(c, sx, sy, z, dtS, continuous) {
  c.prev.copy(c.pos);
  screenToWorld(sx, sy, z, c.pos);
  if (!continuous) { c.prev.copy(c.pos); c.vel.set(0, 0, 0); }
  else {
    // smooth, then treat tiny motion as tracking jitter
    tmpV.subVectors(c.pos, c.prev).divideScalar(Math.max(dtS, 1 / 120));
    c.vel.lerp(tmpV, 0.5);
    if (c.vel.length() < HAND_STILL) c.vel.set(0, 0, 0);
  }
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

    // depth of the hand in the room: every method is computed (for the depth panel),
    // the selected one drives the interaction
    const world = result.worldLandmarks?.[i];
    p.palmR = palmSize(lm, vw, vh) / vh;
    p.zByMethod = { palm: palmDepth(p.palmR) };
    const pose = world && solveHandPosition(lm, world, vw, vh, focalPx(vw, depth.hfov));
    if (pose) {
      p.dist = continuous && p.dist ? p.dist + (pose.z - p.dist) * 0.45 : pose.z;
      p.poseErr = Math.sqrt(pose.err);
      adaptReach(p.dist);
      p.zByMethod.metric = metersToZ(p.dist, 'metric');
      if (faceFresh(now)) p.zByMethod.mirror = metersToZ(p.dist, 'mirror');
    }
    // fall back gracefully: mirror needs a face, metric needs a pose
    p.method = depth.method in p.zByMethod ? depth.method : 'metric' in p.zByMethod ? 'metric' : 'palm';
    const zMeasured = p.zByMethod[p.method];

    // screen height over the tray -> depth on the tray
    let zRaw = zMeasured;
    p.trayW = 0;
    if (p.held) {
      // holding: keep the contribution it had at the grab, so lifting a stone
      // doesn't push it deeper (only real hand motion toward/away moves it)
      zRaw = zMeasured + (p.frozenShift || 0);
    } else if (pileFade > 0.01) {
      let sx = 0, sy = 0;
      for (const id of [0, 5, 9, 17]) { const q = lmToScreen(lm[id]); sx += q[0] / 4; sy += q[1] / 4; }
      ndc.set((sx / W) * 2 - 1, -(sy / H) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const hit = rayTray(raycaster.ray.origin, raycaster.ray.direction, trayHit);
      if (hit) {
        p.trayZ = hit.addScaledVector(raycaster.ray.direction, -PILE_LIFT).z;
        p.trayW = TRAY_DEPTH * pileFade * THREE.MathUtils.smoothstep(sy / H, 0.4, 0.7);
        zRaw = THREE.MathUtils.lerp(zMeasured, p.trayZ, p.trayW);
      }
    }
    const zShift = zRaw - zMeasured;  // applied to every joint, keeping the hand's own shape
    if (!p.held) p.frozenShift = zShift;
    p.handZ = continuous ? p.handZ + (zRaw - p.handZ) * 0.3 : zRaw;
    let lmZ;
    if (p.method === 'palm') {
      const { hw } = halfExtents(p.handZ);
      const zScale = (LM_Z_GAIN * 2 * hw) / shared.uVideoScale.value.x; // MediaPipe z is in image-width units
      lmZ = (id) => p.handZ - lm[id].z * zScale;
    } else {
      // each joint's own metric depth, smoothed with the hand
      const shift = p.dist - pose.z;
      lmZ = (id) => metersToZ(pose.z + shift + world[id].z * pose.sz, p.method) + zShift;
    }

    // pinch point
    p.thumb = lmToScreen(lm[THUMB_TIP]);
    p.index = lmToScreen(lm[INDEX_TIP]);
    const a = continuous ? 0.65 : 1;
    p.x += ((p.thumb[0] + p.index[0]) / 2 - p.x) * a;
    p.y += ((p.thumb[1] + p.index[1]) / 2 - p.y) * a;
    p.pinchZ = (lmZ(THUMB_TIP) + lmZ(INDEX_TIP)) / 2;

    p.ratio = pinchRatio(lm, vw, vh, world);
    if (!p.pinch && p.ratio < PINCH_ON) p.pinch = true;
    else if (p.pinch && p.ratio > PINCH_OFF) p.pinch = false;
    p.pinchAmt = clamp((0.85 - p.ratio) / (0.85 - PINCH_ON), 0, 1);

    p.curl = fingerCurl(lm, vw, vh, world);
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
    p.jointZ = lm.map((_, id) => lmZ(id));

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
  if (speed < 2) return;
  b.jAxis.copy(normal);
  b.jv -= Math.min(speed * 0.06, 1.0) / Math.sqrt(b.sizeMul);
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
          b.vel.addScaledVector(n, -(1 + TOUCH_BOUNCE) * vn * TOUCH_STRENGTH);
          if (b.vel.length() > TOUCH_MAX_SPEED) b.vel.setLength(TOUCH_MAX_SPEED);
          // a little friction drags the stone along with the finger, and spins it
          tang.copy(rv).addScaledVector(n, -vn);
          b.vel.addScaledVector(tang, -0.1);
          b.angVel.add(axis.crossVectors(n, tang).multiplyScalar(-0.6 * SPIN));
          b.grabPop = Math.max(b.grabPop, clamp(-vn / 20, 0.05, 0.4));
          jellyKick(b, n, -vn);
        }
      }
      c.fresh = false;
    }
  }
}

function collideStones() {
  for (let i = 0; i < beads.length; i++) {
    const a = beads[i];
    if (a.state !== 'free' && a.state !== 'stuck') continue;
    for (let j = i + 1; j < beads.length; j++) {
      const b = beads[j];
      if (b.state !== 'free' && b.state !== 'stuck') continue;
      n.copy(a.pos).sub(b.pos);
      const minD = a.r + b.r;
      const d2 = n.lengthSq();
      if (d2 >= minD * minD || d2 < 1e-12) continue;
      const d = Math.sqrt(d2);
      n.divideScalar(d);
      const ia = isHeld(a) || a.state === 'stuck' ? 0 : 1 / a.mass;
      const ib = isHeld(b) || b.state === 'stuck' ? 0 : 1 / b.mass;
      if (ia + ib === 0) continue;
      const overlap = Math.min(minD - d, minD * 0.25); // resolve deep overlaps gradually, no launches
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
        a.angVel.add(axis.crossVectors(n, tang).multiplyScalar(-0.3 * SPIN * ia * a.mass));
        b.angVel.add(axis.crossVectors(n, tang).multiplyScalar(0.3 * SPIN * ib * b.mass));
        if (vn < -2.5) { jellyKick(a, n, -vn); jellyKick(b, n, -vn); }
      }
    }
  }
}

function bounds(dt) {
  for (const b of beads) {
    if (b.state !== 'free' || isHeld(b)) continue;
    const { hw, hh } = halfExtents(b.pos.z);
    // the screen is the room: stones bounce off its edges and never leave it
    if (b.pos.x > hw - b.r) { b.pos.x = hw - b.r; if (b.vel.x > 0) b.vel.x *= -RESTITUTION; }
    if (b.pos.x < -hw + b.r) { b.pos.x = -hw + b.r; if (b.vel.x < 0) b.vel.x *= -RESTITUTION; }
    if (b.pos.y > hh - b.r) { b.pos.y = hh - b.r; if (b.vel.y > 0) b.vel.y *= -RESTITUTION; }
    if (!gravityOn && b.pos.y < -hh + b.r) { b.pos.y = -hh + b.r; if (b.vel.y < 0) b.vel.y *= -RESTITUTION; }
    if (b.pos.z < Z_MIN + b.r) { b.pos.z = Z_MIN + b.r; if (b.vel.z < 0) b.vel.z *= -RESTITUTION; }
    const front = gravityOn ? PILE_FRONT_Z : Z_MAX;
    if (b.pos.z > front - b.r) { b.pos.z = front - b.r; if (b.vel.z > 0) b.vel.z *= -RESTITUTION; }

    if (gravityOn) {
      // a table under the bowl catches anything that falls out of it
      if (b.pos.y < TABLE_Y + b.r) {
        b.pos.y = TABLE_Y + b.r;
        if (b.vel.y < 0) { if (b.vel.y < -1.5) jellyKick(b, UP, -b.vel.y); b.vel.y *= b.vel.y < -1.5 ? -FLOOR_BOUNCE : 0; }
        b.onFloor = true; b.floorN.copy(UP);
      }
      const rimPen = trayRim(b.pos, b.r, n);
      if (rimPen > 0) {
        b.pos.addScaledVector(n, rimPen);
        const vn = b.vel.dot(n);
        if (vn < 0) b.vel.addScaledVector(n, -(1 + (vn < -1.5 ? FLOOR_BOUNCE : 0)) * vn);
      }
      const pen = trayPlane(b.pos, b.r, n);
      if (pen > -0.02) { b.onFloor = true; b.floorN.copy(n); } // resting contact counts too
      if (pen > 0) {
        b.pos.addScaledVector(n, pen);
        b.floorN.copy(n);
        const vn = b.vel.dot(n);
        if (vn < 0) {
          b.vel.addScaledVector(n, -(1 + (vn < -1.5 ? FLOOR_BOUNCE : 0)) * vn);
          jellyKick(b, n, -vn);
        }
        b.onFloor = true;  // friction is applied once per frame, after all passes
      }
    }
  }
}

function physics(dt) {
  for (const b of beads) { b.jTarget = 0; b.onFloor = false; }

  for (const b of beads) {
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
        b.pos.lerp(mid, 1 - Math.exp(-dt * HOLD_FOLLOW * 0.8));
        const spread = Math.hypot(h0.target.x - h1.target.x, h0.target.y - h1.target.y);
        const ratio = spread / b.stretch0;
        const want = clamp(b.size0 * ratio, MIN_SIZE, MAX_SIZE);
        setSize(b, b.sizeMul + (want - b.sizeMul) * (1 - Math.exp(-dt * 10)));
        b.jAxis.subVectors(h1.target, h0.target).normalize();
        b.jTarget = clamp((ratio - 1) * 0.2, -0.2, 0.35);
      } else {
        b.pos.lerp(h0.target, 1 - Math.exp(-dt * HOLD_FOLLOW));
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
      b.angVel.lerp(axis.set(-b.vel.y, b.vel.x, 0).multiplyScalar((0.05 * SPIN) / b.sizeMul), 1 - Math.exp(-dt * 4));
    } else if (b.state === 'stuck') {
      b.pos.lerp(b.wallTarget, 1 - Math.exp(-dt * 12));
      b.vel.set(0, 0, 0);
      b.angVel.multiplyScalar(Math.exp(-dt * 3));
    } else if (b.state === 'free') {
      if (gravityOn) {
        b.vel.y -= GRAVITY * dt;
      } else {
        // gentle buoyant float; drift back only if a stone wanders out of the comfortable range
        b.vel.y += Math.sin(time * 0.6 + b.seed) * 0.05 * dt;
        b.vel.x += Math.cos(time * 0.45 + b.seed * 1.7) * 0.035 * dt;
        b.vel.z += (clamp(b.pos.z, -5.5, 1.8) - b.pos.z) * 0.8 * dt;
      }
      b.vel.multiplyScalar(Math.exp(-dt * (gravityOn ? PILE_DRAG : FLOAT_DRAG)));
      b.pos.addScaledVector(b.vel, dt);
      if (!gravityOn) b.angVel.lerp(b.idleSpin, 1 - Math.exp(-dt * 0.6));
    }
  }

  handTouches();
  const iterations = gravityOn ? 4 : 1;
  for (let k = 0; k < iterations; k++) { collideStones(); bounds(dt / iterations); }

  // Coulomb friction on the platter, stronger than the slope's pull, so stones rest
  // where they are on the tilted dish (like a pie being shown off)
  for (const b of beads) {
    if (!b.onFloor || isHeld(b) || b.state !== 'free') continue;
    const fn = b.floorN;
    tang.copy(b.vel).addScaledVector(fn, -b.vel.dot(fn));
    const tl = tang.length(), drop = TRAY_GRIP * GRAVITY * Math.max(fn.y, 0) * dt;
    b.vel.addScaledVector(tang, tl <= drop ? -1 : -drop / tl);
  }

  for (const b of beads) {
    if (b.state === 'gone') continue;
    // rolling on the tray
    if (b.onFloor && !isHeld(b)) {
      const rolling = b.vel.lengthSq() > 0.25;
      b.angVel.lerp(rolling ? axis.crossVectors(b.floorN, b.vel).multiplyScalar(0.5 / b.r) : axis.set(0, 0, 0), 1 - Math.exp(-dt * 4));
      if (b.vel.lengthSq() < 0.04) b.vel.multiplyScalar(0.5); // settle
    }
    if (!isHeld(b)) b.angVel.multiplyScalar(Math.exp(-dt * SPIN_DAMP));
    if (b.angVel.length() > MAX_SPIN) b.angVel.setLength(MAX_SPIN);
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
const trayPt = new THREE.Vector3(), trayN = new THREE.Vector3(), trayQ = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

function updateVisuals(dt) {
  pileFade += ((gravityOn ? 1 : 0) - pileFade) * (1 - Math.exp(-dt * 3));
  const real = shared.uHasVideo.value;      // camera on: no fake grid over the real room
  floor.userData.setOpacity(pileFade * (1 - real)); // camera on: no grid over the real room
  floor.visible = pileFade > 0.01;

  // camera focus follows what you're interacting with
  const holder = pointers.find((p) => p.held);
  const hand = handPtrs.find((p) => p.visible);
  const focusTarget = holder ? holder.held.pos.z : hand ? hand.handZ : gravityOn ? 0.5 : 0;
  focusZ += (focusTarget - focusZ) * (1 - Math.exp(-dt * 4));

  const hovered = new Set(pointers.map((p) => p.hover).filter(Boolean));
  for (const b of beads) {
    const show = b.state !== 'gone';
    b.shadow.visible = b.caustic.visible = show && pileFade > 0.01 && b.state !== 'stuck';
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
    u.uDof.value = isHeld(b) ? 0 : Math.pow(clamp(Math.abs(b.pos.z - focusZ) / DOF_RANGE, 0, 1), 1.2) * (b.state === 'stuck' ? 0.35 : 0.9);
    u.uHaze.value = clamp((-b.pos.z - 1.5) / 9, 0, 0.45);

    // slime: hand the deformation to the vertex shader in the stone's own frame
    tmpQ.copy(b.mesh.quaternion).invert();
    u.uJAxis.value.copy(b.jAxis).applyQuaternion(tmpQ).normalize();
    u.uJAmt.value = b.jx;
    u.uDentDir.value.copy(b.dentDir).applyQuaternion(tmpQ).normalize();
    u.uDent.value = b.dent / Math.max(s, 1e-3);

    // contact shadow + caustic on the tray, softer and fainter the higher the stone
    if (pileFade > 0.01) {
      // in the bowl: sit on its surface, facing along it; out of it: on the table
      let height;
      if (trayPlane(b.pos, b.r, trayN) === -Infinity) {
        trayPt.set(b.pos.x, TABLE_Y, b.pos.z); trayN.copy(UP);
        height = Math.max(0, b.pos.y - b.r - TABLE_Y);
      } else {
        height = Math.max(0, trayProbe(b.pos, trayPt, trayN) - b.r);
      }
      const k = clamp(1 - height / 5, 0, 1) * pileFade * back;
      trayQ.setFromUnitVectors(UP, trayN);
      b.shadow.position.copy(trayPt).addScaledVector(trayN, 0.01);
      b.shadow.quaternion.copy(trayQ);
      b.shadow.scale.setScalar(b.r * 2.6 * (1 + height * 0.25));
      b.shadow.material.opacity = 0.55 * k * (real ? 0.6 : 1);
      b.caustic.position.copy(trayPt).addScaledVector(trayN, 0.02).add(tmpV.set(0.12 * b.r, 0, 0.25 * b.r).applyQuaternion(trayQ));
      b.caustic.quaternion.copy(trayQ);
      b.caustic.scale.setScalar(b.r * 1.3 * (1 + height * 0.15));
      b.caustic.material.opacity = 0.55 * k * (0.4 + b.stone.tintAmt) * (real ? 0.5 : 1);
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
      o.scale.setScalar(o.userData.base * boost * (real ? 0.7 : 1));
      o.material.opacity = (isPinchFinger ? 0.95 : 0.55) * (real ? 0.6 : 1);
    });
  }

  if (real) updateRoomMatch();
}

// ---------- matching the real room ----------
const EXPOSURE_TARGET = 0.18;  // average linear luminance the room is eased toward (mid-grey)
let exposureBias = 0;          // EV, from the depth panel
let probeFrame = 0;
const shadowCands = [];

function updateRoomMatch() {
  if (++probeFrame % 6 === 0) room.update();
  // auto exposure: ease the room toward a natural mid-tone (webcams tend to run hot),
  // keeping some of the scene's own mood; the panel's EV slider biases it
  // dehaze first: most of a webcam's lifted blacks are removed (not all, to stay natural)
  const black = Math.min(room.black * 0.85, 0.12);
  shared.uBlack.value += (black - shared.uBlack.value) * 0.05;
  const b = shared.uBlack.value;
  const avgRaw = 0.2126 * room.ambient.r + 0.7152 * room.ambient.g + 0.0722 * room.ambient.b;
  const avgLum = Math.max(avgRaw - b, 0) / (1 - b);
  const auto = clamp(Math.pow(EXPOSURE_TARGET / Math.max(avgLum, 1e-3), 0.5), 0.6, 1.2);
  const want = auto * Math.pow(2, exposureBias);
  shared.uExposure.value += (want - shared.uExposure.value) * 0.05;
  const amb = shared.uAmbient.value.copy(room.ambient);
  amb.setRGB(Math.max(amb.r - b, 0) / (1 - b), Math.max(amb.g - b, 0) / (1 - b), Math.max(amb.b - b, 0) / (1 - b)).multiplyScalar(shared.uExposure.value);
  shared.uKeyColor.value.copy(room.keyColor);
  shared.uKeyStrength.value = room.keyStrength;
  // brightest light's place in the frame -> direction the highlight reflects
  shared.uKeyDir.value.set((room.keyUV.x - 0.5) * 2 * camera.aspect, (room.keyUV.y - 0.5) * 2, 1.1).normalize();
  shared.uGrain.value = 0.02;

  const hands = handPtrs.filter((p) => p.visible && p.landmarks && p.jointZ);
  handMask.draw(hands.map((p) => ({
    pts: p.landmarks.map(lmToScreen),
    near: p.jointZ.map((z) => (z - Z_MIN) / (Z_MAX - Z_MIN)),
  })));

  // stones held or hovering over a hand cast a soft shadow onto it, away from the light
  shadowCands.length = 0;
  if (hands.length) {
    for (const b of beads) {
      if (b.state === 'gone') continue;
      const k = isHeld(b) ? 0.9 : b.near * 0.7;
      if (k < 0.05) continue;
      const gap = Math.min(...hands.map((p) => Math.abs(b.pos.z - p.handZ)));
      shadowCands.push({ b, k: k / (1 + gap * 0.8), gap });
    }
    shadowCands.sort((x, y) => y.k - x.k);
  }
  const keyU = room.keyUV.x, keyV = room.keyUV.y;
  shared.uShadows.value.forEach((v, i) => {
    const c = shadowCands[i];
    if (!c) { v.set(0, 0, 0, 0); return; }
    const [sx, sy] = worldToScreen(c.b.pos);
    const u = sx / W, vv = 1 - sy / H;
    const rUV = screenRadius(c.b) / H;
    let dx = (u - keyU) * camera.aspect, dy = vv - keyV;
    const len = Math.hypot(dx, dy) || 1;
    const off = rUV * (0.3 + c.gap * 0.2);
    v.set(u + (dx / len) * off / camera.aspect, vv + (dy / len) * off, rUV * (1 + c.gap * 0.25), c.k);
  });
}

// ---------- overlay: visionOS-like hand cursors ----------
function drawOverlay() {
  ctx.clearRect(0, 0, W, H);
  for (const p of handPtrs) {
    if (!p.visible || !p.landmarks) continue;
    const pts = p.landmarks.map(lmToScreen);
    const persp = perspective(p.handZ);

    if (panelOpen) {
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.beginPath();
      for (const [a, b] of HAND_EDGES) { ctx.moveTo(...pts[a]); ctx.lineTo(...pts[b]); }
      ctx.stroke();
    }

    const fistMode = p.held ? p.gripMode === 'fist' : p.fist;
    const amt = p.held ? 1 : fistMode ? 1 : p.pinchAmt;
    ctx.save();
    ctx.shadowColor = 'rgba(255,255,255,0.9)';
    ctx.shadowBlur = 12;

    if (!fistMode && panelOpen) {
      ctx.strokeStyle = `rgba(255,255,255,${0.45 * (1 - amt)})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(...p.thumb); ctx.lineTo(...p.index); ctx.stroke();
    }

    // focus ring at the grab point, only when it means something; its size follows depth
    const engaged = p.hover || p.held || p.pinchAmt > 0.35 || p.fist;
    if (!engaged && !panelOpen) { ctx.restore(); continue; }
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

    if (panelOpen) {
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = '12px ui-monospace, monospace';
      const cm = p.dist ? `${(p.dist * 100).toFixed(0)}cm  ` : '';
      ctx.fillText(`${p.method}  ${cm}z ${p.handZ.toFixed(2)}  pinch ${p.ratio.toFixed(2)}  curl ${p.curl.toFixed(2)}`, p.gx + 30, p.gy - 30);
    }
  }
}

// ---------- depth panel (D, or open with #debug) ----------
const panel = document.getElementById('depthPanel');
const statsEl = document.getElementById('depthStats');
let panelOpen = DEBUG;
panel.classList.toggle('hidden', !panelOpen);
function togglePanel() { panelOpen = !panelOpen; panel.classList.toggle('hidden', !panelOpen); }

function setDepthMethod(m) {
  depth.method = m;
  for (const b of panel.querySelectorAll('[data-method]')) b.classList.toggle('on', b.dataset.method === m);
}
for (const b of panel.querySelectorAll('[data-method]')) b.addEventListener('click', () => setDepthMethod(b.dataset.method));
setDepthMethod(depth.method);
const fovInput = document.getElementById('fov');
fovInput.addEventListener('input', () => {
  depth.hfov = +fovInput.value;
  document.getElementById('fovVal').textContent = `${depth.hfov}°`;
  depth.lo = 0.22; depth.hi = 0.55; // reach in meters changes with the lens; relearn it
});

const evInput = document.getElementById('ev');
evInput.addEventListener('input', () => {
  exposureBias = +evInput.value;
  document.getElementById('evVal').textContent = `${exposureBias > 0 ? '+' : ''}${exposureBias.toFixed(1)} EV`;
});

let statsTimer = 0;
function updateStats(now) {
  if (!panelOpen || now - statsTimer < 100) return;
  statsTimer = now;
  const cm = (m) => `${(m * 100).toFixed(0)} cm`;
  const lines = [];
  lines.push(`face     ${faceFresh(now) ? cm(depth.faceDist) : faceLandmarker ? 'not seen' : 'loading…'}`);
  lines.push(`reach    ${cm(depth.lo)} – ${cm(depth.hi)}  (learning)`);
  handPtrs.forEach((p, k) => {
    if (!p.visible || !p.zByMethod) { lines.push(`hand ${k + 1}   —`); return; }
    const z = p.zByMethod;
    const f = (v) => (v == null ? '  —  ' : v.toFixed(2).padStart(5));
    lines.push(`hand ${k + 1}   ${p.dist ? cm(p.dist) : '—'}` + (faceFresh(now) && p.dist ? `  ·  ${(p.dist / depth.faceDist).toFixed(2)}× face` : ''));
    lines.push(`  z  mirror ${f(z.mirror)}  metric ${f(z.metric)}  palm ${f(z.palm)}`);
    if (p.trayW > 0.01) lines.push(`  screen height → tray z ${p.trayZ.toFixed(2)}  (${Math.round(p.trayW * 100)}% weight)`);
    lines.push(`  using ${p.method}${p.poseErr != null ? `  ·  fit ±${p.poseErr.toFixed(1)}px` : ''}`);
  });
  if (shared.uHasVideo.value) lines.push(`exposure ×${shared.uExposure.value.toFixed(2)}  black −${shared.uBlack.value.toFixed(3)}  (auto)`);
  lines.push(`room z   front ${(Z_MAX - 0.3).toFixed(1)}  →  back ${(Z_MIN + 0.5).toFixed(1)}`);
  statsEl.textContent = lines.join('\n');
}

// ---------- intro / camera / toolbar ----------

function enter() {
  intro.classList.add('leaving');
  toolbar.classList.remove('hidden');
}

for (const btn of toolbar.querySelectorAll('[data-mode]')) btn.addEventListener('click', () => setMode(btn.dataset.mode));
document.getElementById('reset').addEventListener('click', resetAll);

document.getElementById('nocam').addEventListener('click', () => {
  enter();
});

document.getElementById('start').addEventListener('click', async () => {
  enter();
  setStatus('Requesting camera…');
  const landmarkerPromise = createHandLandmarker().catch((e) => { console.error(e); return null; });
  // the face is only a ruler for depth; it loads alongside and is optional
  createFaceLandmarker().then((f) => { faceLandmarker = f; }).catch((e) => console.warn('face tracking unavailable', e));
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    // ask the webcam itself to expose a little darker, where it allows it
    // (the shader's auto exposure covers cameras that don't)
    try {
      const track = stream.getVideoTracks()[0];
      const caps = track.getCapabilities?.() || {};
      if (caps.exposureCompensation) {
        const { min, max } = caps.exposureCompensation;
        await track.applyConstraints({ advanced: [{ exposureCompensation: Math.max(min, Math.min(max, -0.7)) }] });
      }
    } catch (e) { console.warn('exposure control unavailable', e); }
    await video.play();
    updateVideoScale();
    const tex = new THREE.VideoTexture(video);
    tex.colorSpace = THREE.NoColorSpace; // raw sRGB bytes; the shader decodes them
    shared.uVideo.value = tex;
    shared.uHasVideo.value = 1;
    resize(); // render resolution now follows the camera
  } catch (e) {
    console.error(e);
    setStatus('Camera unavailable — mouse mode');
    return;
  }
  setStatus('Loading hand tracking…');
  landmarker = await landmarkerPromise;
  setStatus(landmarker ? '' : 'Hand tracking failed to load — mouse still works');
});
video.addEventListener('loadedmetadata', updateVideoScale);

// ---------- loop ----------
let last = performance.now();
function frame(now) {
  const dt = Math.min((now - last) / 1000, 1 / 30);
  last = now;
  time += dt;
  shared.uTime.value = time;

  if (landmarker && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    // face distance changes slowly: sample it every third frame
    if (faceLandmarker && ++faceFrame % 3 === 0) processFace(faceLandmarker.detectForVideo(video, now), now);
    processHands(landmarker.detectForVideo(video, now), now);
  } else {
    for (const p of handPtrs) if (p.visible && now - p.lastSeen > HAND_GRACE_MS) hideHand(p);
  }

  for (const p of pointers) updatePointer(p, dt, now);
  const carrier = pointers.find((p) => p.held && p.wallMag > 0.02);
  wall.setActive(carrier ? carrier.wallMag : 0);
  wall.showTarget(carrier && carrier.wallSlot, carrier && carrier.held, carrier ? carrier.wallMag : 0);
  physics(dt);
  updateVisuals(dt);
  renderer.render(scene, camera);
  drawOverlay();
  wall.updateLabels(camera, W, H);
  updateStats(now);
  requestAnimationFrame(frame);
}

resize();
// pour the stones in and let physics settle them before anyone sees a frame,
// so the page opens on a pile that gravity made
const savedWall = wall.savedLayout();
beads.forEach((b) => {
  const s = savedWall[b.id];
  if (s) stick(b, wall.slot(b, s.x, wall.rowY(s.row), stuck()));
  else pour(b, b.homeOrder);
});
for (let k = 0; k < 420; k++) physics(1 / 60);
requestAnimationFrame(frame);

// handy from the devtools console: __glass.beads, __glass.hands, __glass.reset()
window.__glass = { beads, hands: handPtrs, reset: resetAll, setMode, worldToScreen, processHands, processFace, shared, depth };
