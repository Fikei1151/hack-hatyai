import * as THREE from 'three';
import { sampleGrid, type CityData } from './cityData';
import { ATMOSPHERE, DEPTH_RAMP_GLSL, NOISE } from './glsl';
import { SHADOW_GLSL, SHADOW_LAYER } from './Shadows';

// Wall / roof palettes per building type (sRGB bytes). Hat Yai: pastel concrete shophouses with
// grey slab roofs, terracotta / metal-sheet pitched roofs on houses, orange tiered roofs on temples.
const WALLS: number[][][] = [
  [[234, 230, 218], [228, 214, 188], [214, 222, 226], [238, 222, 212], [206, 212, 196], [242, 238, 228], [222, 206, 190]], // generic
  [[240, 236, 224], [232, 218, 194], [222, 228, 216], [216, 200, 180], [236, 226, 210]], // house
  [[234, 226, 208], [224, 206, 176], [204, 218, 224], [238, 214, 204], [214, 224, 202], [228, 228, 232], [240, 224, 180]], // shophouse
  [[214, 222, 230], [238, 238, 238], [196, 208, 216], [226, 218, 206]], // commercial
  [[208, 210, 208], [216, 216, 210], [196, 204, 208]], // industrial
  [[246, 242, 234], [240, 230, 206]], // religious
  [[238, 224, 186], [234, 232, 222]], // education
  [[242, 244, 242], [232, 238, 240]], // hospital
  [[232, 228, 216], [224, 224, 226]], // civic
  [[178, 180, 178], [162, 166, 170], [192, 188, 178]], // shed
];
const FLAT_ROOFS: number[][] = [
  [152, 152, 150],
  [132, 134, 136],
  [170, 166, 158],
  [120, 124, 130],
  [184, 180, 172],
];
const PITCHED_ROOFS: number[][] = [
  [184, 82, 52], // terracotta
  [160, 70, 50],
  [196, 112, 70],
  [118, 82, 64], // brown tile
  [96, 112, 130], // blue metal sheet
  [150, 156, 160], // zinc
  [70, 98, 92], // green
];
const TEMPLE_ROOFS: number[][] = [
  [214, 108, 36],
  [196, 70, 40],
  [210, 140, 50],
];

const CHUNKS = 6;

function hash(n: number) {
  let h = (n * 2654435761) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519) >>> 0;
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

type TypedCtor = Float32ArrayConstructor | Int8ArrayConstructor | Uint8ArrayConstructor | Uint32ArrayConstructor;

/** Append-only typed array (90k buildings would be ~0.5 GB as plain JS number arrays). */
class Grow<T extends Float32Array | Int8Array | Uint8Array | Uint32Array> {
  data: T;
  length = 0;
  constructor(private ctor: TypedCtor, cap = 4096) {
    this.data = new ctor(cap) as T;
  }
  push(...v: number[]) {
    if (this.length + v.length > this.data.length) {
      const next = new this.ctor(Math.max(this.data.length * 2, this.length + v.length)) as T;
      next.set(this.data as never);
      this.data = next;
    }
    for (let i = 0; i < v.length; i++) this.data[this.length++] = v[i];
  }
  view(): T {
    return this.data.subarray(0, this.length) as T;
  }
}

interface Chunk {
  pos: Grow<Float32Array>;
  nor: Grow<Int8Array>;
  col: Grow<Uint8Array>;
  wall: Grow<Float32Array>;
  info: Grow<Float32Array>;
  cell: Grow<Float32Array>;
  idx: Grow<Uint32Array>;
}

export class Buildings {
  readonly group = new THREE.Group();
  readonly material: THREE.ShaderMaterial;
  readonly uniforms: Record<string, THREE.IUniform>;
  /** centroid cell index per building, for impact statistics */
  readonly centroidCell: Int32Array;

