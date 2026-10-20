import * as THREE from 'three';
import { gridOrigin, type CityData, type CityMeta } from './cityData';
import { ATMOSPHERE, NOISE } from './glsl';
import { SHADOW_GLSL, SHADOW_LAYER } from './Shadows';

/** chunk edge (m): one draw call each, culled against the view frustum */
const CHUNK = 1200;
/**
 * Distance LOD (stochastic simplification): every tree within FULL metres of the camera is drawn;
 * further out a random subset thinning with the square of the distance (so trees per pixel stay
 * constant), its crowns grown to keep the canopy closed. Trees are stored in random order, so the
 * subset is a prefix of each chunk.
 */
const FULL = 1100;
const MIN_FRACTION = 0.01;
const MAX_GROWTH = 2.5;
/** grown crowns stop at this radius (m); beyond it the canopy just thins out */
const MAX_GROWN_RADIUS = 16;
/** grown trees stop at this height (m); they grow half as much in height as in crown width */
const MAX_GROWN_HEIGHT = 30;

interface Chunk {
  geo: THREE.InstancedBufferGeometry;
  count: number;
  min: THREE.Vector3;
  max: THREE.Vector3;
}

/**
 * Trees planted from the satellite imagery (scripts/lib/vegetation.mjs): instanced low-poly trees
 * standing on the terrain, so flood water rises around their trunks and leaves a mud line.
 */
export class Trees {
  readonly group = new THREE.Group();
  readonly uniforms: Record<string, THREE.IUniform>;
  private chunks: Chunk[] = [];

