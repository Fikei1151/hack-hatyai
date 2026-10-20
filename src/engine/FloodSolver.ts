import * as THREE from 'three';
import { gridOrigin, type CityData } from './cityData';
import { NOISE, RAIN_FIELD } from './glsl';
import type { RainField } from './RainField';

/**
 * 2D shallow-water flood solver on the GPU.
 *
 * Scheme: local-inertial approximation of the shallow water equations (Bates et al. 2010,
 * "LISFLOOD-FP") with the θ-weighted flux of de Almeida et al. (2012), Manning friction,
 * a Froude limiter, and porosity for building blocks. Fluxes live on cell faces (staggered):
 *   flux.r = q across the east face, flux.g = q across the north face  (m²/s)
 *   flux.b / flux.a = west / south boundary faces (only used on the first column / row)
 * state.r = depth h (m), state.g = max depth so far, state.b = arrival time (s, -1 = never),
 * state.a = flow speed (m/s, for rendering foam).
 */

const MAX_SOURCES = 12;
const MAX_CLOSED = 6;
/** flood regulators (gated channel cross-sections) and the grid faces they span */
const MAX_REGULATORS = 4;
const MAX_REG_FACES = 32;
/** edges stay closed this far (m) around each river inflow point */
const INFLOW_VALLEY_RADIUS = 2000;

const PASS_VERT = /* glsl */ `
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const HEADER = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uStatic;   // r bed z, g manning n, b imperviousness, a channel flag
uniform sampler2D uStatic2;  // r porosity, g building fraction, b water body flag, a regulator face code
uniform sampler2D uState;
uniform sampler2D uFlux;
uniform ivec2 uGrid;
uniform float uDx;
uniform float uDt;
uniform float uG;
`;