  constructor(city: CityData, staticTex: THREE.Texture, stateUniform: THREE.IUniform, atmosphere: Record<string, THREE.IUniform>, shadow: Record<string, THREE.IUniform>) {
    const { meta, buildings: B, terrain } = city;
    this.uniforms = {
      ...atmosphere,
      ...shadow,
      uState: stateUniform,
      uStatic: { value: staticTex },
      uMode: { value: 0 },
      uHighlight: { value: 1 },
      uImpactThreshold: { value: 0.3 },
    };
    this.material = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG });

    this.centroidCell = new Int32Array(B.count);
    const W = meta.width;
    const H = meta.height;
    const chunks: Chunk[] = Array.from({ length: CHUNKS * CHUNKS }, () => ({
      pos: new Grow<Float32Array>(Float32Array),
      nor: new Grow<Int8Array>(Int8Array),
      col: new Grow<Uint8Array>(Uint8Array),
      wall: new Grow<Float32Array>(Float32Array),
      info: new Grow<Float32Array>(Float32Array),
      cell: new Grow<Float32Array>(Float32Array),
      idx: new Grow<Uint32Array>(Uint32Array),
    }));
    const contour: THREE.Vector2[] = [];

    for (let b = 0; b < B.count; b++) {
      const n = B.vertCounts[b];
      const o = B.offsets[b] * 2;
      const px = (k: number) => B.coords[o + k * 2];
      const py = (k: number) => B.coords[o + k * 2 + 1];
      let cx = 0;
      let cy = 0;
      let minZ = Infinity;
      for (let k = 0; k < n; k++) {
        cx += px(k);
        cy += py(k);
        minZ = Math.min(minZ, sampleGrid(meta, terrain, px(k), py(k)));
      }
      cx /= n;
      cy /= n;
      const cu = (cx + W / 2) / W;
      const cv = (cy + H / 2) / H;
      const ci = Math.min(meta.nx - 1, Math.max(0, Math.floor(cu * meta.nx)));
      const cj = Math.min(meta.ny - 1, Math.max(0, Math.floor(cv * meta.ny)));
      this.centroidCell[b] = cj * meta.nx + ci;
      const ch = chunks[Math.min(CHUNKS - 1, Math.floor(cu * CHUNKS)) + CHUNKS * Math.min(CHUNKS - 1, Math.floor(cv * CHUNKS))];

      const type = B.types[b];
      const r = hash(b + 1);
      const wallPal = WALLS[type] ?? WALLS[0];
      const wc = wallPal[Math.floor(r * wallPal.length)];
      const shade = 0.9 + 0.2 * hash(b * 5 + 1);
      const h = B.heights[b];
      const y0 = minZ - 0.4;
      const y1 = minZ + h;
      const total = y1 - y0;
      // window style: 0 none, 1 sparse (industrial), 2 punched windows, 3 ribbon windows (offices/malls)
      const style = type === 9 || h < 4.2 ? 0 : type === 4 ? 1 : type === 3 || type === 7 ? 3 : 2;
      const seed = hash(b * 13 + 5);

      const pushV = (x: number, y: number, yy: number, nx: number, ny: number, nz: number, c: number[], wu: number, wy: number) => {
        ch.pos.push(x, y, -yy);
        ch.nor.push(Math.round(nx * 127), Math.round(ny * 127), Math.round(nz * 127));
        ch.col.push(Math.min(255, c[0]), Math.min(255, c[1]), Math.min(255, c[2]), style);
        ch.wall.push(wu, wy);
        ch.info.push(total, seed);
        ch.cell.push(cu, cv);
        return ch.pos.length / 3 - 1;
      };
      const wallCol = [wc[0] * shade, wc[1] * shade, wc[2] * shade];

      // walls
      let u = 0;
      for (let k = 0; k < n; k++) {
        const k2 = (k + 1) % n;
        const ax = px(k);
        const ay = py(k);
        const bx = px(k2);
        const by = py(k2);
        const len = Math.hypot(bx - ax, by - ay) || 1e-3;
        const nx = (by - ay) / len;
        const nz = (bx - ax) / len;
        const v0 = pushV(ax, y0, ay, nx, 0, nz, wallCol, u, 0);
        pushV(bx, y0, by, nx, 0, nz, wallCol, u + len, 0);
        pushV(bx, y1, by, nx, 0, nz, wallCol, u + len, total);
        pushV(ax, y1, ay, nx, 0, nz, wallCol, u, total);
        ch.idx.push(v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3);
        u += len;
      }

      // roof: pitched on small rectangular low-rise buildings, flat slab otherwise
      const rect = n === 4 ? rectangle(px, py) : null;
      const pitchedChance = type === 1 ? 0.92 : type === 5 ? 0.95 : type === 6 ? 0.7 : type === 9 ? 0.5 : type === 0 ? 0.55 : type === 2 ? 0.15 : 0;
      if (rect && h <= (type === 5 ? 18 : 9.5) && rect.W >= 3 && rect.W <= 24 && hash(b * 7 + 11) < pitchedChance) {
        const temple = type === 5;
        const pal = temple ? TEMPLE_ROOFS : PITCHED_ROOFS;
        const rc = pal[Math.floor(hash(b * 3 + 7) * pal.length)];
        const rise = rect.W * (temple ? 0.55 : 0.28 + 0.1 * hash(b * 17));
        const gable = !temple && hash(b * 19 + 3) < 0.35;
        const half = gable ? rect.L / 2 : Math.max(0, (rect.L - rect.W) / 2);
        const yr = y1 + rise;
        const r0: [number, number] = [rect.cx - rect.ax * half, rect.cy - rect.ay * half];
        const r1: [number, number] = [rect.cx + rect.ax * half, rect.cy + rect.ay * half];
        // each footprint corner belongs to the ridge end on its side of the long axis
        const ridgeOf = (k: number): [number, number] => ((px(k) - rect.cx) * rect.ax + (py(k) - rect.cy) * rect.ay < 0 ? r0 : r1);
        for (let k = 0; k < 4; k++) {
          const k2 = (k + 1) % 4;
          const A: [number, number, number] = [px(k), y1, py(k)];
          const Bp: [number, number, number] = [px(k2), y1, py(k2)];
          const ra = ridgeOf(k);
          const rb = ridgeOf(k2);
          const RA: [number, number, number] = [ra[0], yr, ra[1]];
          const RB: [number, number, number] = [rb[0], yr, rb[1]];
          if (ra === rb) {
            // short side: hip triangle, or a vertical gable wall in the wall colour
            const nrm = faceNormal(A, Bp, RA);
            const c = gable ? wallCol : rc;
            const tag = gable ? -2 : -1;
            const v0 = pushV(A[0], A[1], A[2], nrm[0], nrm[1], nrm[2], c, tag, total);
            pushV(Bp[0], Bp[1], Bp[2], nrm[0], nrm[1], nrm[2], c, tag, total);
            pushV(RA[0], RA[1], RA[2], nrm[0], nrm[1], nrm[2], c, tag, total + rise);
            ch.idx.push(v0, v0 + 1, v0 + 2);
          } else {
            const nrm = faceNormal(A, Bp, RB);
            const v0 = pushV(A[0], A[1], A[2], nrm[0], nrm[1], nrm[2], rc, -1, total);
            pushV(Bp[0], Bp[1], Bp[2], nrm[0], nrm[1], nrm[2], rc, -1, total);
            pushV(RB[0], RB[1], RB[2], nrm[0], nrm[1], nrm[2], rc, -1, total + rise);
            pushV(RA[0], RA[1], RA[2], nrm[0], nrm[1], nrm[2], rc, -1, total + rise);
            ch.idx.push(v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3);
          }
        }
      } else {
        const rc = FLAT_ROOFS[Math.floor(hash(b * 3 + 7) * FLAT_ROOFS.length)];
        contour.length = 0;
        for (let k = 0; k < n; k++) contour.push(new THREE.Vector2(px(k), py(k)));
        let tris: number[] = [];
        try {
          tris = THREE.ShapeUtils.triangulateShape(contour, []).flat();
        } catch {
          tris = [];
        }
        const r0 = ch.pos.length / 3;
        for (let k = 0; k < n; k++) pushV(px(k), y1, py(k), 0, 1, 0, rc, -1, total);
        for (let t = 0; t < tris.length; t += 3) {
          const [i0, i1, i2] = [tris[t], tris[t + 1], tris[t + 2]];
          const cross = (px(i1) - px(i0)) * (py(i2) - py(i0)) - (py(i1) - py(i0)) * (px(i2) - px(i0));
          ch.idx.push(r0 + i0, r0 + (cross >= 0 ? i1 : i2), r0 + (cross >= 0 ? i2 : i1));
        }
      }
    }

    for (const ch of chunks) {
      if (!ch.idx.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(ch.pos.view(), 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(ch.nor.view(), 3, true));
      geo.setAttribute('aColor', new THREE.BufferAttribute(ch.col.view(), 4, true));
      geo.setAttribute('aWall', new THREE.BufferAttribute(ch.wall.view(), 2));
      geo.setAttribute('aInfo', new THREE.BufferAttribute(ch.info.view(), 2));
      geo.setAttribute('aCell', new THREE.BufferAttribute(ch.cell.view(), 2));
      geo.setIndex(new THREE.BufferAttribute(ch.idx.view(), 1));
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, this.material);
      mesh.layers.enable(SHADOW_LAYER);
      this.group.add(mesh);
    }
  }
}

