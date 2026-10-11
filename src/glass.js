import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

// Each stone: tone, shape, and how the glass behaves.
// tintAmt = absorption, irid = thin-film rainbow on the rim, frost = sea-glass blur.
export const STONES = [
  { name: 'Rose Quartz', tint: '#ffb3c7', kind: 'pebble', size: 0.78, tintAmt: 0.55, irid: 0.35, frost: 0.0 },
  { name: 'Sea Glass',   tint: '#8fe3cf', kind: 'pebble', size: 0.70, tintAmt: 0.60, irid: 0.20, frost: 0.7 },
  { name: 'Amber',       tint: '#ffa640', kind: 'bead',   size: 0.60, tintAmt: 0.80, irid: 0.15, frost: 0.0 },
  { name: 'Lavender',    tint: '#b7a3ff', kind: 'egg',    size: 0.70, tintAmt: 0.55, irid: 0.50, frost: 0.0 },
  { name: 'Cobalt',      tint: '#4f7dff', kind: 'bead',   size: 0.50, tintAmt: 0.85, irid: 0.20, frost: 0.0 },
  { name: 'Clear',       tint: '#eef3ff', kind: 'bead',   size: 0.88, tintAmt: 0.08, irid: 0.90, frost: 0.0 },
  { name: 'Citrine',     tint: '#ffe07a', kind: 'ring',   size: 0.72, tintAmt: 0.60, irid: 0.30, frost: 0.0 },
  { name: 'Mint',        tint: '#b5ffb8', kind: 'pebble', size: 0.56, tintAmt: 0.50, irid: 0.40, frost: 0.0 },
  { name: 'Coral',       tint: '#ff8b7b', kind: 'egg',    size: 0.56, tintAmt: 0.60, irid: 0.25, frost: 0.0 },
  { name: 'Moonstone',   tint: '#dfe8ff', kind: 'pebble', size: 0.66, tintAmt: 0.25, irid: 1.00, frost: 0.9 },
  { name: 'Plum',        tint: '#d77ee0', kind: 'ring',   size: 0.56, tintAmt: 0.65, irid: 0.40, frost: 0.0 },
  { name: 'Ice',         tint: '#aee8ff', kind: 'bead',   size: 0.44, tintAmt: 0.40, irid: 0.60, frost: 0.0 },
];

// Shared by the background quad and every stone, so refraction samples exactly what's behind.
export const BG_CHUNK = /* glsl */ `
uniform sampler2D uVideo;
uniform float uHasVideo;
uniform vec2 uVideoScale;
uniform vec2 uResolution;
uniform float uTime;
uniform float uAspect;

vec3 fallbackBg(vec2 uv) {
  vec2 p = (uv - 0.5) * vec2(uAspect, 1.0);
  // authored in sRGB-ish values, converted to linear at the end
  vec3 c = mix(vec3(0.05, 0.055, 0.075), vec3(0.16, 0.14, 0.22), uv.y);
  vec2 a = p - vec2(-0.45 + 0.05 * sin(uTime * 0.21), 0.22);
  vec2 b = p - vec2(0.55, -0.18 + 0.05 * cos(uTime * 0.17));
  c += vec3(0.50, 0.24, 0.36) * exp(-5.0 * dot(a, a));
  c += vec3(0.12, 0.30, 0.55) * exp(-4.0 * dot(b, b));
  vec2 g = abs(fract(p * 7.0) - 0.5);
  c += 0.06 * smoothstep(0.46, 0.5, max(g.x, g.y));
  return pow(c, vec3(2.2));
}

vec3 sceneBg(vec2 uv) {
  if (uHasVideo > 0.5) {
    vec2 v = (uv - 0.5) * uVideoScale + 0.5;
    v.x = 1.0 - v.x; // mirror, like a selfie view
    return texture2D(uVideo, clamp(v, vec2(0.001), vec2(0.999))).rgb;
  }
  return fallbackBg(uv);
}
`;

