import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

export async function createHandLandmarker() {
  const fileset = await FilesetResolver.forVisionTasks(WASM);
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: 0.6,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  try {
    return await HandLandmarker.createFromOptions(fileset, opts('GPU'));
  } catch (e) {
    console.warn('GPU delegate failed, falling back to CPU', e);
    return await HandLandmarker.createFromOptions(fileset, opts('CPU'));
  }
}

// Landmark indices
export const WRIST = 0, THUMB_TIP = 4, INDEX_MCP = 5, INDEX_TIP = 8, MIDDLE_MCP = 9;

export const HAND_EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

// Pinch ratio = thumb–index tip distance relative to palm size (scale invariant).
// Uses video pixel units so x/y/z are on the same scale.
export function pinchRatio(lm, vw, vh) {
  const d = (a, b) => Math.hypot((a.x - b.x) * vw, (a.y - b.y) * vh, (a.z - b.z) * vw);
  return d(lm[THUMB_TIP], lm[INDEX_TIP]) / (palmSize(lm, vw, vh) || 1);
}

// Palm size in video pixels; max of length and width so it holds up when the hand rotates.
export function palmSize(lm, vw, vh) {
  const d = (a, b) => Math.hypot((lm[a].x - lm[b].x) * vw, (lm[a].y - lm[b].y) * vh, (lm[a].z - lm[b].z) * vw);
  return Math.max(d(0, 9), d(5, 17) * 1.3, d(0, 5) * 0.95);
}

// Finger curl: fingertip-to-wrist vs knuckle-to-wrist. ~1.9 open hand, ~1.0 fist.
export function fingerCurl(lm, vw, vh) {
  const d = (a, b) => Math.hypot((lm[a].x - lm[b].x) * vw, (lm[a].y - lm[b].y) * vh, (lm[a].z - lm[b].z) * vw);
  let sum = 0;
  for (const [tip, mcp] of [[8, 5], [12, 9], [16, 13], [20, 17]]) sum += d(tip, 0) / (d(mcp, 0) || 1);
  return sum / 4;
}
