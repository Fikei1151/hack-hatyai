import * as THREE from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import { HOUR, sampleForcing, totalHours } from '../sim/scenario';
import type { LiveStats, Scenario, SeriesPoint } from '../sim/types';
import { Atmosphere } from './Atmosphere';
import { depressionDepth } from './basins';
import { Buildings } from './Buildings';
import { cellIndex, gridCentre, gridOrigin, sampleGrid, type CityData, type CityMeta, type Place, type PlaceCategory } from './cityData';
import { FloodSolver } from './FloodSolver';
import { Labels } from './Labels';
import { Rain } from './Rain';
import { RainField } from './RainField';
import { Roads } from './Roads';
import { SHADOW_LAYER, SunShadow } from './Shadows';
import { gridIndex, gridUv, Terrain } from './Terrain';
import { Trees } from './Trees';
import { Water, type WaterMode } from './Water';

export interface Layers {
  buildings: boolean;
  imagery: boolean;
  roads: boolean;
  /** trees planted from the satellite imagery */
  trees: boolean;
  rain: boolean;
  shadows: boolean;
  /** landmark pins + river inflow markers */
  labels: boolean;
  /** village / suburb names */
  places: boolean;
  canalNames: boolean;
  roadNames: boolean;
  keyPlaces: boolean;
  placeCategories: PlaceCategory[];
  /** tint the roofs of flooded buildings by severity */
  highlight: boolean;
  waterMode: WaterMode;
  impact: 'off' | 'current' | 'max';
  realLight: boolean;
}

export interface EngineSettings {
  playing: boolean;
  /** simulation seconds per real second */
  speed: number;
  scenario: Scenario;
  layers: Layers;
}

export interface PlaceImpact {
  depth: Float32Array;
  maxDepth: Float32Array;
  /** simulation hours when water first exceeded 10 cm, -1 = never */
  firstWet: Float32Array;
}

/** End-of-day picture of the flood, kept so the user can flip back through the days. */
export interface DaySummary {
  /** local calendar date (Asia/Bangkok) the snapshot closes */
  key: string;
  t: number;
  floodedKm2: number;
  buildings: number;
  maxDepth: number;
}

export interface EngineCallbacks {
  onStats: (s: LiveStats) => void;
  onSeriesPoint: (p: SeriesPoint) => void;
  onFinished: () => void;
  onPoiClick: (id: string) => void;
  onPlaceClick: (id: string) => void;
  onPlaceImpact: (impact: PlaceImpact) => void;
  onDaySnapshot: (d: DaySummary) => void;
  onFastForwardDone: () => void;
}

const MAX_DAYS = 16;

/** Something drawn on top of the city (the board game's markers and routes) that hooks into the render loop. */
export interface EngineLayer {
  /** before the 3D scene is drawn */
  beforeRender?(dt: number): void;
  /** after the scene is drawn, camera matrices are fresh (project world points to the screen here) */
  afterRender?(dt: number): void;
  resize?(w: number, h: number): void;
}

const G = 9.81;

/**
 * Water level at the north edge of the model. City builds that reach Songkhla Lake (meta.outlet =
 * 'lake') use the lake level itself. Older builds stop ~10 km short of the lake, so their edge
 * stands above it by the backwater of that reach, which grows with the flow it carries (a simple
 * rating curve, tuned on the Nov 2025 X.44 hydrograph).
 */
