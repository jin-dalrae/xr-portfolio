import * as THREE from 'three';

// A round glass bowl, tipped toward the viewer so you see into it, like a dish being
// shown off. Its sides curve up, so the stones settle into it and never roll out.
export const TRAY_TILT = 0.45;                          // radians (~26°) toward the viewer
export const TRAY_RADIUS = 3.2;
export const RIM_TUBE = 0.17;                           // rim thickness (radius of its glass tube)
const BOWL_K = 0.15;                                    // curvature: height = k · r²
const TRAY_CENTER = new THREE.Vector3(0, -2.7, -3);

const trayQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), TRAY_TILT);
const trayQInv = trayQ.clone().invert();
const local = new THREE.Vector3(), tmp = new THREE.Vector3(), nl = new THREE.Vector3();

const toLocal = (p) => local.copy(p).sub(TRAY_CENTER).applyQuaternion(trayQInv);
const toWorld = (v, out) => out.copy(v).applyQuaternion(trayQ).add(TRAY_CENTER);
// bowl inside the rim; a flat ledge at rim height outside it
const bowlH = (x, z) => BOWL_K * Math.min(x * x + z * z, TRAY_RADIUS * TRAY_RADIUS);
const RIM_H = BOWL_K * TRAY_RADIUS * TRAY_RADIUS;

// Point on the bowl under p (world) and its normal; returns p's distance above it.
export function trayProbe(p, outPoint, outNormal) {
  toLocal(p);
  const inside = local.x * local.x + local.z * local.z < TRAY_RADIUS * TRAY_RADIUS;
  const h = bowlH(local.x, local.z);
  nl.set(inside ? -2 * BOWL_K * local.x : 0, 1, inside ? -2 * BOWL_K * local.z : 0).normalize();
  outNormal.copy(nl).applyQuaternion(trayQ);
  toWorld(tmp.set(local.x, h, local.z), outPoint);
  return (local.y - h) * nl.y;
}

// Contact with the bowl. Returns penetration (> 0 = overlapping, ~0 = resting), writes the normal.
export function trayPlane(p, r, outNormal) {
  toLocal(p);
  if (Math.hypot(local.x, local.z) > TRAY_RADIUS) return -Infinity; // outside the bowl
  const h = bowlH(local.x, local.z);
  nl.set(-2 * BOWL_K * local.x, 1, -2 * BOWL_K * local.z).normalize();
  const d = (local.y - h) * nl.y;
  if (d < -2 * r) return -Infinity; // underneath
  outNormal.copy(nl).applyQuaternion(trayQ);
  return r - d;
}

// Contact with the rim: a ring of glass tube around the top edge of the bowl.
export function trayRim(p, r, outNormal) {
  toLocal(p);
  const rho = Math.hypot(local.x, local.z) || 1e-6;
  tmp.set((local.x / rho) * TRAY_RADIUS, RIM_H + RIM_TUBE, (local.z / rho) * TRAY_RADIUS);
  tmp.subVectors(local, tmp);
  const d = tmp.length();
  const pen = r + RIM_TUBE - d;
  if (pen <= 0) return 0;
  outNormal.copy(tmp).divideScalar(d || 1).applyQuaternion(trayQ);
  return pen;
}

// Where does a ray from the camera land in the bowl? Marches, then bisects.
const rp = new THREE.Vector3(), rpt = new THREE.Vector3(), rn = new THREE.Vector3();
export function rayTray(origin, dir, out, maxT = 40) {
  const at = (t) => trayProbe(rp.copy(origin).addScaledVector(dir, t), rpt, rn);
  if (at(0) <= 0) return null;
  let t0 = 0;
  for (let t = 0.25; t <= maxT; t += 0.25) {
    if (at(t) <= 0) {
      let lo = t0, hi = t;
      for (let k = 0; k < 16; k++) { const m = (lo + hi) / 2; if (at(m) > 0) lo = m; else hi = m; }
      return out.copy(origin).addScaledVector(dir, (lo + hi) / 2);
    }
    t0 = t;
  }
  return null;
}

// Bowl-local (x, z) -> world point on its surface.
export const trayAt = (x, z, out) => toWorld(tmp.set(x, bowlH(x, z), z), out);

// The bowl itself: faint glass with a sheen, and a real glass rim
// (same shader as the stones, so it refracts the room too).
export function makeFloor(rimMaterial) {
  const group = new THREE.Group();
  group.position.copy(TRAY_CENTER);
  group.quaternion.copy(trayQ);

  const discMat = new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 1 } },
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec2 vL;
      void main() {
        vL = position.xz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uOpacity;
      varying vec2 vL;
      void main() {
        float r = length(vL) / ${TRAY_RADIUS.toFixed(2)};
        float fill = 0.05 + 0.05 * smoothstep(0.2, 1.0, r);        // glass reads thicker toward the edge
        float sheen = 0.07 * smoothstep(0.6, 0.0, abs(vL.x * 0.18 + vL.y * 0.12 - 0.15)); // a soft diagonal reflection
        float edge = smoothstep(0.93, 0.995, r) * 0.25;
        float a = (fill + sheen + edge) * (1.0 - smoothstep(0.995, 1.0, r)) * uOpacity;
        gl_FragColor = vec4(vec3(0.88, 0.93, 1.0), a);
        #include <colorspace_fragment>
      }
    `,
  });
  const discGeo = new THREE.CircleGeometry(TRAY_RADIUS, 128, 0, Math.PI * 2).rotateX(-Math.PI / 2);
  // CircleGeometry has one ring; rebuild with rings so the bowl can curve
  const bowlGeo = new THREE.RingGeometry(0.001, TRAY_RADIUS, 128, 24).rotateX(-Math.PI / 2);
  const bp = bowlGeo.attributes.position;
  for (let i = 0; i < bp.count; i++) bp.setY(i, bowlH(bp.getX(i), bp.getZ(i)));
  bowlGeo.computeVertexNormals();
  discGeo.dispose();
  const disc = new THREE.Mesh(bowlGeo, discMat);
  disc.renderOrder = -0.5;

  const rim = new THREE.Mesh(new THREE.TorusGeometry(TRAY_RADIUS, RIM_TUBE, 24, 192).rotateX(Math.PI / 2), rimMaterial);
  rim.position.y = RIM_H + RIM_TUBE;

  group.add(disc, rim);
  group.userData.setOpacity = (o) => {
    discMat.uniforms.uOpacity.value = o;
    rim.visible = o > 0.05;
  };
  group.userData.rim = rim;
  return group;
}

function radialTexture(stops) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  for (const [t, col] of stops) grad.addColorStop(t, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const shadowTex = radialTexture([[0, 'rgba(0,0,0,0.85)'], [0.45, 'rgba(0,0,0,0.45)'], [1, 'rgba(0,0,0,0)']]);
const causticTex = radialTexture([[0, 'rgba(255,255,255,1)'], [0.3, 'rgba(255,255,255,0.5)'], [1, 'rgba(255,255,255,0)']]);
const flatPlane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

// Soft contact shadow + a pool of colored light focused through the glass.
export function makeShadow(tint) {
  const shadow = new THREE.Mesh(flatPlane, new THREE.MeshBasicMaterial({
    map: shadowTex, color: 0x000000, transparent: true, depthWrite: false,
  }));
  const caustic = new THREE.Mesh(flatPlane, new THREE.MeshBasicMaterial({
    map: causticTex, color: new THREE.Color(tint), transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending,
  }));
  shadow.renderOrder = -0.4;
  caustic.renderOrder = -0.3;
  return { shadow, caustic };
}
