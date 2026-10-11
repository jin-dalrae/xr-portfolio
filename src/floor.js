import * as THREE from 'three';

// A shallow glass tray: a bowl-shaped floor so the pile gathers in front of you.
export const FLOOR_Y = -2.7;
const BOWL_X = 0.03, BOWL_Z = 0.05, BOWL_ZC = -1;

export const floorHeight = (x, z) => FLOOR_Y + BOWL_X * x * x + BOWL_Z * (z - BOWL_ZC) ** 2;
export const floorNormal = (x, z, out) => out.set(-2 * BOWL_X * x, 1, -2 * BOWL_Z * (z - BOWL_ZC)).normalize();

export function makeFloor() {
  const geo = new THREE.PlaneGeometry(36, 24, 96, 64);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, 0, -2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, floorHeight(pos.getX(i), pos.getZ(i)));

  const mat = new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 1 } },
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec3 vW;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uOpacity;
      varying vec3 vW;
      void main() {
        vec2 g = abs(fract(vW.xz * 1.0) - 0.5) / fwidth(vW.xz);
        float line = 1.0 - min(min(g.x, g.y), 1.0);
        float fade = smoothstep(-9.0, -3.0, vW.z) * smoothstep(3.4, 1.2, vW.z)
                   * (1.0 - smoothstep(4.0, 9.0, abs(vW.x)));
        float a = (0.05 + line * 0.16) * fade * uOpacity;
        gl_FragColor = vec4(vec3(0.85, 0.92, 1.0), a);
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -0.5;
  return mesh;
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
