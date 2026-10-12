import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

// Each stone: tone, shape, and its glass.
// tintAmt = absorption, irid = faint rainbow sheen on the rim, frost = milkiness.
// texture (inside the glass; surfaces stay smooth): clear · frosted · seeded (tiny air bubbles) · ribbon (cat's-eye band)
export const TEXTURES = ['clear', 'frosted', 'seeded', 'ribbon'];
export const STONES = [
  { name: 'Rose Quartz', tint: '#ffb3c7', kind: 'pebble', size: 0.78, tintAmt: 0.55, irid: 0.3, frost: 0.55, texture: 'frosted' },
  { name: 'Sea Glass',   tint: '#8fe3cf', kind: 'pebble', size: 0.70, tintAmt: 0.60, irid: 0.2, frost: 0.8,  texture: 'frosted' },
  { name: 'Amber',       tint: '#ffa640', kind: 'bead',   size: 0.60, tintAmt: 0.80, irid: 0.1, frost: 0,    texture: 'seeded' },
  { name: 'Lavender',    tint: '#b7a3ff', kind: 'egg',    size: 0.70, tintAmt: 0.55, irid: 0.4, frost: 0,    texture: 'clear' },
  { name: 'Cobalt',      tint: '#4f7dff', kind: 'bead',   size: 0.50, tintAmt: 0.85, irid: 0.2, frost: 0,    texture: 'clear' },
  { name: 'Clear',       tint: '#eef3ff', kind: 'bead',   size: 0.88, tintAmt: 0.08, irid: 0.6, frost: 0,    texture: 'seeded' },
  { name: 'Citrine',     tint: '#ffe07a', kind: 'ring',   size: 0.72, tintAmt: 0.60, irid: 0.3, frost: 0,    texture: 'clear' },
  { name: 'Mint',        tint: '#b5ffb8', kind: 'pebble', size: 0.56, tintAmt: 0.50, irid: 0.3, frost: 0,    texture: 'seeded' },
  { name: 'Coral',       tint: '#ff8b7b', kind: 'egg',    size: 0.56, tintAmt: 0.45, irid: 0.2, frost: 0,    texture: 'ribbon' },
  { name: 'Moonstone',   tint: '#dfe8ff', kind: 'pebble', size: 0.66, tintAmt: 0.25, irid: 0.8, frost: 0.9,  texture: 'frosted' },
  { name: 'Plum',        tint: '#d77ee0', kind: 'ring',   size: 0.56, tintAmt: 0.65, irid: 0.3, frost: 0,    texture: 'clear' },
  { name: 'Ice',         tint: '#aee8ff', kind: 'bead',   size: 0.44, tintAmt: 0.40, irid: 0.5, frost: 0,    texture: 'ribbon' },
];