export function makeBackground(shared) {
  const mat = new THREE.ShaderMaterial({
    uniforms: shared,
    depthWrite: false,
    depthTest: false,
    vertexShader: /* glsl */ `
      void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: BG_CHUNK + /* glsl */ `
      void main() {
        vec2 uv = gl_FragCoord.xy / uResolution;
        vec3 c = sceneBg(uv);
        c *= 0.72;                                        // dim the room so glass pops
        c = mix(c, c * vec3(0.92, 0.97, 1.06), 0.6);      // slight cool grade
        float vig = length((uv - 0.5) * vec2(uAspect, 1.0));
        c *= mix(1.0, 0.45, smoothstep(0.35, 1.15, vig));
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return mesh;
}

export function makeGlassMaterial(shared, stone) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...shared,
      uTint: { value: new THREE.Color(stone.tint) },
      uTintAmt: { value: stone.tintAmt },
      uIrid: { value: stone.irid },
      uIridShift: { value: Math.random() },
      uFrost: { value: stone.frost },
      uHover: { value: 0 },
      uLensR: { value: 0.05 },
      uIor: { value: 1.55 },
      uDof: { value: 0 },
      uHaze: { value: 0 },
      uJAxis: { value: new THREE.Vector3(0, 1, 0) },
      uJAmt: { value: 0 },
      uDentDir: { value: new THREE.Vector3(0, 0, 1) },
      uDent: { value: 0 },
    },
    transparent: true,
    vertexShader: /* glsl */ `
      varying vec3 vN;
      varying vec3 vV;
      varying vec3 vObj;
      uniform vec3 uJAxis;     // jelly axis (object space)
      uniform float uJAmt;     // >0 stretch, <0 squash, volume-preserving
      uniform vec3 uDentDir;   // where a fingertip presses in (object space)
      uniform float uDent;     // dent depth (object units)

      void main() {
        vec3 p = position;
        vec3 nn = normal;

        // fingertip dent: cap pushed inward, normals tilted so the dimple catches light
        vec3 u = normalize(position);
        float c = max(dot(u, uDentDir), 0.0);
        const float M = 10.0;
        p -= uDentDir * uDent * pow(c, M);
        nn = normalize(nn - uDent * M * pow(c, M - 1.0) * (u - c * uDentDir));

        // jelly squash & stretch along an axis
        float s = 1.0 + uJAmt;
        float a = dot(p, uJAxis);
        p = uJAxis * a * s + (p - a * uJAxis) / sqrt(s);
        float an = dot(nn, uJAxis);
        nn = normalize(uJAxis * an / s + (nn - an * uJAxis) * sqrt(s));

        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vN = normalize(normalMatrix * nn);
        vV = -mv.xyz;
        vObj = position;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: BG_CHUNK + /* glsl */ `
      uniform vec3 uTint;
      uniform float uTintAmt;
      uniform float uIrid;
      uniform float uIridShift;
      uniform float uFrost;
      uniform float uHover;
      uniform float uLensR;
      uniform float uIor;
      uniform float uDof;   // 0 = in focus, 1 = fully out of focus
      uniform float uHaze;  // atmospheric fade for far stones
      varying vec3 vN;
      varying vec3 vV;
      varying vec3 vObj;

      void main() {
        vec3 n = normalize(vN);
        vec3 v = normalize(vV);
        float ndv = clamp(dot(n, v), 0.0, 1.0);
        float rim = 1.0 - ndv;
        float fres = pow(rim, 3.0);

        // Ball-lens refraction: offset grows toward the rim and overshoots the
        // center, so the room appears flipped & magnified inside each stone.
        vec2 suv = gl_FragCoord.xy / uResolution;
        vec2 k = vec2(1.0 / uAspect, 1.0) * uLensR * uIor;
        vec2 off = -n.xy * k;

        vec3 refr;
        refr.r = sceneBg(suv + off * 0.90).r;
        refr.g = sceneBg(suv + off * 1.00).g;
        refr.b = sceneBg(suv + off * 1.12).b;

        // Frosted glass and depth-of-field share one blur.
        float blur = max(uFrost, uDof * 1.3);
        if (blur > 0.01) {
          vec3 acc = vec3(0.0);
          float rad = blur * uLensR * 0.4;
          for (int i = 0; i < 8; i++) {
            float a = float(i) * 0.785398 + vObj.x * 3.0;
            float rr = rad * (0.5 + 0.5 * fract(float(i) * 0.618));
            acc += sceneBg(suv + off + vec2(cos(a), sin(a)) * rr * vec2(1.0 / uAspect, 1.0));
          }
          refr = mix(refr, acc / 8.0, clamp(blur, 0.0, 1.0));
          refr += 0.04 * uFrost;            // milky scattering
        }

        vec3 tint = uTint;
        // Absorption: thicker center soaks up more color.
        vec3 body = refr * mix(vec3(1.0), tint, uTintAmt);
        body = mix(body, body * tint, uTintAmt * 0.55 * ndv);
        body += tint * 0.05 * ndv;

        // Caustic: light focused through the stone pools on the lower side.
        float caustic = pow(max(dot(n, normalize(vec3(-0.25, -0.75, 0.6))), 0.0), 5.0);
        body += tint * caustic * 0.38;

        // Darker band just inside the silhouette (total internal reflection).
        float band = smoothstep(0.35, 0.7, rim) * (1.0 - smoothstep(0.8, 0.98, rim));
        body *= 1.0 - 0.3 * band;

        // Thin-film iridescence on the rim.
        vec3 irid = 0.5 + 0.5 * cos(6.28318 * (vec3(0.0, 0.33, 0.67) + fres * 1.4 + uIridShift + vObj.y * 0.2));
        vec3 rimCol = mix(vec3(1.0), irid, uIrid) * mix(vec3(1.0), tint, 0.3);

        // Studio lighting in view space: softbox overhead + two sharp highlights.
        vec3 r = reflect(-v, n);
        float softbox = smoothstep(0.35, 0.8, r.y) * smoothstep(0.75, 0.15, abs(r.x + 0.15));
        // out of focus: highlights spread into soft bokeh instead of pin-sharp glints
        float sharp = mix(220.0, 30.0, uDof);
        float spec  = pow(max(dot(r, normalize(vec3(0.45, 0.65, 0.62))), 0.0), sharp) * mix(2.4, 0.5, uDof);
        float spec2 = pow(max(dot(r, normalize(vec3(-0.55, 0.35, 0.75))), 0.0), 40.0) * 0.22;
        float floorRef = smoothstep(-0.2, -0.8, r.y) * 0.07;

        vec3 col = body;
        col += rimCol * fres * 0.8;
        col += vec3(softbox) * 0.22 * (0.35 + fres);
        col += vec3(spec + spec2);
        col += tint * floorRef;
        col += uHover * (fres * 0.9 + 0.07) * mix(vec3(1.0), tint, 0.5);

        col = mix(col, sceneBg(suv) * 0.7 + tint * 0.03, uHaze);
        float alpha = 1.0 - uDof * smoothstep(0.5, 1.0, rim);  // soft, defocused silhouette

        gl_FragColor = vec4(col, alpha);
        #include <colorspace_fragment>
      }
    `,
  });
}

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Little chips for the pile, borrowing tones from the hero stones.
export function makeSmallStones(count, seed = 7) {
  const rnd = mulberry32(seed);
  return Array.from({ length: count }, () => {
    const base = STONES[Math.floor(rnd() * STONES.length)];
    return {
      ...base,
      name: base.name + ' chip',
      kind: rnd() < 0.55 ? 'bead' : rnd() < 0.8 ? 'pebble' : 'egg',
      size: 0.26 + rnd() * 0.17,
      frost: rnd() < 0.2 ? 0.7 : base.frost,
      small: true,
    };
  });
}

// Returns a unit-ish geometry; caller scales by stone.size.
export function makeStoneGeometry(kind, seed, detail = 24) {
  if (kind === 'ring') {
    const g = new THREE.TorusGeometry(0.69, 0.31, 48, 96);
    g.computeBoundingSphere();
    return g;
  }

  let g = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g);

  const rnd = mulberry32(seed * 9973 + 17);
  const waves = Array.from({ length: 4 }, () => {
    const d = new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).normalize();
    return { d, f: 0.5 + rnd() * 0.7, ph: rnd() * Math.PI * 2, a: 0.03 + rnd() * 0.05 };
  });
  const squash = kind === 'pebble'
    ? new THREE.Vector3(1.1 + rnd() * 0.15, 0.72 + rnd() * 0.12, 0.92 + rnd() * 0.1)
    : new THREE.Vector3(1, 1, 1);
  const amp = kind === 'pebble' ? 1 : kind === 'egg' ? 0.35 : 0;

  const pos = g.attributes.position;
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).normalize();
    let d = 1;
    for (const w of waves) d += amp * w.a * Math.sin(w.f * p.dot(w.d) * 3 + w.ph);
    let x = p.x * d * squash.x, y = p.y * d * squash.y, z = p.z * d * squash.z;
    if (kind === 'egg') {
      const taper = 1 - 0.16 * p.y;
      x *= taper * 0.9; z *= taper * 0.9; y *= 1.12;
    }
    pos.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

// Soft radial glow for the 3D fingertip orbs.
export function makeGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.18, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.4, 'rgba(200,225,255,0.28)');
  grad.addColorStop(1, 'rgba(200,225,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