  constructor(city: CityData, staticTex: THREE.Texture, stateUniform: THREE.IUniform, atmosphere: Record<string, THREE.IUniform>, shadow: Record<string, THREE.IUniform>) {
    const { meta, terrain } = city;
    const T = city.trees;
    const lod = {
      uViewPos: { value: new THREE.Vector3() },
      uLod: { value: new THREE.Vector4(FULL, MIN_FRACTION, MAX_GROWTH, MAX_GROWN_RADIUS) },
    };
    this.uniforms = {
      ...atmosphere,
      ...shadow,
      ...lod,
      uState: stateUniform,
      uStatic: { value: staticTex },
      uDomain: { value: new THREE.Vector2(meta.width, meta.height) },
      uGridOrigin: { value: new THREE.Vector2(gridOrigin(meta).x0, gridOrigin(meta).y0) },
      uClock: { value: 0 },
      uWind: { value: new THREE.Vector2() },
    };
    if (!T?.count) return;
    const material = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG });
    // the sun's depth pass overrides materials; trees keep their own so the instancing applies there
    const casterMaterial = new THREE.ShaderMaterial({ uniforms: lod, vertexShader: CASTER_VERT, fragmentShader: CASTER_FRAG, colorWrite: false, side: THREE.DoubleSide });
    casterMaterial.allowOverride = false;
    const base = treeGeometry();

    const { x0: gx0, y0: gy0 } = gridOrigin(meta);
    const cx = Math.ceil(meta.width / CHUNK);
    const cy = Math.ceil(meta.height / CHUNK);
    const chunkOf = new Uint16Array(T.count);
    const counts = new Uint32Array(cx * cy);
    for (let t = 0; t < T.count; t++) {
      const i = THREE.MathUtils.clamp(Math.floor((T.x[t] - gx0) / CHUNK), 0, cx - 1);
      const j = THREE.MathUtils.clamp(Math.floor((T.y[t] - gy0) / CHUNK), 0, cy - 1);
      chunkOf[t] = j * cx + i;
      counts[j * cx + i]++;
    }
    const fill = new Uint32Array(cx * cy);
    const arrays = Array.from(counts, (n) => (n ? { base: new Float32Array(n * 4), shape: new Float32Array(n * 2), tint: new Uint8Array(n * 4) } : null));
    const lo = Array.from(counts, () => new THREE.Vector3(Infinity, Infinity, Infinity));
    const hi = Array.from(counts, () => new THREE.Vector3(-Infinity, -Infinity, -Infinity));
    const origin = (c: number) => new THREE.Vector3(gx0 + ((c % cx) + 0.5) * CHUNK, 0, -(gy0 + (Math.floor(c / cx) + 0.5) * CHUNK));
    const origins = Array.from(counts, (_, c) => origin(c));
    // file order is random, so filling chunks in that order keeps each chunk randomly ordered
    for (let t = 0; t < T.count; t++) {
      const c = chunkOf[t];
      const a = arrays[c]!;
      const k = fill[c]++;
      const o = origins[c];
      const ground = groundAt(meta, terrain, T.x[t], T.y[t]);
      const wx = T.x[t];
      const wz = -T.y[t];
      a.base.set([wx - o.x, ground, wz - o.z, (k + 0.5) / counts[c]], k * 4);
      a.shape[k * 2] = T.height[t];
      a.shape[k * 2 + 1] = T.radius[t];
      a.tint.set([T.color[t * 3], T.color[t * 3 + 1], T.color[t * 3 + 2], (Math.imul(t + 1, 2654435761) >>> 24) & 255], k * 4);
      // a grown clump reaches ~1.1 crown radii from the foot
      const reach = 1.1 * Math.min(T.radius[t] * MAX_GROWTH, Math.max(T.radius[t], MAX_GROWN_RADIUS));
      const top = ground + Math.min(T.height[t] * (1 + MAX_GROWTH) * 0.5, Math.max(T.height[t], MAX_GROWN_HEIGHT));
      lo[c].set(Math.min(lo[c].x, wx - reach), Math.min(lo[c].y, ground - 1), Math.min(lo[c].z, wz - reach));
      hi[c].set(Math.max(hi[c].x, wx + reach), Math.max(hi[c].y, top), Math.max(hi[c].z, wz + reach));
    }

    for (let c = 0; c < cx * cy; c++) {
      const a = arrays[c];
      if (!a) continue;
      const geo = new THREE.InstancedBufferGeometry();
      geo.setIndex(base.index);
      geo.setAttribute('position', base.getAttribute('position'));
      geo.setAttribute('aPart', base.getAttribute('aPart'));
      geo.setAttribute('aBase', new THREE.InstancedBufferAttribute(a.base, 4));
      geo.setAttribute('aShape', new THREE.InstancedBufferAttribute(a.shape, 2));
      geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(a.tint, 4, true));
      geo.instanceCount = counts[c];
      const box = new THREE.Box3(lo[c].clone().sub(origins[c]), hi[c].clone().sub(origins[c]));
      geo.boundingBox = box;
      geo.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
      const mesh = new THREE.Mesh(geo, material);
      const caster = new THREE.Mesh(geo, casterMaterial);
      caster.layers.set(SHADOW_LAYER);
      for (const m of [mesh, caster]) {
        m.position.copy(origins[c]);
        m.updateMatrix();
        m.matrixAutoUpdate = false;
      }
      this.group.add(mesh, caster);
      this.chunks.push({ geo, count: counts[c], min: lo[c], max: hi[c] });
    }
  }

  /** Per frame: thin each chunk by its distance from the camera; wind sway. */
  update(camera: THREE.Camera, clock: number, windDirDeg: number, windKmh: number) {
    const p = camera.position;
    this.uniforms.uViewPos.value.copy(p);
    this.uniforms.uClock.value = clock;
    // world: x east, z south; wind FROM windDir pushes toward -dir
    const rad = (windDirDeg * Math.PI) / 180;
    const w = Math.min(1, windKmh / 60);
    this.uniforms.uWind.value.set(-Math.sin(rad) * w, Math.cos(rad) * w);
    for (const c of this.chunks) {
      const dx = Math.max(c.min.x - p.x, 0, p.x - c.max.x);
      const dy = Math.max(c.min.y - p.y, 0, p.y - c.max.y);
      const dz = Math.max(c.min.z - p.z, 0, p.z - c.max.z);
      const frac = THREE.MathUtils.clamp((FULL * FULL) / Math.max(dx * dx + dy * dy + dz * dz, 1), MIN_FRACTION, 1);
      c.geo.instanceCount = Math.min(c.count, Math.ceil(c.count * frac));
    }
  }
}