export function outletStage(lakeLevelM: number, inflowM3s: number, meta?: CityMeta) {
  // domains that reach the lake take its level directly
  if (meta?.outlet === 'lake') return lakeLevelM;
  return lakeLevelM + 1.6 * Math.pow(Math.max(0, inflowM3s) / 1000, 0.75);
}

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: MapControls;
  private atmosphere = new Atmosphere();
  private shadow = new SunShadow();
  private rainField: RainField;
  private solver: FloodSolver;
  private terrain: Terrain;
  private water: Water;
  private buildings: Buildings;
  private roads: Roads;
  private trees: Trees;
  /** which shadow casters are shown; the cached sun shadow map is redrawn when this changes */
  private casters = '';
  private rain = new Rain();
  private labels: Labels;
  private raf = 0;
  private last = performance.now();
  private clock = 0;
  private stateUniform: THREE.IUniform<THREE.Texture | null>;
  private fluxUniform: THREE.IUniform<THREE.Texture | null>;
  private readBuf: Float32Array;
  private readPending = false;
  private lastRead = 0;
  private lastSeriesT = -Infinity;
  private maxStepsPerFrame = 80;
  private stepsThisSecond = 0;
  private stepsPerSecond = 0;
  private secondTimer = 0;
  /** fastest gravity wave in the domain, sqrt(g h / porosity), from the last readback */
  private waveSpeed = Math.sqrt(G * 2.5);
  private lastDt = 1;
  private drainRateM3s = 0;
  private drainEff = 1;
  private canalFill = 0;
  private fly: { from: THREE.Vector3; to: THREE.Vector3; tFrom: THREE.Vector3; tTo: THREE.Vector3; t: number } | null = null;
  private porosity: Float32Array;
  private channel: Uint8Array;
  private permanentWater: Uint8Array;
  private imperv: Float32Array;
  /** water a cell holds in its natural basin (paddy, retention area) before it spills: not a flood */
  private storage: Float32Array;
  private poiCells: { id: string; name: string; cells: number[] }[];
  private gaugeCells: { id: string; code: string; cells: number[] }[];
  private poiMax = new Map<string, number>();
  private places: Place[] = [];
  private placeCells: number[][] = [];
  private impact: PlaceImpact = { depth: new Float32Array(0), maxDepth: new Float32Array(0), firstWet: new Float32Array(0) };
  private resizeObs: ResizeObserver;
  private categorySet = new Set<PlaceCategory>();
  private categoryKey = '';
  simTime = 0;
  cumRainMm = 0;
  private finished = false;
  private days: { key: string; depth: Float32Array }[] = [];
  private currentDay: string | null = null;
  private captureFinal = false;
  private viewing: string | null = null;
  private snapshotTex: THREE.DataTexture | null = null;
  private zeroFlux: THREE.DataTexture | null = null;
  private ffTarget: number | null = null;
  /** simulated seconds per real second while running to a target (huge = as fast as the GPU goes) */
  private ffSpeed = 1e7;
  private layers: EngineLayer[] = [];
  private statsQueued = false;
  /** resolves once the canal network has been spun up to a steady dry-weather state */
  readonly ready: Promise<void>;
  private isReady = false;

  constructor(
    private container: HTMLElement,
    private city: CityData,
    private getSettings: () => EngineSettings,
    private cb: EngineCallbacks,
  ) {
    const { meta } = city;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.className = 'scene-canvas';

    this.camera = new THREE.PerspectiveCamera(45, 1, 2, 160000);
    this.controls = new MapControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = false;
    this.controls.maxPolarAngle = THREE.MathUtils.degToRad(86);
    this.controls.minDistance = 25;
    this.controls.maxDistance = 32000;
    this.controls.zoomToCursor = true;

    this.rainField = new RainField(meta, city.terrain, getSettings().scenario.seed);
    this.solver = new FloodSolver(this.renderer, city, this.rainField);
    this.stateUniform = { value: this.solver.stateTexture };
    this.fluxUniform = { value: this.solver.fluxTexture };
    const index = gridIndex(meta.nx, meta.ny);
    const uv = gridUv(meta.nx, meta.ny);
    const atmo = this.atmosphere.uniforms as unknown as Record<string, THREE.IUniform>;
    const shadowU = this.shadow.uniforms as unknown as Record<string, THREE.IUniform>;
    const rainU = this.rainField.uniforms as unknown as Record<string, THREE.IUniform>;
    this.terrain = new Terrain(city, index, uv, { atmosphere: atmo, rain: rainU, shadow: shadowU, water: { uState: this.stateUniform } });
    this.terrain.mesh.layers.enable(SHADOW_LAYER);
    this.water = new Water(city, index, uv, this.solver.staticTex, this.stateUniform, this.fluxUniform, atmo, shadowU);
    this.buildings = new Buildings(city, this.solver.staticTex, this.stateUniform, atmo, shadowU);
    this.roads = new Roads(city, atmo, shadowU);
    this.trees = new Trees(city, this.solver.staticTex, this.stateUniform, atmo, shadowU);
    this.labels = new Labels(container, city, { onPoiClick: (id) => cb.onPoiClick(id), onPlaceClick: (id) => cb.onPlaceClick(id) });

    this.scene.add(this.atmosphere.sky, this.terrain.mesh, this.terrain.skirt, this.roads.mesh, this.buildings.group, this.trees.group, this.water.mesh, this.rain.mesh, this.labels.group);
    (this.atmosphere.sky.material as THREE.Material).depthTest = false;

    const n = meta.nx * meta.ny;
    this.readBuf = new Float32Array(n * 4);
    this.porosity = new Float32Array(n);
    this.channel = new Uint8Array(n);
    this.permanentWater = new Uint8Array(n);
    this.imperv = new Float32Array(n);
    for (let id = 0; id < n; id++) {
      const bf = city.landcover[id * 4] / 255;
      this.channel[id] = city.landcover[id * 4 + 1] > 0 ? 1 : 0;
      this.permanentWater[id] = this.channel[id] || city.landcover[id * 4 + 2] === 255 ? 1 : 0;
      this.porosity[id] = this.permanentWater[id] ? 1 : Math.max(0.35, 1 - 0.65 * bf);
      this.imperv[id] = this.permanentWater[id] ? 0 : city.landcover[id * 4 + 3] / 255;
    }
    this.storage = depressionDepth(city.terrain, meta.nx, meta.ny);
    this.poiCells = meta.pois.map((p) => ({ id: p.id, name: p.name, cells: this.landCells(p.x, p.y) }));

    // virtual RID gauges: water surface in the channel cells around the real station
    this.gaugeCells = meta.gauges.map((g) => {
      const c = cellIndex(meta, g.x, g.y);
      const ci = c % meta.nx;
      const cj = Math.floor(c / meta.nx);
      const cells: number[] = [];
      for (let dj = -3; dj <= 3; dj++)
        for (let di = -3; di <= 3; di++) {
          const i = ci + di;
          const j = cj + dj;
          if (i < 0 || j < 0 || i >= meta.nx || j >= meta.ny) continue;
          if (this.channel[j * meta.nx + i]) cells.push(j * meta.nx + i);
        }
      // the gauge sits in the main channel: keep only the deepest-bed cells nearby
      const minBed = Math.min(...cells.map((id) => city.terrain[id]));
      const main = cells.filter((id) => city.terrain[id] <= minBed + 0.5);
      return { id: g.id, code: g.code, cells: main.length ? main : [c] };
    });
    this.setPlaces(city.places);

    this.setInitialView();
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
    this.resize();
    this.raf = requestAnimationFrame(this.loop);
    this.ready = this.spinUp();
  }

  /**
   * Run ~2 h of dry weather with base river flow so canals, ponds and low wetlands reach their
   * normal levels; that state becomes t = 0, and land that is wet in dry weather is treated as
   * permanent water (never counted as "flooded").
   */
  private async spinUp() {
    const meta = this.city.meta;
    const forcing = {
      rainMs: 0,
      infilMs: 0,
      drainMs: 0,
      lakeStage: 0.8,
      sources: meta.inflows.map((f) => ({ x: f.x, y: f.y, m3s: 40 * f.share, halfWidth: 4, channelOnly: true })),
    };
    for (let k = 0; k < 8; k++) {
      this.solver.step(1.0, 900, forcing);
      this.stateUniform.value = this.solver.stateTexture;
      this.fluxUniform.value = this.solver.fluxTexture;
      await new Promise((r) => setTimeout(r, 16));
    }
    const buf = await this.solver.adoptCurrentAsInitial();
    for (let id = 0; id < meta.nx * meta.ny; id++) if (!this.permanentWater[id] && buf[id * 4] > 0.05) this.permanentWater[id] = 1;
    this.poiCells = meta.pois.map((p) => ({ id: p.id, name: p.name, cells: this.landCells(p.x, p.y) }));
    this.setPlaces(this.places);
    this.stateUniform.value = this.solver.stateTexture;
    this.fluxUniform.value = this.solver.fluxTexture;
    this.isReady = true;
    this.requestStats(true);
  }

  /** Cells around a point that are dry land (canal/pond cells next to a temple are not its yard). */
  private landCells(x: number, y: number): number[] {
    const { meta } = this.city;
    const c = cellIndex(meta, x, y);
    const ci = c % meta.nx;
    const cj = Math.floor(c / meta.nx);
    const cells: number[] = [];
    for (let dj = -1; dj <= 1; dj++)
      for (let di = -1; di <= 1; di++) {
        const i = ci + di;
        const j = cj + dj;
        if (i < 0 || j < 0 || i >= meta.nx || j >= meta.ny) continue;
        if (!this.permanentWater[j * meta.nx + i]) cells.push(j * meta.nx + i);
      }
    return cells.length ? cells : [c];
  }

  setPlaces(places: Place[]) {
    this.places = places;
    this.placeCells = places.map((p) => this.landCells(p.x, p.y));
    this.impact = { depth: new Float32Array(places.length), maxDepth: new Float32Array(places.length), firstWet: new Float32Array(places.length).fill(-1) };
    this.labels.setPlaces(places);
  }

  private setInitialView() {
    const kim = this.city.meta.pois.find((p) => p.id === 'kimyong') ?? { x: 0, y: 0 };
    const gz = sampleGrid(this.city.meta, this.city.terrain, kim.x, kim.y);
    this.controls.target.set(kim.x - 150, gz, -kim.y - 250);
    this.camera.position.set(kim.x + 1100, gz + 900, -kim.y + 1500);
    this.controls.update();
  }

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.labels.resize(w, h);
    for (const l of this.layers) l.resize?.(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Restart the simulation from t = 0 with the current scenario. */
  reset() {
    this.solver.reset();
    this.stateUniform.value = this.solver.stateTexture;
    this.fluxUniform.value = this.solver.fluxTexture;
    this.rainField.reset(this.getSettings().scenario.seed);
    this.simTime = 0;
    this.cumRainMm = 0;
    this.finished = false;
    this.lastSeriesT = -Infinity;
    this.poiMax.clear();
    this.impact.depth.fill(0);
    this.impact.maxDepth.fill(0);
    this.impact.firstWet.fill(-1);
    this.waveSpeed = Math.sqrt(G * 2.5);
    this.drainRateM3s = 0;
    this.drainEff = 1;
    this.solver.channelInject = 0;
    this.readPending = false;
    this.lastRead = 0;
    this.days = [];
    this.currentDay = null;
    this.captureFinal = false;
    this.ffTarget = null;
    this.viewDay(null);
    this.requestStats(true);
  }

  private dayKey(t: number) {
    const ms = Date.parse(this.getSettings().scenario.start_time) + t * 1000;
    return new Date(ms + 7 * 3600_000).toISOString().slice(0, 10);
  }

  /** Show the water as it stood at the end of a recorded day (null = back to the live simulation). */
  viewDay(key: string | null) {
    if (!key) {
      this.viewing = null;
      this.stateUniform.value = this.solver.stateTexture;
      this.fluxUniform.value = this.solver.fluxTexture;
      return;
    }
    const d = this.days.find((x) => x.key === key);
    if (!d) return;
    const { nx, ny } = this.city.meta;
    const make = () => {
      const t = new THREE.DataTexture(new Float32Array(nx * ny * 4), nx, ny, THREE.RGBAFormat, THREE.FloatType);
      t.minFilter = THREE.NearestFilter;
      t.magFilter = THREE.NearestFilter;
      t.needsUpdate = true;
      return t;
    };
    this.snapshotTex ??= make();
    this.zeroFlux ??= make();
    const data = this.snapshotTex.image.data as Float32Array;
    for (let i = 0; i < d.depth.length; i++) {
      data[i * 4] = d.depth[i];
      data[i * 4 + 1] = d.depth[i];
      data[i * 4 + 2] = -1;
      data[i * 4 + 3] = 0;
    }
    this.snapshotTex.needsUpdate = true;
    this.viewing = key;
    this.stateUniform.value = this.snapshotTex;
    this.fluxUniform.value = this.zeroFlux;
  }

  /** Run as fast as the GPU allows to the next local midnight (or the scenario end), then stop. */
  fastForwardToNextDay(): boolean {
    const s = this.getSettings();
    const total = totalHours(s.scenario) * HOUR;
    if (this.finished || this.simTime >= total - 1) return false;
    const startMs = Date.parse(s.scenario.start_time);
    const local = startMs + this.simTime * 1000 + 7 * 3600_000;
    let target = ((Math.floor(local / 86400_000) + 1) * 86400_000 - 7 * 3600_000 - startMs) / 1000;
    if (target - this.simTime < 900) target += 86400;
    this.ffTarget = Math.min(target, total);
    this.ffSpeed = 1e7;
    this.viewDay(null);
    return true;
  }

  get fastForwarding() {
    return this.ffTarget !== null;
  }

  /**
   * Run the simulation to a simulated time, then stop and call onFastForwardDone. `speed` is simulated
   * seconds per real second: leave it huge to go flat out, or pick ~3600 to watch the water rise.
   */
  runTo(target: number, speed = 1e7): boolean {
    const total = totalHours(this.getSettings().scenario) * HOUR;
    if (this.finished || target <= this.simTime + 1) return false;
    this.ffTarget = Math.min(target, total);
    this.ffSpeed = speed;
    this.viewDay(null);
    return true;
  }

  /** Time a burst of solver steps (ms per step) to see how fast this device runs the model; the sim restarts from t = 0. */
  async benchmark(steps = 200): Promise<number> {
    await this.ready;
    const n = this.city.meta.nx * this.city.meta.ny;
    const buf = new Float32Array(n * 4);
    const forcing = { rainMs: 0, infilMs: 0, drainMs: 0, lakeStage: 0.8, sources: [] as { x: number; y: number; m3s: number; halfWidth: number; channelOnly: boolean }[] };
    this.solver.step(1.0, 2, forcing); // warm up (shader compile) and wait for the GPU
    await this.solver.readState(buf);
    const r0 = performance.now();
    await this.solver.readState(buf); // GPU idle: the cost of the read-back alone
    const readMs = performance.now() - r0;
    const t0 = performance.now();
    this.solver.step(1.0, steps, forcing);
    await this.solver.readState(buf);
    const ms = Math.max(0.05, (performance.now() - t0 - readMs) / steps);
    this.solver.reset();
    this.stateUniform.value = this.solver.stateTexture;
    this.fluxUniform.value = this.solver.fluxTexture;
    return ms;
  }

  private tickRun(realDt: number, speed: number, total: number) {
    if (this.ffTarget === null) return;
    if (this.simTime < this.ffTarget - 1) this.advance(realDt, { ...this.getSettings(), speed }, total, this.ffTarget);
    if (this.simTime >= this.ffTarget - 1 || this.finished) {
      this.ffTarget = null;
      this.requestStats(true);
      this.cb.onFastForwardDone();
    }
  }

  /**
   * Advance a pending run-to-target by up to `simSeconds` without waiting for an animation frame
   * (headless play-tests, hidden tabs). Returns true while the run is still pending.
   */
  pump(simSeconds = 2000): boolean {
    if (!this.isReady || this.ffTarget === null || this.finished) return false;
    this.maxStepsPerFrame = 400;
    this.tickRun(0.1, simSeconds / 0.1, totalHours(this.getSettings().scenario) * HOUR);
    return this.ffTarget !== null;
  }

  /** Change how fast a run to a target goes (e.g. skip the animation). */
  setRunSpeed(speed: number) {
    if (this.ffTarget !== null) this.ffSpeed = speed;
  }

  /** Water depth (m above the ground) in every cell right now. */
  async readDepth(): Promise<Float32Array> {
    const n = this.city.meta.nx * this.city.meta.ny;
    const buf = await this.solver.readState(new Float32Array(n * 4));
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = buf[i * 4];
    return out;
  }

  /** Cells that always hold water (canals, ponds, baseline-wet land) — never counted as flooded. */
  get permanent(): Uint8Array {
    return this.permanentWater;
  }

  addLayer(layer: EngineLayer) {
    this.layers.push(layer);
  }

  removeLayer(layer: EngineLayer) {
    this.layers = this.layers.filter((l) => l !== layer);
  }

  /** Local metres (x east, y north) of the ground under a screen point, or null if the ray misses the map. */
  pickGround(clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -(((clientY - rect.top) / rect.height) * 2 - 1));
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const { origin, direction } = ray.ray;
    const { meta, terrain } = this.city;
    // march along the ray until it dips under the terrain, then refine by bisection
    let prevT = 0;
    let prevAbove = true;
    for (let t = 0; t < 90000; t += Math.max(10, t * 0.01)) {
      const x = origin.x + direction.x * t;
      const y = -(origin.z + direction.z * t);
      const h = origin.y + direction.y * t;
      const g = sampleGrid(meta, terrain, x, y);
      const above = h > g;
      if (!above && prevAbove && t > 0) {
        let lo = prevT;
        let hi = t;
        for (let i = 0; i < 18; i++) {
          const mid = (lo + hi) / 2;
          const mx = origin.x + direction.x * mid;
          const my = -(origin.z + direction.z * mid);
          if (origin.y + direction.y * mid > sampleGrid(meta, terrain, mx, my)) lo = mid;
          else hi = mid;
        }
        const px = origin.x + direction.x * hi;
        const py = -(origin.z + direction.z * hi);
        const { x0, y0 } = gridOrigin(meta);
        if (px < x0 || py < y0 || px > x0 + meta.width || py > y0 + meta.height) return null;
        return { x: px, y: py };
      }
      prevT = t;
      prevAbove = above;
    }
    return null;
  }

  flyTo(x: number, y: number, distance = 900) {
    const gz = sampleGrid(this.city.meta, this.city.terrain, x, y);
    const tTo = new THREE.Vector3(x, gz, -y);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (dir.y < 0.35) dir.y = 0.35;
    dir.normalize();
    this.fly = { from: this.camera.position.clone(), to: tTo.clone().add(dir.multiplyScalar(distance)), tFrom: this.controls.target.clone(), tTo, t: 0 };
  }

  flyToPoi(id: string) {
    const p = this.city.meta.pois.find((q) => q.id === id);
    if (p) this.flyTo(p.x, p.y, 650);
  }

  flyToPlace(id: string) {
    const p = this.places.find((q) => q.id === id);
    if (p) this.flyTo(p.x, p.y, 520);
  }

  overview() {
    const c = gridCentre(this.city.meta);
    this.flyTo(c.x, c.y, Math.max(13000, 0.9 * Math.max(this.city.meta.width, this.city.meta.height)));
  }

  get isFinished() {
    return this.finished;
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    this.controls.dispose();
    this.solver.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    this.labels.renderer.domElement.remove();
  }

  private loop = (now: number) => {
    this.raf = requestAnimationFrame(this.loop);
    const realDt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.clock += realDt;
    const s = this.getSettings();
    const { meta } = this.city;
    const L = s.layers;

    // adapt GPU work per frame to keep the UI responsive
    if (realDt > 0.045) this.maxStepsPerFrame = Math.max(4, Math.floor(this.maxStepsPerFrame * 0.85));
    else if (realDt < 0.022) this.maxStepsPerFrame = Math.min(400, Math.ceil(this.maxStepsPerFrame * 1.06));

    const total = totalHours(s.scenario) * HOUR;
    if (this.ffTarget !== null && this.isReady && !this.finished) {
      // run to a target: when going flat out, push the GPU hard (the UI drops to ~20 fps)
      if (this.ffSpeed >= 1e6) this.maxStepsPerFrame = Math.max(this.maxStepsPerFrame, 220);
      this.tickRun(realDt, this.ffSpeed, total);
    } else if (s.playing && !this.finished && this.isReady && !this.viewing) this.advance(realDt, s, total);
    const forcing = sampleForcing(s.scenario, this.simTime);

    const date = new Date(Date.parse(s.scenario.start_time) + this.simTime * 1000);
    const au = this.atmosphere.uniforms;
    this.atmosphere.update(date, meta.origin.lat, meta.origin.lon, forcing.rainMmHr, realDt, !L.realLight, this.simTime);
    this.rain.update(this.camera, L.rain ? forcing.rainMmHr : 0, forcing.windDirDeg, forcing.windSpeedKmh, this.clock, au.uFlash.value, au.uDaylight.value);
    this.water.uniforms.uClock.value = this.clock;
    this.water.setMode(L.waterMode);
    this.buildings.group.visible = L.buildings;
    this.buildings.uniforms.uMode.value = L.impact === 'current' ? 1 : L.impact === 'max' ? 2 : 0;
    this.buildings.uniforms.uHighlight.value = L.highlight ? 1 : 0;
    this.roads.mesh.visible = L.roads;
    this.trees.group.visible = L.trees;
    this.terrain.uniforms.uShowImagery.value = L.imagery ? 1 : 0;
    for (const f of meta.inflows) this.labels.setInflow(f.id, forcing.inflowM3s * f.share);

    if (this.fly) {
      this.fly.t = Math.min(1, this.fly.t + realDt / 1.6);
      const e = this.fly.t < 0.5 ? 4 * this.fly.t ** 3 : 1 - (-2 * this.fly.t + 2) ** 3 / 2;
      this.camera.position.lerpVectors(this.fly.from, this.fly.to, e);
      this.controls.target.lerpVectors(this.fly.tFrom, this.fly.tTo, e);
      if (this.fly.t >= 1) this.fly = null;
    }
    this.controls.update();
    // keep depth precision: near plane scales with height above the ground
    const ground = sampleGrid(meta, this.city.terrain, this.camera.position.x, -this.camera.position.z);
    const agl = Math.max(5, this.camera.position.y - Math.max(ground, meta.elevation.min));
    const near = THREE.MathUtils.clamp(agl * 0.04, 0.5, 60);
    if (Math.abs(near - this.camera.near) > 0.05 * near) {
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
    }
    if (this.camera.position.y < ground + 8) this.camera.position.y = ground + 8;

    if (L.trees) this.trees.update(this.camera, this.clock, forcing.windDirDeg, forcing.windSpeedKmh);
    const casters = `${L.buildings}${L.trees}`;
    if (casters !== this.casters) {
      this.casters = casters;
      this.shadow.invalidate();
    }

    // sun shadows around what the camera is looking at
    const camDist = this.camera.position.distanceTo(this.controls.target);
    const strength = L.shadows ? au.uDaylight.value * (1 - this.atmosphere.storm) ** 1.5 * 0.85 : 0;
    this.shadow.update(this.renderer, this.scene, au.uSunDir.value, this.controls.target, THREE.MathUtils.clamp(camDist * 0.95, 350, 3600), strength);

    for (const l of this.layers) l.beforeRender?.(realDt);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.scene, this.camera);
    for (const l of this.layers) l.afterRender?.(realDt);

    const anyLabels = L.labels || L.places || L.canalNames || L.roadNames || L.keyPlaces;
    if (anyLabels) {
      const key = L.placeCategories.join(',');
      if (key !== this.categoryKey) {
        this.categoryKey = key;
        this.categorySet = new Set(L.placeCategories);
      }
      this.labels.update(this.camera, this.controls.target, {
        landmarks: L.labels,
        localities: L.places,
        canals: L.canalNames,
        roads: L.roadNames,
        places: L.keyPlaces,
        placeCategories: this.categorySet,
      });
      this.labels.render(this.scene, this.camera);
    }
    this.labels.renderer.domElement.style.display = anyLabels ? '' : 'none';

    this.secondTimer += realDt;
    if (this.secondTimer >= 1) {
      this.stepsPerSecond = this.stepsThisSecond / this.secondTimer;
      this.stepsThisSecond = 0;
      this.secondTimer = 0;
    }
    if (now - this.lastRead > 450) this.requestStats(false);
  };

  private advance(realDt: number, s: EngineSettings, total: number, limitT?: number) {
    let want = s.speed * realDt;
    if (this.simTime + want >= total) want = Math.max(0, total - this.simTime);
    if (want <= 0) {
      this.finish();
      return;
    }
    // a fast-forward target only pauses the run; reaching it is not the end of the scenario
    if (limitT !== undefined) want = Math.min(want, limitT - this.simTime);
    if (want <= 0) return;
    // CFL for the local-inertial scheme; porosity speeds waves up (c = √(g·h/φ)), and depths can
    // grow between readbacks, so keep a margin
    const dtMax = THREE.MathUtils.clamp((0.6 * this.city.meta.cell) / (this.waveSpeed * 1.25), 0.05, 6);
    let steps = Math.ceil(want / dtMax);
    let dt = want / steps;
    if (steps > this.maxStepsPerFrame) {
      steps = this.maxStepsPerFrame;
      dt = dtMax;
    }
    const f = sampleForcing(s.scenario, this.simTime);
    const advanceBy = dt * steps;
    this.rainField.update(f, this.simTime, advanceBy);
    const sources = this.city.meta.inflows.map((inf) => ({ x: inf.x, y: inf.y, m3s: f.inflowM3s * inf.share, halfWidth: 4, channelOnly: true }));
    for (const sg of f.surges) sources.push({ x: sg.x, y: sg.y, m3s: sg.m3s, halfWidth: 1, channelOnly: false });
    // regulators that follow an operating rule release a share of the river flow reaching them
    for (const r of this.solver.regulators) {
      if (!r.release) continue;
      const q = (ids: string[]) => this.city.meta.inflows.reduce((sum, inf) => sum + (ids.includes(inf.id) ? f.inflowM3s * inf.share : 0), 0);
      this.solver.setRegulatorCap(r.id, Math.min(r.capM3s, r.release.fraction * q(r.release.of) + q(r.release.plus ?? [])));
    }
    // drained storm water re-enters the canal network
    this.solver.channelInject = this.solver.channelCells > 0 ? this.drainRateM3s / (this.solver.channelCells * this.city.meta.cell ** 2) : 0;
    this.solver.step(dt, steps, {
      rainMs: f.rainMmHr / 3.6e6,
      infilMs: f.infiltrationMmHr / 3.6e6,
      drainMs: (f.drainageMmHr * this.drainEff) / 3.6e6,
      lakeStage: outletStage(f.lakeLevelM, f.inflowM3s, this.city.meta),
      sources,
    });
    this.stateUniform.value = this.solver.stateTexture;
    this.fluxUniform.value = this.solver.fluxTexture;
    this.simTime += advanceBy;
    this.cumRainMm += (f.rainMmHr * advanceBy) / HOUR;
    this.stepsThisSecond += steps;
    this.lastDt = dt;
    if (this.simTime >= total - 1e-6) this.finish();
  }

  private finish() {
    if (this.finished) return;
    this.finished = true;
    this.captureFinal = true;
    this.requestStats(true);
    this.cb.onFinished();
  }

  private requestStats(forceSeries: boolean) {
    if (this.readPending) {
      // a forced read (end of run, end of a fast-forward, reset) must not be lost behind a routine one
      if (forceSeries) this.statsQueued = true;
      return;
    }
    this.readPending = true;
    this.lastRead = performance.now();
    const t = this.simTime;
    const f = sampleForcing(this.getSettings().scenario, t);
    this.solver
      .readState(this.readBuf)
      .then((buf) => this.computeStats(buf, t, f.rainMmHr, f.inflowM3s, f.phaseIndex, f.drainageMmHr, forceSeries))
      .catch(() => undefined)
      .finally(() => {
        this.readPending = false;
        if (this.statsQueued) {
          this.statsQueued = false;
          this.requestStats(true);
        }
      });
  }

  private computeStats(buf: Float32Array, t: number, rain: number, inflow: number, phaseIndex: number, drainMmHr: number, forceSeries: boolean) {
    const { meta } = this.city;
    const a = meta.cell * meta.cell;
    let flooded = 0;
    let deep = 0;
    let severe = 0;
    let maxD = 0;
    let c2 = G * 2; // squared wave speed; channels are always at least this lively
    let vol = 0;
    let drainCells = 0;
    let fillSum = 0;
    let fillN = 0;
    const n = meta.nx * meta.ny;
    const lc = this.city.landcover;
    for (let id = 0; id < n; id++) {
      const h = buf[id * 4];
      const g = lc[id * 4 + 1];
      if (g > 10) {
        // canal cells deeper than 0.5 m: how full is the network?
        fillSum += Math.min(1.5, h / (g * 0.05));
        fillN++;
      }
      if (h > 0.01) {
        const c = (G * h) / this.porosity[id];
        if (c > c2) c2 = c;
      }
      if (this.permanentWater[id]) continue;
      if (h > 0.003) drainCells += this.imperv[id];
      // a basin that is dry in dry weather fills up in rain; only water over its rim is a flood
      const over = h - this.storage[id];
      if (over <= 0.1) continue;
      flooded++;
      if (over > 0.5) deep++;
      if (over > 1.5) severe++;
      if (over > maxD && this.imperv[id] > 0.15) maxD = over; // deepest water where people live
      vol += over * this.porosity[id] * a;
    }
    this.waveSpeed = Math.sqrt(c2);
    // storm drains outfall into the canals: once those run near bank-full the drains back up
    this.canalFill = fillN ? fillSum / fillN : 0;
    this.drainEff = THREE.MathUtils.clamp(1 - (this.canalFill - 0.5) / 0.35, 0.05, 1);
    this.drainRateM3s = (drainCells * a * drainMmHr * this.drainEff) / 3.6e6;

    let affected = 0;
    let bSevere = 0;
    const cc = this.buildings.centroidCell;
    for (let b = 0; b < cc.length; b++) {
      if (this.permanentWater[cc[b]]) continue; // stilt houses over canals/ponds are always "wet"
      const h = buf[cc[b] * 4] - this.storage[cc[b]];
      if (h > 0.3) affected++;
      if (h > 1.5) bSevere++;
    }

    const pois = this.poiCells.map((p) => {
      let d = 0;
      for (const c of p.cells) d = Math.max(d, buf[c * 4]);
      const m = Math.max(this.poiMax.get(p.id) ?? 0, d);
      this.poiMax.set(p.id, m);
      this.labels.setPoiDepth(p.id, d, m);
      return { id: p.id, name: p.name, depth: d, maxDepth: m };
    });

    const im = this.impact;
    for (let i = 0; i < this.placeCells.length; i++) {
      let d = 0;
      for (const c of this.placeCells[i]) d = Math.max(d, buf[c * 4]);
      im.depth[i] = d;
      if (d > im.maxDepth[i]) im.maxDepth[i] = d;
      if (d >= 0.1 && im.firstWet[i] < 0) im.firstWet[i] = t / HOUR;
    }
    this.labels.setPlaceDepths(im.depth);
    this.cb.onPlaceImpact(im);

    const gauges = this.gaugeCells.map((g) => {
      let level = 0;
      for (const c of g.cells) level += this.city.terrain[c] + buf[c * 4];
      return { id: g.id, code: g.code, level: level / g.cells.length };
    });

    const stats: LiveStats = {
      simTime: t,
      phaseIndex,
      rainMmHr: rain,
      cumulativeRainMm: this.cumRainMm,
      inflowM3s: inflow,
      floodedKm2: (flooded * a) / 1e6,
      deepKm2: (deep * a) / 1e6,
      severeKm2: (severe * a) / 1e6,
      maxDepth: maxD,
      volumeM3: vol,
      buildingsAffected: affected,
      buildingsSevere: bSevere,
      pois,
      gauges,
      stepsPerSecond: this.stepsPerSecond,
      dt: this.lastDt,
      drainEfficiency: this.drainEff,
      canalFill: this.canalFill,
    };
    this.cb.onStats(stats);

    // end-of-day snapshots for the day-by-day viewer
    const key = this.dayKey(t);
    if (this.currentDay === null) this.currentDay = key;
    if (key !== this.currentDay || this.captureFinal) {
      const closing = key !== this.currentDay ? this.currentDay : key;
      const depth = new Float32Array(meta.nx * meta.ny);
      for (let i = 0; i < depth.length; i++) depth[i] = buf[i * 4];
      this.days = [...this.days.filter((d) => d.key !== closing), { key: closing, depth }].slice(-MAX_DAYS);
      this.cb.onDaySnapshot({ key: closing, t, floodedKm2: stats.floodedKm2, buildings: affected, maxDepth: maxD });
      this.currentDay = key;
      if (this.captureFinal && key === closing) this.captureFinal = false;
    }
    if (forceSeries || t - this.lastSeriesT >= 600) {
      this.lastSeriesT = t;
      this.cb.onSeriesPoint({
        t,
        rain,
        cumRain: this.cumRainMm,
        area: stats.floodedKm2,
        deep: stats.deepKm2,
        maxDepth: maxD,
        volume: vol,
        inflow,
        buildings: affected,
        gauges: Object.fromEntries(gauges.map((g) => [g.id, g.level])),
      });
    }
  }
}
