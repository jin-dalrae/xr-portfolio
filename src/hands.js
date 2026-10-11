import { FilesetResolver, HandLandmarker, FaceLandmarker } from '@mediapipe/tasks-vision';

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

let filesetPromise = null;
const fileset = () => (filesetPromise ??= FilesetResolver.forVisionTasks(WASM));

async function create(Task, modelAssetPath, options) {
  const fs = await fileset();
  const opts = (delegate) => ({ baseOptions: { modelAssetPath, delegate }, runningMode: 'VIDEO', ...options });
  try {
    return await Task.createFromOptions(fs, opts('GPU'));
  } catch (e) {
    console.warn('GPU delegate failed, falling back to CPU', e);
    return await Task.createFromOptions(fs, opts('CPU'));
  }
}

export const createHandLandmarker = () => create(HandLandmarker, HAND_MODEL, {
  numHands: 2,
  minHandDetectionConfidence: 0.6,
  minHandPresenceConfidence: 0.5,
  minTrackingConfidence: 0.5,
});

export const createFaceLandmarker = () => create(FaceLandmarker, FACE_MODEL, { numFaces: 1 });

// Landmark indices
export const WRIST = 0, THUMB_TIP = 4, INDEX_MCP = 5, INDEX_TIP = 8, MIDDLE_MCP = 9;

export const HAND_EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

// ---------- measures ----------
// Distances use MediaPipe's metric world landmarks (meters, true 3D) when available,
// so gestures don't drift as the hand rotates; otherwise image landmarks in pixels.
function distFn(lm, vw, vh, world) {
  if (world) return (a, b) => Math.hypot(world[a].x - world[b].x, world[a].y - world[b].y, world[a].z - world[b].z);
  return (a, b) => Math.hypot((lm[a].x - lm[b].x) * vw, (lm[a].y - lm[b].y) * vh, (lm[a].z - lm[b].z) * vw);
}

// Palm size in video pixels; max of length and width so it holds up when the hand rotates.
export function palmSize(lm, vw, vh) {
  const d = distFn(lm, vw, vh);
  return Math.max(d(0, 9), d(5, 17) * 1.3, d(0, 5) * 0.95);
}

// Pinch ratio = thumb–index tip distance relative to palm size (scale invariant).
export function pinchRatio(lm, vw, vh, world) {
  const d = distFn(lm, vw, vh, world);
  const palm = Math.max(d(0, 9), d(5, 17) * 1.3, d(0, 5) * 0.95);
  return d(THUMB_TIP, INDEX_TIP) / (palm || 1);
}

// Finger curl: fingertip-to-wrist vs knuckle-to-wrist. ~1.9 open hand, ~1.0 fist.
export function fingerCurl(lm, vw, vh, world) {
  const d = distFn(lm, vw, vh, world);
  let sum = 0;
  for (const [tip, mcp] of [[8, 5], [12, 9], [16, 13], [20, 17]]) sum += d(tip, 0) / (d(mcp, 0) || 1);
  return sum / 4;
}

// ---------- metric depth ----------
// Webcam focal length in pixels from its horizontal field of view.
export const focalPx = (vw, hfovDeg) => (vw / 2) / Math.tan((hfovDeg * Math.PI) / 360);

// Where is the hand in camera space (meters)? MediaPipe gives the hand's 3D shape in
// meters (world landmarks, centered on the hand) and where each joint lands in the
// image. Solve for the translation t that projects the 3D shape onto those pixels:
//   f·(X + tx) = u·(Z + tz),  f·(Y + ty) = v·(Z + tz)   for all 21 joints (least squares).
// t.z is the distance to the hand.
function solve(lm, world, vw, vh, f, sy, sz) {
  const cx = vw / 2, cy = vh / 2;
  let a00 = 0, a02 = 0, a11 = 0, a12 = 0, a22 = 0, b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < lm.length; i++) {
    const u = lm[i].x * vw - cx, v = lm[i].y * vh - cy;
    const X = world[i].x, Y = world[i].y * sy, Z = world[i].z * sz;
    // row [f, 0, -u] · t = u·Z − f·X
    const r1 = u * Z - f * X;
    a00 += f * f; a02 -= f * u; a22 += u * u; b0 += f * r1; b2 -= u * r1;
    // row [0, f, -v] · t = v·Z − f·Y
    const r2 = v * Z - f * Y;
    a11 += f * f; a12 -= f * v; a22 += v * v; b1 += f * r2; b2 -= v * r2;
  }
  // normal equations [[a00,0,a02],[0,a11,a12],[a02,a12,a22]] t = b, eliminate tx, ty
  const tz = (b2 - (a02 * b0) / a00 - (a12 * b1) / a11) / (a22 - (a02 * a02) / a00 - (a12 * a12) / a11);
  const tx = (b0 - a02 * tz) / a00, ty = (b1 - a12 * tz) / a11;
  // reprojection error (px²), to judge the fit
  let err = 0;
  for (let i = 0; i < lm.length; i++) {
    const Z = world[i].z * sz + tz;
    if (Z <= 0.01) return { x: tx, y: ty, z: tz, err: Infinity, sz };
    err += (f * (world[i].x + tx) / Z - (lm[i].x * vw - cx)) ** 2
         + (f * (world[i].y * sy + ty) / Z - (lm[i].y * vh - cy)) ** 2;
  }
  return { x: tx, y: ty, z: tz, err: err / lm.length, sz };
}

// MediaPipe's world-landmark axis conventions aren't spelled out in the docs, so fit
// all four y/z sign combinations and keep whichever reprojects best.
// Joint i's depth is then t.z + world[i].z * t.sz.
export function solveHandPosition(lm, world, vw, vh, f) {
  let best = null;
  for (const sy of [1, -1]) for (const sz of [1, -1]) {
    const t = solve(lm, world, vw, vh, f, sy, sz);
    if (t.z > 0 && (!best || t.err < best.err)) best = t;
  }
  return best;
}

// Distance to the face (meters) from two near-universal sizes: the iris (~11.7 mm across)
// and the outer eye corners (~92 mm apart, measured in 3D so head turns matter less).
export function faceDistance(lm, vw, vh, f) {
  const px = (a, b, useZ) => Math.hypot((lm[a].x - lm[b].x) * vw, (lm[a].y - lm[b].y) * vh, useZ ? (lm[a].z - lm[b].z) * vw : 0);
  const estimates = [f * 0.092 / px(33, 263, true)];
  if (lm.length >= 478) {
    const iris = (px(469, 471) + px(474, 476)) / 2;
    if (iris > 2) estimates.push(f * 0.0117 / iris);
  }
  return estimates.reduce((s, e) => s + e, 0) / estimates.length;
}