/** Terrain height under a point, interpolated the way the terrain mesh triangulates its grid. */
function groundAt(meta: CityMeta, z: Float32Array, x: number, y: number) {
  const n = meta.nx;
  const { x0, y0 } = gridOrigin(meta);
  const fi = Math.min(Math.max((x - x0) / meta.cell - 0.5, 0), n - 1.001);
  const fj = Math.min(Math.max((y - y0) / meta.cell - 0.5, 0), meta.ny - 1.001);
  const i = Math.floor(fi);
  const j = Math.floor(fj);
  const u = fi - i;
  const v = fj - j;
  const a = z[j * n + i];
  const b = z[j * n + i + 1];
  const c = z[(j + 1) * n + i];
  const d = z[(j + 1) * n + i + 1];
  return u + v <= 1 ? a + (b - a) * u + (c - a) * v : d + (c - d) * (1 - u) + (b - d) * (1 - v);
}

/**
 * One instance = three icosahedron crown blobs over three five-sided trunks, in unit form
 * (aPart = blob, 0 trunk / 1 crown); the vertex shader sizes and arranges them per tree.
 */
function treeGeometry() {
  const t = (1 + Math.sqrt(5)) / 2;
  const ico = [-1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, 0, 0, -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, t, 0, -1, t, 0, 1, -t, 0, -1, -t, 0, 1];
  const faces = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];
  const v = (k: number) => new THREE.Vector3(ico[k * 3], ico[k * 3 + 1], ico[k * 3 + 2]).normalize();
  const pos: number[] = [];
  const part: number[] = [];
  const idx: number[] = [];
  for (let b = 0; b < 3; b++) {
    const v0 = pos.length / 3;
    for (let k = 0; k < 12; k++) {
      const p = v(k);
      pos.push(p.x, p.y, p.z);
      part.push(b, 1);
    }
    for (let f = 0; f < faces.length; f += 3) {
      const [a, c, d] = [v(faces[f]), v(faces[f + 1]), v(faces[f + 2])];
      // outward (counter-clockwise seen from outside)
      const out = new THREE.Vector3().subVectors(c, a).cross(new THREE.Vector3().subVectors(d, a)).dot(a) > 0;
      idx.push(v0 + faces[f], v0 + faces[out ? f + 1 : f + 2], v0 + faces[out ? f + 2 : f + 1]);
    }
  }
  const SIDES = 5;
  for (let b = 0; b < 3; b++) {
    const v0 = pos.length / 3;
    for (let s = 0; s < SIDES; s++) {
      const a = (s / SIDES) * Math.PI * 2;
      pos.push(Math.cos(a), 0, Math.sin(a), Math.cos(a), 1, Math.sin(a));
      part.push(b, 0, b, 0);
    }
    for (let s = 0; s < SIDES; s++) {
      const a0 = v0 + s * 2;
      const a1 = v0 + ((s + 1) % SIDES) * 2;
      idx.push(a0, a0 + 1, a1, a1, a0 + 1, a1 + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 2));
  geo.setIndex(idx);
  return geo;
}

