import * as THREE from 'three';

/**
 * A cloud of round dots that keep a constant size on screen at any zoom (billboards sized in pixels),
 * drawn over everything: the stepping stones of a route, or the area a team can reach this turn.
 */
export class DotCloud {
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private pos: THREE.InstancedBufferAttribute;
  private col: THREE.InstancedBufferAttribute;
  private siz: THREE.InstancedBufferAttribute;
  private uRes = { value: new THREE.Vector2(1, 1) };
  private n = 0;
  readonly capacity: number;

  constructor(capacity: number, renderOrder = 60) {
    this.capacity = capacity;
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = quad.index;
    this.geo.setAttribute('position', quad.getAttribute('position'));
    this.pos = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.col = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.siz = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    for (const a of [this.pos, this.col, this.siz]) a.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('iPos', this.pos);
    this.geo.setAttribute('iCol', this.col);
    this.geo.setAttribute('iSize', this.siz);
    this.geo.instanceCount = 0;
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      uniforms: { uRes: this.uRes },
      vertexShader: /* glsl */ `
        attribute vec3 iPos;
        attribute vec4 iCol;
        attribute float iSize;
        uniform vec2 uRes;
        varying vec4 vCol;
        varying vec2 vUv;
        void main() {
          vCol = iCol;
          vUv = position.xy * 2.0;
          vec4 clip = projectionMatrix * viewMatrix * vec4(iPos, 1.0);
          clip.xy += position.xy * iSize / uRes * 2.0 * clip.w;
          gl_Position = clip;
        }`,
      fragmentShader: /* glsl */ `
        varying vec4 vCol;
        varying vec2 vUv;
        void main() {
          float r = length(vUv);
          if (r > 1.0) discard;
          float edge = smoothstep(1.0, 0.84, r);
          vec3 c = mix(vCol.rgb, vec3(1.0), smoothstep(0.62, 0.9, r));
          gl_FragColor = vec4(c, vCol.a * edge);
        }`,
    });
    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
  }

  setResolution(w: number, h: number) {
    this.uRes.value.set(w, h);
  }

  clear() {
    this.n = 0;
    this.geo.instanceCount = 0;
  }

  /** world position in three.js axes (x east, y up, z south) */
  push(x: number, y: number, z: number, rgb: readonly [number, number, number], alpha: number, sizePx: number) {
    if (this.n >= this.capacity) return;
    const i = this.n++;
    this.pos.setXYZ(i, x, y, z);
    this.col.setXYZW(i, rgb[0], rgb[1], rgb[2], alpha);
    this.siz.setX(i, sizePx);
  }

  commit() {
    this.geo.instanceCount = this.n;
    this.pos.needsUpdate = true;
    this.col.needsUpdate = true;
    this.siz.needsUpdate = true;
  }

  dispose() {
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

export function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