const FLUX_FRAG = /* glsl */ `
${HEADER}
uniform float uTheta;
uniform float uFroude;
uniform float uLakeStage;
out vec4 outFlux;

float faceQ(float q, float qa, float qb, float zL, float hL, float pL, float zR, float hR, float pR, float n) {
  float etaL = zL + hL;
  float etaR = zR + hR;
  float hf = max(etaL, etaR) - max(zL, zR);
  if (hf <= 1e-3) return 0.0;
  float slope = (etaR - etaL) / uDx;
  float qs = uTheta * q + 0.5 * (1.0 - uTheta) * (qa + qb);
  float qn = (qs - uG * hf * uDt * slope) / (1.0 + uG * uDt * n * n * abs(qs) / pow(hf, 7.0 / 3.0));
  float qmax = uFroude * hf * sqrt(uG * hf);
  qn = clamp(qn, -qmax, qmax);
  // never move more water through one face than a quarter of what the donor cell holds
  if (qn > 0.0) qn = min(qn, pL * hL * uDx / (4.0 * uDt));
  else qn = max(qn, -pR * hR * uDx / (4.0 * uDt));
  return qn;
}

vec4 cellZ(ivec2 c) { return texelFetch(uStatic, clamp(c, ivec2(0), uGrid - 1), 0); }
float cellH(ivec2 c) { return texelFetch(uState, clamp(c, ivec2(0), uGrid - 1), 0).r; }
float cellP(ivec2 c) { return texelFetch(uStatic2, clamp(c, ivec2(0), uGrid - 1), 0).r; }
vec4 cellQ(ivec2 c) { return texelFetch(uFlux, clamp(c, ivec2(0), uGrid - 1), 0); }

// Interior face fluxes of cell c (east face: c → c+x, north face: c → c+y), as main() computes them;
// used to total a regulator's cross-section.
float eastQ(ivec2 c) {
  ivec2 e = c + ivec2(1, 0);
  vec4 s = cellZ(c);
  vec4 se = cellZ(e);
  return faceQ(cellQ(c).r, cellQ(c - ivec2(1, 0)).r, cellQ(e).r, s.r, cellH(c), cellP(c), se.r, cellH(e), cellP(e), 0.5 * (s.g + se.g));
}
float northQ(ivec2 c) {
  ivec2 nn = c + ivec2(0, 1);
  vec4 s = cellZ(c);
  vec4 sn = cellZ(nn);
  return faceQ(cellQ(c).g, cellQ(c - ivec2(0, 1)).g, cellQ(nn).g, s.r, cellH(c), cellP(c), sn.r, cellH(nn), cellP(nn), 0.5 * (s.g + sn.g));
}

// Flood regulators: the channel discharge through a gated cross-section may not exceed its capacity
// (overbank flow around the structure stays free). Every face of a regulator evaluates all of the
// regulator's faces, so the cap holds exactly within the step.
uniform vec4 uRegFace[${MAX_REG_FACES}]; // cell i, cell j, face (0 east, 1 north), ±(regulator + 1): sign = downstream
uniform int uNumRegFaces;
uniform float uRegCap[${MAX_REGULATORS}]; // m³/s, ≤ 0 = fully open
float regulatorQ(int k) {
  float total = 0.0;
  for (int m = 0; m < ${MAX_REG_FACES}; m++) {
    if (m >= uNumRegFaces) break;
    vec4 f = uRegFace[m];
    if (int(abs(f.w)) - 1 != k) continue;
    ivec2 c = ivec2(f.xy);
    total += sign(f.w) * (f.z < 0.5 ? eastQ(c) : northQ(c)) * uDx;
  }
  return total;
}
float regulated(float q, float code) {
  int m = int(code + 0.5) - 1;
  if (m < 0) return q;
  vec4 f = uRegFace[m];
  int k = int(abs(f.w)) - 1;
  float cap = uRegCap[k];
  if (cap <= 0.0 || sign(f.w) * q <= 0.0) return q;
  float total = regulatorQ(k);
  return total > cap ? q * cap / total : q;
}

// Domain edges.
// North: the downstream outlet. Builds that reach Songkhla Lake put this edge in open water and
// uLakeStage is the lake level; older builds stop ~10 km short and pass a backwater rating instead
// (Engine.outletStage). Free outflow down a gentle slope, held up by uLakeStage when that is higher
// (backwater can enter up to that level, no further).
float outletQ(float q, float ze, float he, float pe, float n) {
  float zg = ze - 0.00012 * uDx;
  float eta = max(zg + he, uLakeStage);
  return faceQ(q, q, q, ze, he, pe, zg, max(0.0, eta - zg), 1.0, n);
}
// River valleys where a prescribed inflow enters: the flood arrives through them, so they never drain
// out (without this the injected river leaks straight back across the edge on the channel's banks).
uniform vec3 uClosed[${MAX_CLOSED}]; // cell i, cell j, radius (cells)
uniform int uNumClosed;
bool closedEdge(ivec2 c) {
  for (int k = 0; k < ${MAX_CLOSED}; k++) {
    if (k >= uNumClosed) break;
    if (distance(vec2(c), uClosed[k].xy) <= uClosed[k].z) return true;
  }
  return false;
}
// South/east/west: rivers crossing them are prescribed inflows, so these edges only let water out,
// and only where the ground keeps falling beyond the edge (bed extrapolated from the interior).
float edgeOutQ(float q, ivec2 edge, ivec2 inward, float he, float pe, float n) {
  if (closedEdge(edge)) return 0.0;
  float ze = cellZ(edge).r;
  float zg = ze + clamp(ze - cellZ(edge + inward).r, -2.0, 2.0);
  if (zg >= ze) return 0.0;
  return faceQ(q, q, q, ze, he, pe, zg, he, 1.0, n); // positive = leaving the domain
}

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 s = cellZ(c);
  float h = cellH(c);
  float p = cellP(c);
  vec4 q = cellQ(c);
  vec4 res = vec4(0.0);
  float reg = texelFetch(uStatic2, c, 0).a; // regulator face codes: east + 64 × north

  // east face (c → c+x)
  if (c.x < uGrid.x - 1) {
    ivec2 e = c + ivec2(1, 0);
    vec4 se = cellZ(e);
    res.r = faceQ(q.r, cellQ(c - ivec2(1, 0)).r, cellQ(e).r, s.r, h, p, se.r, cellH(e), cellP(e), 0.5 * (s.g + se.g));
    if (reg > 0.0) res.r = regulated(res.r, mod(reg, 64.0));
  } else {
    res.r = max(0.0, edgeOutQ(q.r, c, ivec2(-1, 0), h, p, s.g));
  }
  // north face (c → c+y)
  if (c.y < uGrid.y - 1) {
    ivec2 nn = c + ivec2(0, 1);
    vec4 sn = cellZ(nn);
    res.g = faceQ(q.g, cellQ(c - ivec2(0, 1)).g, cellQ(nn).g, s.r, h, p, sn.r, cellH(nn), cellP(nn), 0.5 * (s.g + sn.g));
    if (reg > 0.0) res.g = regulated(res.g, floor(reg / 64.0));
  } else {
    res.g = outletQ(q.g, s.r, h, p, s.g);
  }
  // west / south boundary faces are stored as fluxes INTO the cell, so outflow is negative
  if (c.x == 0) res.b = -max(0.0, edgeOutQ(-q.b, c, ivec2(1, 0), h, p, s.g));
  if (c.y == 0) res.a = -max(0.0, edgeOutQ(-q.a, c, ivec2(0, 1), h, p, s.g));
  outFlux = res;
}
`;