/** Shared by the visible and the shadow-casting pass, so shadows match the trees drawn. */
const TREE_GLSL = /* glsl */ `
attribute vec2 aPart;   // blob 0…2, 0 trunk / 1 crown
attribute vec4 aBase;   // tree foot relative to the chunk (m), LOD rank 0…1
attribute vec2 aShape;  // height, crown radius (m)
attribute vec4 aTint;   // crown colour (sRGB), per-tree random
uniform vec3 uViewPos;
uniform vec4 uLod;      // full-density distance, minimum fraction, maximum growth, largest grown radius

struct Blob { vec3 c; float r; float rv; };

// Small trees huddle the three blobs into one lumpy crown with side branches; large ones (far away,
// or thinned canopy standing in for several real trees) spread them into a clump of three trees.
Blob treeBlob(int b, float H, float R, float rnd, float spread) {
  float k = float(b);
  float ang = rnd * 6.2832 + k * mix(2.3, 2.094, spread);
  float off = b == 0 ? 0.48 * spread : mix(0.42, 0.48, spread);
  float r = R * (b == 0 ? mix(0.8, 0.6, spread) : mix(0.64 - 0.04 * k, 0.6 - 0.03 * k, spread));
  float top = H * (b == 0 ? 1.0 : mix(0.92 - 0.06 * k, 0.95 - 0.05 * k, spread));
  float rv = min(r * mix(0.85, 0.9, spread), top * mix(0.38, 0.42, spread));
  return Blob(vec3(cos(ang) * off * R, top - rv, sin(ang) * off * R), r, rv);
}

// Vertex of this tree in the chunk's frame; false when the distance LOD leaves the tree out.
bool treeVertex(out vec3 pos, out vec3 nrm, out float crown) {
  vec3 foot = (modelMatrix * vec4(aBase.xyz, 1.0)).xyz;
  vec3 dv = foot - uViewPos;
  float frac = clamp(uLod.x * uLod.x / max(dot(dv, dv), 1.0), uLod.y, 1.0);
  float show = 1.0 - smoothstep(frac * 0.75, frac, aBase.w);
  if (show <= 0.0) return false;
  float grow = min(inversesqrt(frac), uLod.z);
  float H = min(aShape.x * mix(1.0, grow, 0.5), max(aShape.x, ${MAX_GROWN_HEIGHT.toFixed(1)})) * show;
  float R = min(aShape.y * grow, max(aShape.y, uLod.w)) * show;
  float spread = smoothstep(5.0, 10.0, R);
  int b = int(aPart.x + 0.5);
  Blob bl = treeBlob(b, H, R, aTint.a, spread);
  crown = aPart.y;
  if (crown > 0.5) {
    // turn each blob so the facets of neighbouring trees never line up
    float a = aTint.a * 40.0 + float(b) * 1.7;
    float ca = cos(a);
    float sa = sin(a);
    vec3 p = vec3(position.x * ca - position.z * sa, position.y, position.x * sa + position.z * ca);
    nrm = normalize(vec3(p.x / bl.r, p.y / bl.rv, p.z / bl.r));
    pos = bl.c + p * vec3(bl.r, bl.rv, bl.r);
  } else {
    // trunks stand in the ground; on a single tree the side ones branch off the main trunk
    vec3 bottom = b == 0 ? vec3(bl.c.x, -0.6, bl.c.z) : vec3(bl.c.x * spread, mix(bl.c.y * 0.4, -0.6, spread), bl.c.z * spread);
    float rt = (0.022 * H + 0.08) * (b == 0 ? 1.0 : mix(0.6, 0.9, spread)) * (1.0 - 0.4 * position.y);
    pos = mix(bottom, bl.c, position.y) + vec3(position.x, 0.0, position.z) * rt;
    nrm = vec3(position.x, 0.0, position.z);
  }
  pos += aBase.xyz;
  return true;
}
`;