/** Oriented rectangle of a 4-corner footprint, or null if it is not close to rectangular. */
function rectangle(px: (k: number) => number, py: (k: number) => number) {
  const e = [0, 1, 2, 3].map((k) => [px((k + 1) % 4) - px(k), py((k + 1) % 4) - py(k)]);
  const len = e.map(([x, y]) => Math.hypot(x, y));
  for (let k = 0; k < 4; k++) {
    const a = e[k];
    const b = e[(k + 1) % 4];
    const cos = Math.abs(a[0] * b[0] + a[1] * b[1]) / (len[k] * len[(k + 1) % 4] || 1);
    if (cos > 0.18) return null; // corners must be within ~10° of square
  }
  const longFirst = len[0] + len[2] >= len[1] + len[3];
  const L = longFirst ? (len[0] + len[2]) / 2 : (len[1] + len[3]) / 2;
  const Wd = longFirst ? (len[1] + len[3]) / 2 : (len[0] + len[2]) / 2;
  const ax0 = longFirst ? e[0] : e[1];
  const al = Math.hypot(ax0[0], ax0[1]) || 1;
  return {
    L,
    W: Wd,
    ax: ax0[0] / al,
    ay: ax0[1] / al,
    cx: (px(0) + px(1) + px(2) + px(3)) / 4,
    cy: (py(0) + py(1) + py(2) + py(3)) / 4,
  };
}

