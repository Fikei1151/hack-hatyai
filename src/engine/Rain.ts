import * as THREE from 'three';

const MAX_DROPS = 42000;

/** Camera-anchored rain streaks; density follows the simulated rain rate at the camera. */
export class Rain {
  readonly mesh: THREE.Mesh;
  readonly uniforms = {
    uTime: { value: 0 },
    uCamPos: { value: new THREE.Vector3() },
    uBox: { value: new THREE.Vector3(70, 46, 70) },
    uFall: { value: new THREE.Vector3(0, -9, 0) },
    uDensity: { value: 0 },
    uLength: { value: 0.9 },
    uWidth: { value: 0.012 },
    uBright: { value: 1 },
  };

  constructor() {
    const quad = new THREE.InstancedBufferGeometry();
    quad.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0]), 3));
    quad.setIndex([0, 1, 2, 0, 2, 3]);
    const off = new Float32Array(MAX_DROPS * 3);
    const rnd = new Float32Array(MAX_DROPS);
    for (let i = 0; i < MAX_DROPS; i++) {
      off[i * 3] = Math.random();
      off[i * 3 + 1] = Math.random();
      off[i * 3 + 2] = Math.random();
      rnd[i] = Math.random();
    }
    quad.setAttribute('aOffset', new THREE.InstancedBufferAttribute(off, 3));
    quad.setAttribute('aRand', new THREE.InstancedBufferAttribute(rnd, 1));
    quad.instanceCount = MAX_DROPS;

    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        uniform float uTime; uniform vec3 uCamPos; uniform vec3 uBox; uniform vec3 uFall;
        uniform float uDensity; uniform float uLength; uniform float uWidth;
        attribute vec3 aOffset; attribute float aRand;
        varying float vAlong; varying float vFade;
        void main() {
          if (aRand > uDensity) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          vec3 fall = uFall * (0.85 + 0.3 * aRand);
          vec3 p = aOffset * uBox + fall * uTime;
          vec3 origin = uCamPos - uBox * 0.5;
          p = origin + mod(p - origin, uBox);
          vec3 dir = normalize(fall);
          vec3 toCam = normalize(uCamPos - p);
          vec3 side = normalize(cross(dir, toCam));
          float dist = length(uCamPos - p);
          float w = uWidth * (1.0 + dist * 0.04);
          vec3 world = p + side * position.x * w * 2.0 - dir * uLength * position.y * (0.7 + 0.6 * aRand);
          vAlong = position.y;
          vFade = smoothstep(1.0, 4.0, dist) * (1.0 - smoothstep(18.0, 34.0, dist));
          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uBright;
        varying float vAlong; varying float vFade;
        void main() {
          float a = (1.0 - vAlong) * vAlong * 4.0 * vFade * 0.32;
          gl_FragColor = vec4(vec3(0.78, 0.82, 0.88) * uBright, a);
        }`,
    });
    this.mesh = new THREE.Mesh(quad, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
  }

  update(camera: THREE.Camera, rainMmHr: number, windDirDeg: number, windKmh: number, realTime: number, flash: number, daylight: number) {
    const u = this.uniforms;
    u.uTime.value = realTime;
    u.uCamPos.value.copy(camera.position);
    // drop density saturates around 80 mm/hr; light drizzle is sparse
    u.uDensity.value = rainMmHr <= 0.05 ? 0 : Math.min(1, 0.04 + Math.sqrt(rainMmHr / 80));
    const rad = (windDirDeg * Math.PI) / 180;
    const wind = Math.min(12, windKmh / 3.6) * 0.7;
    // world: x east, z south; wind FROM dir pushes drops toward -dir
    u.uFall.value.set(-Math.sin(rad) * wind, -9 - rainMmHr * 0.02, Math.cos(rad) * wind);
    u.uBright.value = (0.35 + 0.65 * daylight) * (1 + flash * 3);
    this.mesh.visible = u.uDensity.value > 0;
  }
}