const VERT = /* glsl */ `
${TREE_GLSL}
uniform sampler2D uState;
uniform sampler2D uStatic;
uniform vec2 uDomain;
uniform vec2 uGridOrigin;
uniform float uClock;
uniform vec2 uWind;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vAlbedo;
varying float vCrown;
varying float vAo;
varying float vMudLine;
varying float vSeed;

void main() {
  vec3 pos;
  vec3 nrm;
  float crown;
  if (!treeVertex(pos, nrm, crown)) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0); // beyond the far plane: the whole tree is clipped
    return;
  }
  vec4 w = modelMatrix * vec4(pos, 1.0);
  // crowns sway in the wind, the tops most, harder in a storm
  float hgt = max(pos.y - aBase.y, 0.0);
  float gust = 0.5 + 0.5 * sin(uClock * 1.7 + aTint.a * 40.0 + w.x * 0.05);
  w.xz += uWind * (0.15 + gust) * 0.027 * hgt * hgt / max(aShape.x, 3.0);
  vWorld = w.xyz;
  vNormal = nrm;
  vCrown = crown;
  vSeed = aTint.a;
  // the underside of the crown and the trunks sit in the canopy's own shade
  vAo = crown > 0.5 ? mix(0.42, 1.0, smoothstep(-0.9, 0.7, nrm.y)) : 0.5;
  // the imagery's canopy colour has the crowns' shading baked in: keep its hue (dark rubber
  // plantations stay darker than garden trees) but lift it into the range of real leaf albedo
  vec3 tint = pow(aTint.rgb, vec3(2.2));
  float lum = dot(tint, vec3(0.2126, 0.7152, 0.0722));
  vec3 leaf = tint * clamp(lum * 1.5, 0.04, 0.1) * (0.82 + 0.36 * fract(aTint.a * 7.3)) / max(lum, 1e-4);
  // some trees yellower, some bluer
  float hue = fract(aTint.a * 13.7) - 0.5;
  leaf *= vec3(1.0 + 0.3 * hue, 1.0, 1.0 - 0.4 * hue);
  vAlbedo = crown > 0.5 ? leaf : vec3(0.075, 0.062, 0.05);
  // highest water level so far at this tree's cell
  vec2 foot = (modelMatrix * vec4(aBase.xyz, 1.0)).xz;
  vec2 uv = (vec2(foot.x, -foot.y) - uGridOrigin) / uDomain;
  float maxDepth = texture2D(uState, uv).g;
  vMudLine = maxDepth > 0.03 ? texture2D(uStatic, uv).r + maxDepth : -1e4;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const FRAG = /* glsl */ `
${ATMOSPHERE}
${NOISE}
${SHADOW_GLSL}
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vAlbedo;
varying float vCrown;
varying float vAo;
varying float vMudLine;
varying float vSeed;

void main() {
  vec3 n = normalize(vNormal);
  vec3 albedo = vAlbedo;
  float leafy = step(0.5, vCrown);
  if (leafy > 0.5) {
    // clumps of leaves: break the smooth blob up with noise in colour and normal
    vec3 q = vWorld * 0.7 + vSeed * 31.0;
    float a = vnoise3(q);
    float b = vnoise3(q * 2.1 + 5.3);
    albedo *= 0.72 + 0.56 * (a * 0.65 + b * 0.35);
    n = normalize(n + (vec3(a, b, vnoise3(q + 9.1)) - 0.5) * 0.9);
  }
  // mud line left by the highest flood so far
  albedo = mix(albedo, vec3(0.13, 0.1, 0.07), step(vWorld.y, vMudLine) * 0.7);
  albedo *= 1.0 - 0.15 * smoothstep(0.5, 8.0, uRainNow); // wet leaves and bark

  float ndl = dot(n, uSunDir);
  // foliage scatters light: wrapped diffuse, and leaves glow when the sun is behind them
  float diff = leafy > 0.5 ? max(0.0, (ndl + 0.4) / 1.4) : max(ndl, 0.0);
  float sh = sunShadow(vWorld + n * 0.8, 0.0012);
  vec3 V = normalize(cameraPosition - vWorld);
  float back = pow(max(dot(-V, uSunDir), 0.0), 5.0) * 0.35 * leafy;
  // skylight scattered through the leaves reaches into the crown's shade
  vec3 amb = ambientLight(n) * mix(vAo, 1.0, 0.25 * leafy) * (1.0 + 0.3 * leafy);
  vec3 col = albedo * (amb + uSunColor * (diff * mix(1.0, vAo, 0.5) + back) * sh);
  col = applyFog(col, length(vWorld - cameraPosition), cameraPosition.y - vWorld.y);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const CASTER_VERT = /* glsl */ `
${TREE_GLSL}
void main() {
  vec3 pos;
  vec3 nrm;
  float crown;
  if (!treeVertex(pos, nrm, crown)) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(pos, 1.0);
}
`;

const CASTER_FRAG = /* glsl */ `
void main() {
  gl_FragColor = vec4(1.0);
}
`;