/** Upward-facing normal (world space: x east, y up, z south) of a roof face given in (x, y, north). */
function faceNormal(a: [number, number, number], b: [number, number, number], c: [number, number, number]) {
  const A = new THREE.Vector3(a[0], a[1], -a[2]);
  const Bv = new THREE.Vector3(b[0], b[1], -b[2]);
  const C = new THREE.Vector3(c[0], c[1], -c[2]);
  const nrm = new THREE.Vector3().subVectors(Bv, A).cross(new THREE.Vector3().subVectors(C, A)).normalize();
  if (nrm.y < 0) nrm.negate();
  return [nrm.x, nrm.y, nrm.z];
}

const VERT = /* glsl */ `
attribute vec4 aColor;
attribute vec2 aWall;
attribute vec2 aInfo;
attribute vec2 aCell;
uniform sampler2D uState;
uniform sampler2D uStatic;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec4 vColor;
varying vec2 vWall;
varying vec2 vInfo;
varying float vDepth;
varying float vMaxDepth;
varying float vMudLine;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(normal.xyz);
  vColor = aColor;
  vWall = aWall;
  vInfo = aInfo;
  vec4 st = texture2D(uState, aCell);
  float zc = texture2D(uStatic, aCell).r;
  vDepth = st.r;
  vMaxDepth = st.g;
  // highest water mark measured from this building's base
  vMudLine = zc + st.g - (w.y - aWall.y);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const FRAG = /* glsl */ `
uniform int uMode;
uniform float uHighlight;
uniform float uImpactThreshold;
${ATMOSPHERE}
${NOISE}
${SHADOW_GLSL}
${DEPTH_RAMP_GLSL}
varying vec3 vWorld;
varying vec3 vNormal;
varying vec4 vColor;
varying vec2 vWall;
varying vec2 vInfo;
varying float vDepth;
varying float vMaxDepth;
varying float vMudLine;

vec3 srgb(vec3 c) { return c * c; }