// Shared by the background quad and every stone, so refraction samples exactly what's behind.
export const BG_CHUNK = /* glsl */ `
uniform sampler2D uVideo;
uniform float uHasVideo;
uniform vec2 uVideoScale;
uniform vec2 uResolution;
uniform float uTime;
uniform float uAspect;
uniform sampler2D uHandMask;   // a = hand coverage, g = how near the hand is (0 back .. 1 front)
uniform vec2 uMaskZ;           // world z range the mask's g channel spans
uniform float uExposure;       // camera exposure correction (linear multiplier)
uniform float uBlack;          // camera black level to remove (haze from bright rooms)

// Camera frames arrive sRGB-encoded; decode explicitly (three.js doesn't for video),
// otherwise the gamma is applied twice and the room looks washed out.
vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

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
    vec3 c = srgbToLinear(texture2D(uVideo, clamp(v, vec2(0.001), vec2(0.999))).rgb);
    c = max(c - uBlack, 0.0) / (1.0 - uBlack) * uExposure;  // set black back to black, then expose
    // soft shoulder: bright windows roll off instead of clipping to flat white
    return c * (1.0 + c / 2.25) / (1.0 + c);
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
      uniform vec4 uShadows[8];  // xy = screen uv, z = radius (uv height), w = strength

      void main() {
        vec2 uv = gl_FragCoord.xy / uResolution;
        vec3 c = sceneBg(uv);
        float vig = length((uv - 0.5) * vec2(uAspect, 1.0));
        if (uHasVideo > 0.5) {
          // the real room stays real: no grade, only the faintest lens falloff
          c *= mix(1.0, 0.88, smoothstep(0.5, 1.2, vig));
          // stones cast soft shadows onto the user's hands
          float cover = texture2D(uHandMask, uv).a;
          if (cover > 0.01) {
            float sh = 0.0;
            for (int i = 0; i < 8; i++) {
              vec4 s = uShadows[i];
              if (s.w <= 0.0) continue;
              vec2 d = (uv - s.xy) * vec2(uAspect, 1.0);
              sh = max(sh, s.w * exp(-dot(d, d) / (s.z * s.z)));
            }
            c *= 1.0 - 0.55 * sh * cover;
          }
        } else {
          c *= 0.72;                                        // dim the backdrop so glass pops
          c = mix(c, c * vec3(0.92, 0.97, 1.06), 0.6);      // slight cool grade
          c *= mix(1.0, 0.45, smoothstep(0.35, 1.15, vig));
        }
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
      uTex: { value: Math.max(0, TEXTURES.indexOf(stone.texture || 'clear')) },
    },
    transparent: true,
    vertexShader: /* glsl */ `
      varying vec3 vN;
      varying vec3 vV;
      varying vec3 vObj;
      varying float vWorldZ;
      varying vec3 vObjN;
      varying mat3 vNM;
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
        vObjN = nn;
        vNM = normalMatrix;
        vWorldZ = (modelMatrix * vec4(p, 1.0)).z;
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
      // lit by the real room (camera mode)
      uniform vec3 uAmbient;     // average room color (linear)
      uniform vec3 uKeyColor;    // hue of the brightest light
      uniform vec3 uKeyDir;      // its direction (view space)
      uniform float uKeyStrength;
      uniform sampler2D uEnv;    // blurred room, for reflections
      uniform float uGrain;
      varying vec3 vN;
      varying vec3 vV;
      varying vec3 vObj;
      varying float vWorldZ;
      varying vec3 vObjN;
      varying mat3 vNM;
      uniform float uTex;   // 0 clear, 1 frosted, 2 seeded, 3 ribbon

      vec3 hash33(vec3 p) {
        p = fract(p * vec3(0.1031, 0.1030, 0.0973));
        p += dot(p, p.yxz + 33.33);
        return fract((p.xxy + p.yxx) * p.zyx);
      }
      // nearest feature point: xyz = offset to it, w = distance (static, in the stone's own space)
      vec4 cell(vec3 p) {
        vec3 i = floor(p), f = fract(p);
        vec4 best = vec4(0.0, 0.0, 0.0, 9.0);
        for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) for (int z = -1; z <= 1; z++) {
          vec3 o = vec3(float(x), float(y), float(z));
          vec3 q = o + hash33(i + o) - f;
          float d = length(q);
          if (d < best.w) best = vec4(q, d);
        }
        return best;
      }

      void main() {
        vec3 n = normalize(vN);
        vec3 v = normalize(vV);
        vec3 on = normalize(vObjN);
        vec3 ov = normalize(transpose(vNM) * v);   // toward the camera, in the stone's own space

        float ndv = clamp(dot(n, v), 0.0, 1.0);
        float rim = 1.0 - ndv;
        float fres = pow(rim, 3.0);

        // Transmission: clear glass that bends what's behind it gently (never enough to
        // flip the image), with a touch of softness so the inside stays calm.
        vec2 suv = gl_FragCoord.xy / uResolution;
        vec2 aspect = vec2(1.0 / uAspect, 1.0);
        vec2 off = -n.xy * aspect * uLensR * 0.75;   // magnifies a little, never flips
        float blur = 0.12 + uFrost + uDof * 1.2;
        float rad = uLensR * 0.6 * blur;
        vec3 refr = vec3(0.0);
        for (int i = 0; i < 12; i++) {
          float a = float(i) * 2.39996;
          float rr = rad * sqrt((float(i) + 0.5) / 12.0);
          refr += sceneBg(suv + off + vec2(cos(a), sin(a)) * rr * aspect);
        }
        refr /= 12.0;
        refr = mix(refr, vec3(dot(refr, vec3(0.333))), 0.2 * uFrost) + 0.05 * uFrost;  // milky

        vec3 tint = uTint;
        float room = uHasVideo;  // 1 = match the real room, 0 = studio look
        float ambLum = dot(uAmbient, vec3(0.2126, 0.7152, 0.0722));
        vec3 ambTint = uAmbient / max(ambLum, 1e-3);

        // Absorption (Beer–Lambert): light through the thick center loses more of
        // the colors the glass doesn't pass; the thin rim stays nearly clear.
        float thick = mix(0.3, 1.0, ndv);
        vec3 trans = pow(max(tint, vec3(0.02)), vec3(uTintAmt * 1.5 * thick));
        vec3 body = refr * trans;
        body += tint * 0.04 * ndv * (1.0 - room);
        vec3 lit = mix(vec3(1.0), ambTint * clamp(ambLum * 3.0, 0.45, 1.2), room);

        if (uTex > 1.5 && uTex < 2.5) {
          // seeded: tiny air bubbles suspended at two depths inside the glass
          for (int L = 0; L < 2; L++) {
            vec3 p = (vObj - ov * (0.22 + 0.3 * float(L))) * 6.0 + float(L) * 17.0;
            vec4 c = cell(p);
            float r0 = 0.06 + 0.07 * hash33(floor(p) + 3.0).x;
            float ring = smoothstep(r0 * 0.55, r0 * 0.95, c.w) * (1.0 - smoothstep(r0 * 0.95, r0 * 1.1, c.w));
            float inside = 1.0 - smoothstep(r0 * 0.8, r0, c.w);
            body += lit * (ring * 0.22 + inside * 0.03) * (1.0 - 0.4 * float(L));
          }
        } else if (uTex > 2.5) {
          // ribbon: a cat's-eye band of color through the middle, seen just inside the surface
          vec3 p = vObj - ov * 0.4;
          float sb = p.y + 0.22 * sin(p.x * 2.2 + p.z * 1.4);
          float band = 1.0 - smoothstep(0.07, 0.17, abs(sb));
          float core = 1.0 - smoothstep(0.0, 0.06, abs(sb));
          vec3 ribbon = tint * lit * mix(0.55, 0.9, core) + lit * core * 0.12;
          body = mix(body, ribbon, band * 0.8);
        }

        // Caustic: light focused through the stone pools on the side away from the light.
        vec3 causticDir = normalize(mix(vec3(-0.25, -0.75, 0.6), vec3(-uKeyDir.xy, 0.6), room));
        float caustic = pow(max(dot(n, causticDir), 0.0), 5.0);
        body += tint * caustic * mix(0.38, 0.5 * clamp(ambLum * 2.5, 0.2, 1.0), room);

        // Darker band just inside the silhouette (total internal reflection).
        float band = smoothstep(0.35, 0.7, rim) * (1.0 - smoothstep(0.8, 0.98, rim));
        body *= 1.0 - 0.3 * band;

        // Thin-film iridescence on the rim.
        vec3 irid = 0.5 + 0.5 * cos(6.28318 * (vec3(0.0, 0.33, 0.67) + fres * 1.2 + uIridShift));
        vec3 rimCol = mix(vec3(1.0), irid, uIrid * 0.45) * mix(vec3(1.0), tint, 0.3);
        rimCol *= mix(vec3(1.0), ambTint * clamp(ambLum * 3.0, 0.45, 1.1), room);

        // Studio lighting in view space: softbox overhead + two sharp highlights.
        vec3 r = reflect(-v, n);
        float softbox = smoothstep(0.35, 0.8, r.y) * smoothstep(0.75, 0.15, abs(r.x + 0.15));
        // out of focus: highlights spread into soft bokeh instead of pin-sharp glints
        float sharp = mix(220.0, 30.0, uDof);
        float spec  = pow(max(dot(r, normalize(vec3(0.45, 0.65, 0.62))), 0.0), sharp) * mix(2.4, 0.5, uDof);
        float spec2 = pow(max(dot(r, normalize(vec3(-0.55, 0.35, 0.75))), 0.0), 40.0) * 0.22;
        float floorRef = smoothstep(-0.2, -0.8, r.y) * 0.07;

        vec3 studio = vec3(softbox) * 0.22 * (0.35 + fres) + vec3(spec + spec2) + tint * floorRef;

        // Room lighting: reflections are the room itself, the highlight sits where
        // the room's brightest light is, in that light's color.
        vec3 envC = srgbToLinear(texture2D(uEnv, 0.5 + r.xy * 0.45).rgb);
        envC = max(envC - uBlack, 0.0) / (1.0 - uBlack) * uExposure;
        float kspec = pow(max(dot(r, uKeyDir), 0.0), sharp) * mix(1.4, 0.35, uDof) * clamp(uKeyStrength * 0.45, 0.4, 1.6);
        vec3 roomLight = envC * (0.06 + 0.5 * fres) + uKeyColor * kspec;

        vec3 col = body;
        col += rimCol * fres * mix(0.8, 0.45, room);
        col += mix(studio, roomLight, room);
        col += uHover * (fres * 0.9 + 0.07) * mix(vec3(1.0), tint, 0.5) * mix(1.0, 0.6, room);

        col = mix(col, sceneBg(suv) * mix(0.7, 0.95, room) + tint * 0.03, uHaze * mix(1.0, 0.5, room));


        float alpha = 1.0 - uDof * smoothstep(0.5, 1.0, rim);  // soft, defocused silhouette

        // real hands in front of the glass hide it
        vec4 hm = texture2D(uHandMask, suv);
        if (hm.a > 0.01) {
          float handZ = mix(uMaskZ.x, uMaskZ.y, hm.g);
          alpha *= 1.0 - hm.a * smoothstep(-0.15, 0.35, handZ - vWorldZ);
        }

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
      texture: TEXTURES[Math.floor(rnd() * TEXTURES.length)],
      small: true,
    };
  }).map((st) => ({ ...st, frost: st.texture === 'frosted' ? 0.75 : 0 }));
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
