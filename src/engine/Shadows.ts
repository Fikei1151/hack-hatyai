import * as THREE from 'three';

export const SHADOW_LAYER = 1;
const SIZE = 2048;

/** GLSL: `float sunShadow(vec3 worldPos, float bias)` → 1 lit … 0 in shadow (already strength-scaled). */
export const SHADOW_GLSL = /* glsl */ `
uniform sampler2D uShadowMap;
uniform mat4 uShadowMatrix;
uniform float uShadowStrength;
uniform float uShadowTexel;
float sunShadow(vec3 wp, float bias) {
  if (uShadowStrength <= 0.001) return 1.0;
  vec4 sc = uShadowMatrix * vec4(wp, 1.0);
  vec3 c = sc.xyz / sc.w;
  if (c.x <= 0.0 || c.x >= 1.0 || c.y <= 0.0 || c.y >= 1.0 || c.z >= 1.0) return 1.0;
  float lit = 0.0;
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      float d = texture2D(uShadowMap, c.xy + vec2(float(i), float(j)) * uShadowTexel).r;
      lit += (c.z - bias) <= d ? 1.0 : 0.0;
    }
  lit /= 9.0;
  vec2 e = min(c.xy, 1.0 - c.xy);
  float fade = smoothstep(0.0, 0.06, min(e.x, e.y));
  return mix(1.0, lit, uShadowStrength * fade);
}
`;

/**
 * Sun shadows for the area around the camera target: an orthographic depth pass of buildings and
 * terrain from the sun, refreshed when the view or the sun moves. Fades out under cloud and at night.
 */
export class SunShadow {
  readonly uniforms = {
    uShadowMap: { value: null as THREE.Texture | null },
    uShadowMatrix: { value: new THREE.Matrix4() },
    uShadowStrength: { value: 0 },
    uShadowTexel: { value: 1 / SIZE },
  };
  private target: THREE.WebGLRenderTarget;
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 12000);
  private override = new THREE.MeshBasicMaterial({ colorWrite: false });
  private lastKey = '';
  private bias = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);

  constructor() {
    const depth = new THREE.DepthTexture(SIZE, SIZE, THREE.UnsignedIntType);
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;
    this.target = new THREE.WebGLRenderTarget(SIZE, SIZE, { depthBuffer: true, depthTexture: depth, generateMipmaps: false });
    this.uniforms.uShadowMap.value = depth;
    this.camera.layers.set(SHADOW_LAYER);
    this.override.side = THREE.DoubleSide;
  }

  update(renderer: THREE.WebGLRenderer, scene: THREE.Scene, sunDir: THREE.Vector3, center: THREE.Vector3, radius: number, strength: number) {
    this.uniforms.uShadowStrength.value = strength;
    if (strength <= 0.001 || sunDir.y < 0.05) {
      this.uniforms.uShadowStrength.value = 0;
      return;
    }
    // re-render only when something visible changed (snapped so small pans reuse the map)
    const snap = Math.max(10, radius / 40);
    const key = [Math.round(center.x / snap), Math.round(center.z / snap), Math.round(radius / 50), sunDir.x.toFixed(3), sunDir.y.toFixed(3), sunDir.z.toFixed(3)].join('|');
    if (key === this.lastKey) return;
    this.lastKey = key;

    const cam = this.camera;
    cam.left = -radius;
    cam.right = radius;
    cam.top = radius;
    cam.bottom = -radius;
    cam.near = 10;
    cam.far = 9000;
    cam.position.copy(center).addScaledVector(sunDir, 4000);
    cam.up.set(0, 1, 0);
    if (Math.abs(sunDir.y) > 0.99) cam.up.set(0, 0, -1);
    cam.lookAt(center);
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
    this.uniforms.uShadowMatrix.value.copy(this.bias).multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
    this.uniforms.uShadowTexel.value = 1 / SIZE;

    const prevTarget = renderer.getRenderTarget();
    const prevOverride = scene.overrideMaterial;
    const prevAuto = renderer.autoClear;
    scene.overrideMaterial = this.override;
    renderer.autoClear = true;
    renderer.setRenderTarget(this.target);
    renderer.render(scene, cam);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAuto;
    scene.overrideMaterial = prevOverride;
  }

  invalidate() {
    this.lastKey = '';
  }
}
