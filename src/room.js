import * as THREE from 'three';

// Reads the real room from the camera so the glass can be lit by it:
// average color (white balance + exposure), where the brightest light is,
// and a blurred copy of the room for reflections.
export function createRoomProbe(video) {
  const W = 64, H = 36, N = W * H;
  const small = document.createElement('canvas');
  small.width = W; small.height = H;
  const g = small.getContext('2d', { willReadFrequently: true });
  const env = document.createElement('canvas');
  env.width = W; env.height = H;
  const eg = env.getContext('2d');
  const envTex = new THREE.CanvasTexture(env);
  envTex.colorSpace = THREE.NoColorSpace; // decoded in the shader, like the video

  const lum = new Float32Array(N);
  const sorted = new Float32Array(N);
  const toLinear = new Float32Array(256).map((_, i) => Math.pow(i / 255, 2.2));

  const probe = {
    envTex,
    ready: false,
    ambient: new THREE.Color(0.4, 0.4, 0.4),   // linear average of the room
    keyColor: new THREE.Color(1, 1, 1),        // linear color of the brightest light
    keyUV: new THREE.Vector2(0.5, 0.8),        // screen uv (bottom-left origin) of that light
    keyStrength: 2,                            // how much brighter than the room it is
    black: 0,                                  // linear luminance of the darkest 1% (camera haze)
  };

  const amb = new THREE.Color(), key = new THREE.Color(), uv = new THREE.Vector2();

  probe.update = () => {
    if (video.readyState < 2) return;
    // mirrored, like the on-screen selfie view
    g.save(); g.translate(W, 0); g.scale(-1, 1); g.drawImage(video, 0, 0, W, H); g.restore();
    const d = g.getImageData(0, 0, W, H).data;

    let r = 0, gg = 0, b = 0;
    for (let i = 0; i < N; i++) {
      const lr = toLinear[d[i * 4]], lg = toLinear[d[i * 4 + 1]], lb = toLinear[d[i * 4 + 2]];
      r += lr; gg += lg; b += lb;
      lum[i] = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
    }
    amb.setRGB(r / N, gg / N, b / N);
    const avgLum = 0.2126 * amb.r + 0.7152 * amb.g + 0.0722 * amb.b;

    // key light = weighted centroid of the brightest 4% of the frame
    sorted.set(lum); sorted.sort();
    const thr = sorted[Math.floor(N * 0.96)];
    const black = sorted[Math.floor(N * 0.01)];
    let wSum = 0, kx = 0, ky = 0, kr = 0, kg = 0, kb = 0, kl = 0;
    for (let i = 0; i < N; i++) {
      const w = lum[i] - thr;
      if (w <= 0) continue;
      wSum += w;
      kx += w * (i % W); ky += w * Math.floor(i / W);
      kr += w * toLinear[d[i * 4]]; kg += w * toLinear[d[i * 4 + 1]]; kb += w * toLinear[d[i * 4 + 2]];
      kl += w * lum[i];
    }
    if (wSum > 0) {
      uv.set((kx / wSum + 0.5) / W, 1 - (ky / wSum + 0.5) / H);
      key.setRGB(kr / wSum, kg / wSum, kb / wSum);
      const m = Math.max(key.r, key.g, key.b, 1e-4);
      key.multiplyScalar(1 / m); // keep its hue, not its brightness
    }
    const strength = wSum > 0 ? (kl / wSum) / Math.max(avgLum, 1e-3) : 1;

    const a = probe.ready ? 0.15 : 1; // light changes slowly; don't flicker
    probe.ambient.lerp(amb, a);
    probe.keyColor.lerp(key, a);
    probe.keyUV.lerp(uv, a);
    probe.keyStrength += (Math.min(strength, 6) - probe.keyStrength) * a;
    probe.black += (black - probe.black) * a;
    probe.ready = true;

    eg.filter = 'blur(3px)';
    eg.drawImage(small, 0, 0);
    eg.filter = 'none';
    envTex.needsUpdate = true;
  };

  return probe;
}

// A soft mask of the user's hands, with depth: alpha = coverage, green = how near
// the hand is (0 = back of the room, 1 = front). Stones behind a hand are hidden
// where the mask covers them, so real fingers pass in front of virtual glass.
export function createHandMask() {
  const canvas = document.createElement('canvas');
  const g = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.premultiplyAlpha = false;
  let scale = 1 / 3, empty = false;

  const PALM = [0, 1, 5, 9, 13, 17];
  const BONES = [
    [1, 2], [2, 3], [3, 4], [5, 6], [6, 7], [7, 8], [9, 10], [10, 11], [11, 12],
    [13, 14], [14, 15], [15, 16], [17, 18], [18, 19], [19, 20],
  ];

  return {
    tex,
    resize(W, H) {
      canvas.width = Math.max(1, Math.ceil(W * scale));
      canvas.height = Math.max(1, Math.ceil(H * scale));
      empty = false;
    },
    // hands: [{ pts: [[x, y] × 21] screen px, near: [0..1 × 21] }]
    draw(hands) {
      if (!hands.length) {
        if (!empty) { g.clearRect(0, 0, canvas.width, canvas.height); tex.needsUpdate = true; empty = true; }
        return;
      }
      empty = false;
      g.clearRect(0, 0, canvas.width, canvas.height);
      g.filter = 'blur(1.5px)';
      g.lineCap = 'round';
      g.lineJoin = 'round';
      const col = (t) => `rgb(255,${Math.round(Math.min(Math.max(t, 0), 1) * 255)},0)`;
      for (const h of hands) {
        const P = h.pts.map(([x, y]) => [x * scale, y * scale]);
        const palmW = Math.hypot(P[5][0] - P[17][0], P[5][1] - P[17][1]);
        // farther parts first, so nearer fingers win where they overlap
        const segs = BONES.map(([a, b]) => ({ a, b, t: (h.near[a] + h.near[b]) / 2 })).sort((x, y) => x.t - y.t);
        const palmT = PALM.reduce((s, i) => s + h.near[i], 0) / PALM.length;
        g.fillStyle = col(palmT);
        g.strokeStyle = col(palmT);
        g.lineWidth = palmW * 0.35;
        g.beginPath();
        PALM.forEach((i, k) => (k ? g.lineTo(...P[i]) : g.moveTo(...P[i])));
        g.closePath(); g.fill(); g.stroke();
        for (const s of segs) {
          g.strokeStyle = col(s.t);
          g.lineWidth = palmW * (s.a <= 4 ? 0.34 : 0.3);
          g.beginPath(); g.moveTo(...P[s.a]); g.lineTo(...P[s.b]); g.stroke();
        }
      }
      g.filter = 'none';
      tex.needsUpdate = true;
    },
  };
}