const DEPTH_FRAG = /* glsl */ `
${HEADER}
uniform float uTime;
uniform float uRainBase;      // m/s, domain average
uniform float uInfil;         // m/s on pervious ground
uniform float uDrain;         // m/s storm-drain capacity on impervious ground
uniform float uChannelInject; // m/s re-routed drain water entering channel cells
uniform vec4 uSources[${MAX_SOURCES}]; // cell i, cell j, m/s per receiving cell, half-width (+100 = channel cells only)
uniform int uNumSources;
uniform vec2 uOrigin;         // local metres of cell (0,0) centre
${NOISE}
${RAIN_FIELD}
out vec4 outState;

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 st = texelFetch(uStatic, c, 0);
  vec4 st2 = texelFetch(uStatic2, c, 0);
  vec4 s = texelFetch(uState, c, 0);
  vec4 f = texelFetch(uFlux, c, 0);
  float qE = f.r;
  float qN = f.g;
  float qW = c.x > 0 ? texelFetch(uFlux, c - ivec2(1, 0), 0).r : f.b;
  float qS = c.y > 0 ? texelFetch(uFlux, c - ivec2(0, 1), 0).g : f.a;
  float phi = st2.r;
  bool channel = st.a > 0.5;

  vec2 p = uOrigin + vec2(c) * uDx;
  float rain = uRainBase > 0.0 ? uRainBase * rainFactor(p, st.r) : 0.0;

  float src = channel ? uChannelInject : 0.0;
  for (int k = 0; k < ${MAX_SOURCES}; k++) {
    if (k >= uNumSources) break;
    vec4 sk = uSources[k];
    vec2 d = abs(vec2(c) - sk.xy);
    float hw = mod(sk.w, 100.0);
    if (d.x <= hw && d.y <= hw && (sk.w < 100.0 || channel)) src += sk.z;
  }

  float net = (qW - qE + qS - qN) / uDx;
  float h = s.r + uDt * (net + rain + src) / phi;
  float loss = (1.0 - st.b) * uInfil + (channel ? 0.0 : st.b * uDrain);
  h = max(0.0, h - uDt * loss / phi);

  float speed = 0.0;
  if (h > 0.02) {
    vec2 vel = 0.5 * vec2(qE + qW, qN + qS) / h;
    speed = length(vel);
  }
  float arrival = s.b;
  if (arrival < 0.0 && h > 0.1 && !channel && st2.b < 0.5) arrival = uTime;
  outState = vec4(h, max(s.g, h), arrival, speed);
}
`;

const INIT_FRAG = /* glsl */ `
precision highp float;
precision highp sampler2D;
uniform sampler2D uSrc;
out vec4 outColor;
void main() { outColor = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0); }
`;

export interface SolverForcing {
  rainMs: number; // m/s
  infilMs: number;
  drainMs: number;
  lakeStage: number;
  /** local metres; river inflows spread over the channel cells near the entry point */
  sources: { x: number; y: number; m3s: number; halfWidth: number; channelOnly: boolean }[];
}

