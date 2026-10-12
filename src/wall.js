import * as THREE from 'three';
import { BG_CHUNK } from './glass.js';

// A frosted glass pinboard floating to the right, angled toward you like a visionOS
// window. Stones stick to it in rows; each row is a category with an editable label.
export const WALL_ROWS = 3;
const DEFAULT_LABELS = ['Warm', 'Cool', 'Clear'];
const WALL_Z = -3.5;
const WALL_YAW = -0.45;   // turned toward the center of the room
const STORE = 'glass-beads-wall-v1';

export function createWall(shared) {
  const size = new THREE.Vector2(4.0, 4.6);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...shared,
      uSize: { value: size },
      uActive: { value: 0 },
      uRows: { value: WALL_ROWS },
    },
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying float vWorldZ;
      void main() {
        vUv = uv;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorldZ = w.z;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: BG_CHUNK + /* glsl */ `
      uniform vec2 uSize;
      uniform float uActive;
      uniform float uRows;
      varying vec2 vUv;
      varying float vWorldZ;

      float sdRoundBox(vec2 p, vec2 b, float r) {
        vec2 q = abs(p) - b + r;
        return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
      }

      void main() {
        vec2 p = (vUv - 0.5) * uSize;
        float d = sdRoundBox(p, uSize * 0.5, 0.4);
        float mask = smoothstep(0.02, -0.02, d);
        if (mask < 0.001) discard;

        // frosted glass: the room behind, blurred and lifted a little
        vec2 suv = gl_FragCoord.xy / uResolution;
        vec3 c = vec3(0.0);
        for (int i = 0; i < 12; i++) {
          float a = float(i) * 2.39996;
          float r = 0.022 * sqrt((float(i) + 0.5) / 12.0);
          c += sceneBg(suv + vec2(cos(a), sin(a)) * r * vec2(1.0 / uAspect, 1.0));
        }
        c = c / 12.0 * 0.9 + 0.035;

        // soft edge highlight, faint shelf lines between categories
        float edge = smoothstep(-0.1, 0.0, d) * 0.35;
        float rowH = uSize.y / uRows;
        float line = 0.0;
        for (int i = 1; i < 6; i++) {
          if (float(i) >= uRows) break;
          float y = uSize.y * 0.5 - float(i) * rowH;
          line = max(line, smoothstep(0.025, 0.0, abs(p.y - y)) * step(abs(p.x), uSize.x * 0.5 - 0.3));
        }
        c += vec3(edge + line * 0.08 + uActive * 0.05);
        float alpha = mask * (0.5 + 0.25 * uActive);

        // real hands in front of the panel hide it
        vec4 hm = texture2D(uHandMask, suv);
        if (hm.a > 0.01) {
          float handZ = mix(uMaskZ.x, uMaskZ.y, hm.g);
          alpha *= 1.0 - hm.a * smoothstep(-0.15, 0.35, handZ - vWorldZ);
        }
        gl_FragColor = vec4(c, alpha);
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size.x, size.y), mat);
  mesh.renderOrder = -0.2;
  mesh.rotation.y = WALL_YAW;

  // target ring: where a carried stone will land
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.9, 1, 48),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }),
  );
  ring.renderOrder = -0.1;
  mesh.add(ring);

  const inv = new THREE.Matrix4();
  const normal = new THREE.Vector3();
  const tmp = new THREE.Vector3(), o = new THREE.Vector3();

  // row labels (DOM, editable, saved)
  const saved = load();
  const labels = Array.from({ length: WALL_ROWS }, (_, i) => {
    const el = document.createElement('div');
    el.className = 'wall-label';
    el.contentEditable = 'true';
    el.spellcheck = false;
    el.textContent = saved.labels?.[i] || DEFAULT_LABELS[i];
    el.addEventListener('input', () => save());
    el.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
    document.body.appendChild(el);
    return el;
  });

  function load() {
    try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; }
  }
  let layout = saved.layout || {};
  function save() {
    try {
      localStorage.setItem(STORE, JSON.stringify({ labels: labels.map((l) => l.textContent.trim()), layout }));
    } catch { /* private mode etc. */ }
  }

  const rowY = (row) => size.y / 2 - (row + 0.5) * (size.y / WALL_ROWS);

  const wall = {
    mesh,
    size,
    normal,
    rows: WALL_ROWS,
    rowY,
    savedLayout: () => layout,

    // keep it at the right side of the view, whatever the window shape
    place(halfExtents) {
      const { hw, hh } = halfExtents(WALL_Z);
      const s = Math.min(1, (hw * 0.5) / size.x, (hh * 1.1) / size.y);
      mesh.scale.setScalar(s);
      mesh.position.set(hw - size.x * s * 0.62, hh * 0.3, WALL_Z);  // floats above the pile
      mesh.updateMatrixWorld(true);
      inv.copy(mesh.matrixWorld).invert();
      normal.set(0, 0, 1).transformDirection(mesh.matrixWorld);
    },

    // panel-local (x, y), lifted `lift` off the glass -> world
    toWorld(x, y, lift, out) {
      return out.set(x, y, lift / mesh.scale.x).applyMatrix4(mesh.matrixWorld);
    },

    // where a ray from the camera meets the panel, in panel-local units (null if it misses)
    hit(origin, dir, margin = 0) {
      o.copy(origin).applyMatrix4(inv);
      tmp.copy(dir).transformDirection(inv);
      if (Math.abs(tmp.z) < 1e-5) return null;
      const t = -o.z / tmp.z;
      if (t <= 0) return null;
      const x = o.x + tmp.x * t, y = o.y + tmp.y * t;
      if (Math.abs(x) > size.x / 2 + margin || Math.abs(y) > size.y / 2 + margin) return null;
      return { x, y };
    },

    // a free spot for stone b in the row nearest y: slides along the row off its neighbors
    slot(b, x, y, stuck) {
      const row = THREE.MathUtils.clamp(Math.floor((size.y / 2 - y) / (size.y / WALL_ROWS)), 0, WALL_ROWS - 1);
      const r = b.r / mesh.scale.x;
      const minX = -size.x / 2 + r + 0.2, maxX = size.x / 2 - r - 0.2;
      let sx = THREE.MathUtils.clamp(x, minX, maxX);
      const others = stuck.filter((o2) => o2 !== b && o2.wall && o2.wall.row === row);
      for (let it = 0; it < 12; it++) {
        let moved = false;
        for (const o2 of others) {
          const gap = r + o2.r / mesh.scale.x + 0.06 - Math.abs(sx - o2.wall.x);
          if (gap > 0) { sx += (sx >= o2.wall.x ? 1 : -1) * gap; moved = true; }
        }
        sx = THREE.MathUtils.clamp(sx, minX, maxX);
        if (!moved) break;
      }
      return { row, x: sx, y: rowY(row) };
    },

    showTarget(slot, b, k) {
      ring.material.opacity = 0.55 * k;
      if (!slot) return;
      ring.position.set(slot.x, slot.y, 0.01);
      ring.scale.setScalar((b.r / mesh.scale.x) * 1.05);
    },

    setActive(k) { mat.uniforms.uActive.value = k; },

    remember(name, slot) {
      if (slot) layout[name] = { row: slot.row, x: slot.x }; else delete layout[name];
      save();
    },
    forgetAll() { layout = {}; save(); },

    // project row labels onto the screen, as tabs beside the rows
    updateLabels(camera, W, H) {
      labels.forEach((el, i) => {
        // a tab on the panel's left edge, level with its row
        tmp.set(-size.x / 2, rowY(i), 0).applyMatrix4(mesh.matrixWorld).project(camera);
        const x = (tmp.x * 0.5 + 0.5) * W, y = (-tmp.y * 0.5 + 0.5) * H;
        el.style.transform = `translate(calc(${x.toFixed(1)}px - 100% - 10px), calc(${y.toFixed(1)}px - 50%))`;
      });
    },
  };
  return wall;
}