void main() {
  vec3 n = normalize(vNormal);
  // painted concrete reads around 0.5 albedo; the palette bytes are perceptual, so scale down
  vec3 albedo = srgb(vColor.rgb) * 0.72;
  float style = floor(vColor.a * 255.0 + 0.5);
  bool roof = vWall.x < -0.5 && vWall.x > -1.5;
  bool gableWall = vWall.x < -1.5;
  float y = vWall.y;
  vec3 emissive = vec3(0.0);
  float gloss = 0.0;

  if (!roof) {
    float fl = floor(y / 3.4);
    float fy = fract(y / 3.4);
    if (!gableWall && style > 0.5) {
      float colW = style > 2.5 ? 2.2 : 3.6;
      float fx = fract(vWall.x / colW);
      float col = floor(vWall.x / colW);
      float win;
      if (style > 2.5) {
        // ribbon glazing on offices, hotels, hospitals and malls
        win = step(0.22, fy) * step(fy, 0.86) * step(0.04, fx) * step(fx, 0.96);
      } else if (style > 1.5) {
        win = step(0.3, fy) * step(fy, 0.8) * step(0.2, fx) * step(fx, 0.8);
      } else {
        win = step(0.55, fy) * step(fy, 0.8) * step(0.1, fx) * step(fx, 0.6) * step(0.5, fract(col * 0.5));
      }
      win *= step(3.2, y) * step(y, vInfo.x - 0.8);
      float rnd = hash12(vec2(col + vInfo.y * 97.0, fl + vInfo.y * 31.0));
      vec3 glass = mix(vec3(0.03, 0.045, 0.06), vec3(0.13, 0.17, 0.21), rnd);
      float edge = min(min(fx - 0.2, 0.8 - fx), min(fy - 0.3, 0.8 - fy));
      float frame = win * (1.0 - smoothstep(0.02, 0.05, edge)) * step(style, 2.5);
      albedo = mix(albedo, glass, win * 0.92);
      albedo = mix(albedo, vec3(0.85), frame * 0.5);
      gloss = win * 0.8;
      emissive = vec3(1.0, 0.72, 0.42) * step(0.58, rnd) * win * (1.0 - uDaylight) * 0.85;
      // floor slabs
      albedo *= 1.0 - 0.12 * (1.0 - smoothstep(0.0, 0.05, fy)) * step(3.2, y);
      // shop fronts at street level: roll-up shutters or lit glass
      if (y < 3.0 && style > 1.5) {
        float bay = floor(vWall.x / 4.0);
        float shutter = 0.85 + 0.15 * step(0.5, fract(vWall.x * 3.0));
        float open = step(0.5, hash12(vec2(bay, vInfo.y * 50.0)));
        vec3 front = mix(vec3(0.42, 0.44, 0.46) * shutter, vec3(0.06, 0.08, 0.1), open);
        float band = step(0.25, y) * step(y, 2.7);
        albedo = mix(albedo, front, band);
        emissive += vec3(1.0, 0.8, 0.55) * 0.55 * (1.0 - uDaylight) * open * band;
      }
    }
    // ground-contact occlusion and weathering
    albedo *= mix(0.66, 1.0, smoothstep(0.0, 3.5, y));
    albedo *= 0.93 + 0.07 * vnoise3(vec3(vWall.x * 0.5, y * 0.08, vInfo.y * 10.0));
    // mud stain below the highest water level
    float mud = step(y, vMudLine) * step(0.05, vMaxDepth);
    albedo = mix(albedo, vec3(0.20, 0.16, 0.11), mud * 0.5);
    albedo *= 1.0 - 0.15 * smoothstep(0.5, 8.0, uRainNow);
  } else {
    albedo *= 0.88 + 0.22 * vnoise3(vec3(vWorld.xz * 0.35, vInfo.y * 20.0));
    gloss = 0.15 * smoothstep(0.5, 6.0, uRainNow); // wet roofs
  }

  // flooded buildings stand out: roof (and the top of the walls) take the status colour
  float d = vDepth;
  if (uHighlight > 0.5 && uMode == 0 && d >= 0.1) {
    vec3 sc = d >= 1.0 ? vec3(0.816, 0.231, 0.231) : d >= 0.5 ? vec3(0.925, 0.514, 0.353) : vec3(0.98, 0.698, 0.098);
    float k = roof ? 0.8 : 0.3 * smoothstep(vInfo.x - 1.0, vInfo.x, y);
    albedo = mix(albedo, srgb(sc), k);
    emissive += srgb(sc) * (roof ? 0.1 : 0.0) * (1.0 - uDaylight * 0.6);
  }
  if (uMode == 1) {
    albedo = d > uImpactThreshold ? depthRamp(d) : vec3(0.16, 0.16, 0.15);
    emissive = vec3(0.0);
  } else if (uMode == 2) {
    float m = vMaxDepth;
    albedo = m > uImpactThreshold ? depthRamp(m) : vec3(0.16, 0.16, 0.15);
    emissive = vec3(0.0);
  }

  float ndl = max(dot(n, uSunDir), 0.0);
  float sh = ndl > 0.0 ? sunShadow(vWorld + n * 0.4, 0.0008) : 1.0;
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 Hh = normalize(uSunDir + V);
  float spec = pow(max(dot(n, Hh), 0.0), 70.0) * gloss;
  float fres = pow(1.0 - max(dot(n, V), 0.0), 4.0) * gloss;
  vec3 col = albedo * (ambientLight(n) * (roof ? 1.0 : 0.82) + uSunColor * ndl * sh) + uSunColor * spec * sh * 0.6 + fres * uSkyAmbient * 0.35 + emissive;
  col = applyFog(col, length(vWorld - cameraPosition), cameraPosition.y - vWorld.y);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