export class FloodSolver {
  readonly nx: number;
  readonly ny: number;
  readonly dx: number;
  readonly staticTex: THREE.DataTexture;
  readonly static2Tex: THREE.DataTexture;
  readonly channelCells: number;
  /** local metres of the grid's south-west corner */
  private readonly x0: number;
  private readonly y0: number;
  private readonly regulatorFaces: THREE.Vector4[];
  private regulatorFaceCount = 0;
  private state: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private flux: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private cur = 0;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private fluxMat: THREE.RawShaderMaterial;
  private depthMat: THREE.RawShaderMaterial;
  private initMat: THREE.RawShaderMaterial;
  private initial: Float32Array;
  time = 0;
  /** extra m/s injected into channel cells (urban drainage re-routed to canals) */
  channelInject = 0;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private city: CityData,
    rain: RainField,
  ) {
    const { meta, terrain, landcover } = city;
    this.nx = meta.nx;
    this.ny = meta.ny;
    this.dx = meta.cell;
    const { x0, y0 } = gridOrigin(meta);
    this.x0 = x0;
    this.y0 = y0;
    const n = this.nx * this.ny;

    const s1 = new Float32Array(n * 4);
    const s2 = new Float32Array(n * 4);
    this.initial = new Float32Array(n * 4);
    let channels = 0;
    for (let id = 0; id < n; id++) {
      const bf = landcover[id * 4] / 255;
      const channel = landcover[id * 4 + 1] > 0;
      const water = landcover[id * 4 + 2] === 255;
      const imperv = landcover[id * 4 + 3] / 255;
      if (channel) channels++;
      // Manning n: concrete canals 0.025, natural river (vegetated banks, many bridges) 0.045,
      // ponds 0.025, open land 0.05; building blocks add obstruction roughness (urban floodplain)
      const kind = landcover[id * 4 + 2];
      const manning = channel ? (kind === 20 ? 0.025 : 0.045) : water ? 0.025 : 0.05 + 0.15 * bf + 0.02 * imperv;
      s1[id * 4] = terrain[id];
      s1[id * 4 + 1] = manning;
      s1[id * 4 + 2] = channel || water ? 0 : imperv;
      s1[id * 4 + 3] = channel ? 1 : 0;
      s2[id * 4] = channel || water ? 1 : Math.max(0.35, 1 - 0.65 * bf); // storage porosity
      s2[id * 4 + 1] = bf;
      s2[id * 4 + 2] = water ? 1 : 0;
      this.initial[id * 4] = water && !channel ? 1.2 : 0; // ponds start full
      this.initial[id * 4 + 2] = -1;
    }
    this.channelCells = channels;
    this.regulatorFaces = this.buildRegulators(landcover, s2);
    // canals start with some base flow (~35 % of their depth below the banks, from the build script);
    // the engine then spins the network up in dry weather and adopts that as the true t = 0 state
    for (let id = 0; id < n; id++) {
      const g = landcover[id * 4 + 1];
      if (g > 0) this.initial[id * 4] = Math.min(2.5, g * 0.05 * 0.35);
    }
    this.staticTex = dataTex(s1, this.nx, this.ny);
    this.static2Tex = dataTex(s2, this.nx, this.ny);

    const rtOpts = {
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    } as const;
    this.state = [new THREE.WebGLRenderTarget(this.nx, this.ny, rtOpts), new THREE.WebGLRenderTarget(this.nx, this.ny, rtOpts)];
    this.flux = [new THREE.WebGLRenderTarget(this.nx, this.ny, rtOpts), new THREE.WebGLRenderTarget(this.nx, this.ny, rtOpts)];

    const common = {
      uStatic: { value: this.staticTex },
      uStatic2: { value: this.static2Tex },
      uState: { value: null as THREE.Texture | null },
      uFlux: { value: null as THREE.Texture | null },
      uGrid: { value: new THREE.Vector2(this.nx, this.ny) },
      uDx: { value: this.dx },
      uDt: { value: 1 },
      uG: { value: 9.81 },
    };
    const closed = meta.inflows
      .slice(0, MAX_CLOSED)
      .map((f) => new THREE.Vector3((f.x - x0) / this.dx - 0.5, (f.y - y0) / this.dx - 0.5, INFLOW_VALLEY_RADIUS / this.dx));
    while (closed.length < MAX_CLOSED) closed.push(new THREE.Vector3());
    this.fluxMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: PASS_VERT,
      fragmentShader: FLUX_FRAG,
      uniforms: {
        ...common,
        uState: { value: null },
        uFlux: { value: null },
        uTheta: { value: 0.8 },
        uFroude: { value: 1.0 },
        uLakeStage: { value: 1.0 },
        uClosed: { value: closed },
        uNumClosed: { value: Math.min(MAX_CLOSED, meta.inflows.length) },
        uRegFace: { value: this.regulatorFaces },
        uNumRegFaces: { value: this.regulatorFaceCount },
        uRegCap: { value: Array.from({ length: MAX_REGULATORS }, (_, k) => this.regulators[k]?.capM3s ?? 0) },
      },
    });
    this.depthMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: PASS_VERT,
      fragmentShader: DEPTH_FRAG,
      uniforms: {
        ...common,
        uState: { value: null },
        uFlux: { value: null },
        uTime: { value: 0 },
        uRainBase: { value: 0 },
        uInfil: { value: 0 },
        uDrain: { value: 0 },
        uChannelInject: { value: 0 },
        uSources: { value: Array.from({ length: MAX_SOURCES }, () => new THREE.Vector4()) },
        uNumSources: { value: 0 },
        uOrigin: { value: new THREE.Vector2(x0 + this.dx / 2, y0 + this.dx / 2) },
        ...rain.uniforms,
      },
    });
    this.initMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: PASS_VERT,
      fragmentShader: INIT_FRAG,
      uniforms: { uSrc: { value: null } },
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.fluxMat);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    this.reset();
  }

  /**
   * Faces of each regulator's cross-section: channel-to-channel faces whose cells lie on opposite
   * sides of the line through the regulator perpendicular to the channel. Writes the face codes into
   * static2.a (east entry + 64 × north entry, entries 1-based) and returns the uniform entries.
   */
  private buildRegulators(landcover: Uint8Array, s2: Float32Array): THREE.Vector4[] {
    const { nx, ny, dx, x0, y0 } = this;
    const faces: THREE.Vector4[] = [];
    const channel = (i: number, j: number) => i >= 0 && j >= 0 && i < nx && j < ny && landcover[(j * nx + i) * 4 + 1] > 0;
    this.regulators.forEach((r, k) => {
      const along = (i: number, j: number) => (x0 + (i + 0.5) * dx - r.x) * r.tx + (y0 + (j + 0.5) * dx - r.y) * r.ty;
      const ci = Math.floor((r.x - x0) / dx);
      const cj = Math.floor((r.y - y0) / dx);
      const R = Math.ceil(r.halfWidth / dx) + 2;
      for (let j = cj - R; j <= cj + R; j++)
        for (let i = ci - R; i <= ci + R; i++)
          for (const [di, dj, face] of [
            [1, 0, 0],
            [0, 1, 1],
          ]) {
            const i2 = i + di;
            const j2 = j + dj;
            if (i < 1 || j < 1 || i2 >= nx - 1 || j2 >= ny - 1 || !channel(i, j) || !channel(i2, j2)) continue;
            const a = along(i, j);
            const b = along(i2, j2);
            if (a * b > 0 || a === b) continue; // both cells on the same side of the cross-section
            const mx = x0 + (i + 0.5 + di / 2) * dx - r.x;
            const my = y0 + (j + 0.5 + dj / 2) * dx - r.y;
            if (Math.abs(mx * r.ty - my * r.tx) > r.halfWidth + dx) continue; // another channel nearby
            if (faces.length >= MAX_REG_FACES) continue;
            faces.push(new THREE.Vector4(i, j, face, (b > a ? 1 : -1) * (k + 1)));
            s2[(j * nx + i) * 4 + 3] += face === 0 ? faces.length : faces.length * 64;
          }
    });
    this.regulatorFaceCount = faces.length;
    const out = faces.slice();
    while (out.length < MAX_REG_FACES) out.push(new THREE.Vector4(0, 0, 0, 0));
    return out;
  }

  /** Regulators in this city (gate capacities can be changed while running). */
  get regulators() {
    return (this.city.meta.regulators ?? []).slice(0, MAX_REGULATORS);
  }

  /** Set a regulator's channel capacity in m³/s (≤ 0 opens it fully). */
  setRegulatorCap(id: string, m3s: number) {
    const k = this.regulators.findIndex((r) => r.id === id);
    if (k >= 0) (this.fluxMat.uniforms.uRegCap.value as number[])[k] = m3s;
  }

  get stateTexture(): THREE.Texture {
    return this.state[this.cur].texture;
  }
  get stateTarget(): THREE.WebGLRenderTarget {
    return this.state[this.cur];
  }
  /** latest face fluxes (r: east face, g: north face, m²/s) — drives the flow animation */
  get fluxTexture(): THREE.Texture {
    return this.flux[this.cur].texture;
  }

  reset() {
    const tex = dataTex(this.initial, this.nx, this.ny);
    this.initMat.uniforms.uSrc.value = tex;
    this.quad.material = this.initMat;
    const prevTarget = this.renderer.getRenderTarget();
    for (const rt of this.state) {
      this.renderer.setRenderTarget(rt);
      this.renderer.render(this.scene, this.camera);
    }
    const prevClear = this.renderer.getClearColor(new THREE.Color());
    const prevAlpha = this.renderer.getClearAlpha();
    this.renderer.setClearColor(0x000000, 0);
    for (const rt of this.flux) {
      this.renderer.setRenderTarget(rt);
      this.renderer.clear(true, false, false);
    }
    this.renderer.setClearColor(prevClear, prevAlpha);
    this.renderer.setRenderTarget(prevTarget);
    tex.dispose();
    this.cur = 0;
    this.time = 0;
  }

  /** Advance `steps` steps of length dt seconds. */
  step(dt: number, steps: number, f: SolverForcing) {
    const fu = this.fluxMat.uniforms;
    const du = this.depthMat.uniforms;
    fu.uDt.value = dt;
    du.uDt.value = dt;
    fu.uLakeStage.value = f.lakeStage;
    du.uRainBase.value = f.rainMs;
    du.uInfil.value = f.infilMs;
    du.uDrain.value = f.drainMs;
    du.uChannelInject.value = this.channelInject;
    const src = du.uSources.value as THREE.Vector4[];
    const n = Math.min(MAX_SOURCES, f.sources.length);
    for (let k = 0; k < n; k++) {
      const s = f.sources[k];
      const ci = Math.round((s.x - this.x0) / this.dx - 0.5);
      const cj = Math.round((s.y - this.y0) / this.dx - 0.5);
      const cells = this.receivingCells(ci, cj, s.halfWidth, s.channelOnly);
      const channelOnly = s.channelOnly && cells > 0;
      const count = channelOnly ? cells : (2 * s.halfWidth + 1) ** 2;
      src[k].set(ci, cj, s.m3s / (count * this.dx * this.dx), s.halfWidth + (channelOnly ? 100 : 0));
    }
    du.uNumSources.value = n;

    const prevTarget = this.renderer.getRenderTarget();
    for (let i = 0; i < steps; i++) {
      const next = 1 - this.cur;
      fu.uState.value = this.state[this.cur].texture;
      fu.uFlux.value = this.flux[this.cur].texture;
      this.quad.material = this.fluxMat;
      this.renderer.setRenderTarget(this.flux[next]);
      this.renderer.render(this.scene, this.camera);

      this.time += dt;
      du.uTime.value = this.time;
      du.uState.value = this.state[this.cur].texture;
      du.uFlux.value = this.flux[next].texture;
      this.quad.material = this.depthMat;
      this.renderer.setRenderTarget(this.state[next]);
      this.renderer.render(this.scene, this.camera);
      this.cur = next;
    }
    this.renderer.setRenderTarget(prevTarget);
  }

  private receivingCache = new Map<string, number>();
  private receivingCells(ci: number, cj: number, hw: number, channelOnly: boolean) {
    if (!channelOnly) return (2 * hw + 1) ** 2;
    const key = `${ci},${cj},${hw}`;
    let n = this.receivingCache.get(key);
    if (n === undefined) {
      n = 0;
      for (let j = cj - hw; j <= cj + hw; j++)
        for (let i = ci - hw; i <= ci + hw; i++)
          if (i >= 0 && j >= 0 && i < this.nx && j < this.ny && this.city.landcover[(j * this.nx + i) * 4 + 1] > 0) n++;
      this.receivingCache.set(key, n);
    }
    return n;
  }

  /** Make the current state the reset state (after a dry-weather spin-up); returns it. */
  async adoptCurrentAsInitial(): Promise<Float32Array> {
    const buf = new Float32Array(this.nx * this.ny * 4);
    await this.readState(buf);
    for (let id = 0; id < this.nx * this.ny; id++) {
      const h = buf[id * 4];
      this.initial[id * 4] = h;
      this.initial[id * 4 + 1] = h;
      this.initial[id * 4 + 2] = -1;
      this.initial[id * 4 + 3] = 0;
    }
    this.reset();
    return buf;
  }

  readState(buffer: Float32Array): Promise<Float32Array> {
    return this.renderer.readRenderTargetPixelsAsync(this.state[this.cur], 0, 0, this.nx, this.ny, buffer) as Promise<Float32Array>;
  }

  dispose() {
    for (const rt of [...this.state, ...this.flux]) rt.dispose();
    this.fluxMat.dispose();
    this.depthMat.dispose();
    this.initMat.dispose();
    this.staticTex.dispose();
    this.static2Tex.dispose();
  }
}

function dataTex(data: Float32Array, w: number, h: number) {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = THREE.NearestFilter;
  t.magFilter = THREE.NearestFilter;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}
