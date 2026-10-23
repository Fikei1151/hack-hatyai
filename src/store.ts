import { create } from 'zustand';
import type { CityData, Place, PlaceCategory } from './engine/cityData';
import type { DaySummary, Engine, Layers, PlaceImpact } from './engine/Engine';
import { dayScenario, fetchOutlook, outlookScenario, type Outlook } from './sim/forecast';
import { rainLabScenario, type RainLabOptions } from './sim/rainlab';
import * as repo from './lib/repository';
import { syntheticPresets } from './sim/presets';
import { bankPoints, randomScenario } from './sim/random';
import { fetchForecastForcing, fetchHistoricalForcing, fetchLiveStatus, phasesFromHourly, scenarioFromEvent, type EventRecord, type LiveStatus } from './sim/realdata';
import { randomSeed } from './sim/rng';
import { cloneScenario, makePhase, totalHours } from './sim/scenario';
import type { LiveStats, Phase, Scenario, SeriesPoint } from './sim/types';

let engine: Engine | null = null;
/** history row of the rain-lab run that just finished, still taking its final readback */
let openLabResult: string | null = null;
export const setEngine = (e: Engine | null) => (engine = e);
export const getEngine = () => engine;

/** Playback speeds; 1x = 30 simulated minutes per real second. */
export const SPEEDS = [
  { value: 600, label: '⅓x', hint: '10 นาทีต่อวินาที — ดูน้ำไหลช้า ๆ' },
  { value: 1800, label: '1x', hint: '30 นาทีต่อวินาที' },
  { value: 5400, label: '3x', hint: '1.5 ชั่วโมงต่อวินาที' },
  { value: 18000, label: '10x', hint: '5 ชั่วโมงต่อวินาที (เร็วสุดเท่าที่ GPU ทำได้)' },
];

export const ALL_CATEGORIES: PlaceCategory[] = ['health', 'emergency', 'shelter', 'community', 'education', 'religion', 'market', 'government', 'transport', 'landmark', 'lodging', 'shop', 'fuel', 'finance'];
/** shown on the map by default; the busier everyday categories are one click away */
export const DEFAULT_CATEGORIES: PlaceCategory[] = ['health', 'emergency', 'shelter', 'community', 'education', 'religion', 'market', 'government', 'transport', 'landmark'];

export interface ImpactSnapshot {
  depth: Float32Array;
  maxDepth: Float32Array;
  firstWet: Float32Array;
}

type Toast = { text: string; kind: 'info' | 'error' | 'ok' } | null;

interface Peaks {
  area: number;
  depth: number;
  volume: number;
  buildings: number;
  pois: Record<string, number>;
}

export interface LabResult {
  id: string;
  intensity: number;
  hours: number;
  pattern: string;
  river: string;
  drainsBlocked: boolean;
  areaKm2: number;
  buildings: number;
  maxDepth: number;
}

const WELCOME_KEY = 'hatyai.welcome.v1';
function welcomeSeen() {
  try {
    return localStorage.getItem(WELCOME_KEY) === '1';
  } catch {
    return false;
  }
}

interface AppState {
  city: CityData | null;
  events: EventRecord[];
  load: { stage: string; progress: number; error?: string };
  scenario: Scenario;
  dirty: boolean;
  selectedPhase: number | null;
  playing: boolean;
  speed: number;
  finished: boolean;
  stats: LiveStats | null;
  series: SeriesPoint[];
  peaks: Peaks;
  layers: Layers;
  db: repo.DbMode;
  saved: repo.ScenarioSummary[];
  runs: repo.RunRecord[];
  runId: string | null;
  live: LiveStatus | null;
  liveError: string | null;
  busy: string | null;
  toast: Toast;
  /** 'game' = the rescue board game owns the screen */
  mode: 'sim' | 'game';
  setMode: (m: 'sim' | 'game') => void;
  panel: 'rainlab' | 'forecast' | 'scenario' | 'places' | 'runs' | 'live';
  days: DaySummary[];
  viewingDay: string | null;
  ffActive: boolean;
  outlook: Outlook | null;
  outlookError: string | null;
  outlookLoading: boolean;
  labHistory: LabResult[];
  showWelcome: boolean;
  onDaySnapshot: (d: DaySummary) => void;
  onFastForwardDone: () => void;
  viewDay: (key: string | null) => void;
  nextDay: () => void;
  loadOutlook: (force?: boolean) => Promise<void>;
  simulateDay: (dayIndex: number, variant: 'mean' | 'p90') => void;
  simulateOutlook: () => void;
  runRainLab: (o: RainLabOptions) => void;
  dismissWelcome: () => void;
  places: Place[];
  placesSource: 'city' | 'supabase';
  impact: ImpactSnapshot | null;
  engineReady: boolean;
  setEngineReady: (v: boolean) => void;

  setCity: (c: CityData, events: EventRecord[]) => void;
  setLoad: (stage: string, progress: number, error?: string) => void;
  initDb: () => Promise<void>;
  setScenario: (s: Scenario, opts?: { keepDirty?: boolean }) => void;
  patchScenario: (p: Partial<Scenario>) => void;
  patchSettings: (p: Partial<Scenario['settings']>) => void;
  selectPhase: (i: number | null) => void;
  updatePhase: (i: number, p: Partial<Phase>) => void;
  addPhase: (after: number) => void;
  duplicatePhase: (i: number) => void;
  removePhase: (i: number) => void;
  movePhase: (i: number, dir: -1 | 1) => void;
  play: () => void;
  pause: () => void;
  resetSim: () => void;
  setSpeed: (v: number) => void;
  setLayer: <K extends keyof Layers>(k: K, v: Layers[K]) => void;
  onStats: (s: LiveStats) => void;
  onSeriesPoint: (p: SeriesPoint) => void;
  onFinished: () => void;
  saveCurrent: () => Promise<void>;
  loadSaved: (id: string) => Promise<void>;
  deleteSaved: (id: string) => Promise<void>;
  randomize: (seed?: number) => void;
  loadForecast: () => Promise<void>;
  loadHistorical: (date: string, days: number) => Promise<void>;
  loadEvent: (id: string) => Promise<void>;
  refreshLists: () => Promise<void>;
  deleteRun: (id: string) => Promise<void>;
  refreshLive: () => Promise<void>;
  setPanel: (p: AppState['panel']) => void;
  notify: (text: string, kind?: 'info' | 'error' | 'ok') => void;
  onPlaceImpact: (im: PlaceImpact) => void;
  toggleCategory: (c: PlaceCategory) => void;
}

const emptyPeaks = (): Peaks => ({ area: 0, depth: 0, volume: 0, buildings: 0, pois: {} });

const placeholder: Scenario = {
  name: 'กำลังโหลด…',
  description: '',
  source: 'custom',
  seed: 1,
  start_time: new Date().toISOString(),
  settings: {},
  phases: [makePhase({ name: 'ฝนปานกลาง', rain_mm_hr: 10 })],
};

let lastRunSync = 0;

export const useApp = create<AppState>((set, get) => ({
  city: null,
  events: [],
  load: { stage: 'เริ่มต้น', progress: 0 },
  scenario: placeholder,
  dirty: false,
  selectedPhase: null,
  playing: false,
  speed: 1800, // 1x
  finished: false,
  stats: null,
  series: [],
  peaks: emptyPeaks(),
  layers: {
    buildings: true,
    imagery: true,
    roads: true,
    trees: true,
    rain: true,
    shadows: true,
    labels: true,
    places: false,
    canalNames: true,
    roadNames: true,
    keyPlaces: true,
    placeCategories: DEFAULT_CATEGORIES,
    highlight: true,
    waterMode: 'realistic',
    impact: 'off',
    realLight: true,
  },
  db: 'checking',
  saved: [],
  runs: [],
  runId: null,
  live: null,
  liveError: null,
  busy: null,
  toast: null,
  mode: 'sim',
  setMode: (m) => set({ mode: m }),
  panel: 'rainlab',
  days: [],
  viewingDay: null,
  ffActive: false,
  outlook: null,
  outlookError: null,
  outlookLoading: false,
  labHistory: [],
  showWelcome: !welcomeSeen(),
  places: [],
  placesSource: 'city',
  impact: null,
  engineReady: false,
  setEngineReady: (v) => set({ engineReady: v }),

  setCity: (city, events) => set({ city, events, places: city.places }),
  setLoad: (stage, progress, error) => set({ load: { stage, progress, error } }),

  initDb: async () => {
    const mode = await repo.connect();
    set({ db: mode });
    // important places: the Supabase table is the source of truth when it is reachable
    try {
      const dbPlaces = await repo.loadPlaces();
      if (dbPlaces.length) {
        set({ places: dbPlaces, placesSource: 'supabase' });
        engine?.setPlaces(dbPlaces);
      }
    } catch {
      /* keep the places shipped with the city build */
    }
    const { city, events } = get();
    const presets = [...events.map(scenarioFromEvent), ...syntheticPresets(city ? bankPoints(city.waterways) : [])];
    try {
      await repo.syncPresets(presets);
    } catch (e) {
      get().notify(`ซิงก์สถานการณ์ตั้งต้นไม่สำเร็จ: ${(e as Error).message}`, 'error');
    }
    await get().refreshLists();
    // open the 2025 replay by default (stored copy if present so edits persist)
    const first = get().saved.find((s) => s.slug === 'event-2025-11');
    if (first) await get().loadSaved(first.id);
    else if (presets[0]) get().setScenario(presets[0]);
  },

  setScenario: (s, opts) => {
    set({ scenario: s, dirty: Boolean(opts?.keepDirty), selectedPhase: null });
    get().resetSim();
  },
  patchScenario: (p) => set((st) => ({ scenario: { ...st.scenario, ...p }, dirty: true })),
  patchSettings: (p) => set((st) => ({ scenario: { ...st.scenario, settings: { ...st.scenario.settings, ...p } }, dirty: true })),
  selectPhase: (i) => set({ selectedPhase: i }),
  updatePhase: (i, p) =>
    set((st) => {
      const phases = st.scenario.phases.slice();
      phases[i] = { ...phases[i], ...p };
      return { scenario: { ...st.scenario, phases }, dirty: true };
    }),
  addPhase: (after) =>
    set((st) => {
      const phases = st.scenario.phases.slice();
      const base = phases[after] ?? phases[phases.length - 1];
      const np = makePhase(base ? { ...base, id: undefined as unknown as string, events: [], name: 'เฟสใหม่' } : {});
      np.id = crypto.randomUUID();
      phases.splice(after + 1, 0, np);
      return { scenario: { ...st.scenario, phases }, dirty: true, selectedPhase: after + 1 };
    }),
  duplicatePhase: (i) =>
    set((st) => {
      const phases = st.scenario.phases.slice();
      phases.splice(i + 1, 0, { ...JSON.parse(JSON.stringify(phases[i])), id: crypto.randomUUID(), name: `${phases[i].name} (สำเนา)` });
      return { scenario: { ...st.scenario, phases }, dirty: true, selectedPhase: i + 1 };
    }),
  removePhase: (i) =>
    set((st) => {
      if (st.scenario.phases.length <= 1) return {};
      const phases = st.scenario.phases.filter((_, k) => k !== i);
      return { scenario: { ...st.scenario, phases }, dirty: true, selectedPhase: null };
    }),
  movePhase: (i, dir) =>
    set((st) => {
      const j = i + dir;
      const phases = st.scenario.phases.slice();
      if (j < 0 || j >= phases.length) return {};
      [phases[i], phases[j]] = [phases[j], phases[i]];
      return { scenario: { ...st.scenario, phases }, dirty: true, selectedPhase: j };
    }),

  play: () => {
    const st = get();
    if (!engine) return;
    if (st.finished || engine.isFinished) {
      st.resetSim();
    }
    if (get().viewingDay) {
      engine.viewDay(null);
      set({ viewingDay: null });
    }
    set({ playing: true });
    if (!get().runId) {
      const snapshot = cloneScenario(get().scenario);
      repo
        .createRun(snapshot, get().city?.meta.cell ?? 20)
        .then((id) => set({ runId: id }))
        .catch((e) => get().notify(`บันทึกการรันไม่สำเร็จ: ${(e as Error).message}`, 'error'));
    }
  },
  pause: () => {
    set({ playing: false });
    syncRun(get, false);
  },
  resetSim: () => {
    openLabResult = null;
    const prev = get().runId;
    if (prev && engine && engine.simTime > 0 && !get().finished) syncRun(get, true, 'stopped');
    engine?.reset();
    set({ playing: false, finished: false, stats: null, series: [], peaks: emptyPeaks(), runId: null, days: [], viewingDay: null, ffActive: false });
  },
  setSpeed: (v) => set({ speed: v }),
  setLayer: (k, v) => set((st) => ({ layers: { ...st.layers, [k]: v } })),

  onStats: (s) =>
    set((st) => {
      const pois = { ...st.peaks.pois };
      for (const p of s.pois) pois[p.id] = Math.max(pois[p.id] ?? 0, p.maxDepth);
      const peaks: Peaks = {
        area: Math.max(st.peaks.area, s.floodedKm2),
        depth: Math.max(st.peaks.depth, s.maxDepth),
        volume: Math.max(st.peaks.volume, s.volumeM3),
        buildings: Math.max(st.peaks.buildings, s.buildingsAffected),
        pois,
      };
      if (st.playing && performance.now() - lastRunSync > 8000) queueMicrotask(() => syncRun(get, false));
      // the last readback of a finished rain-lab run lands after onFinished: keep its history row current
      let labHistory = st.labHistory;
      if (st.finished && openLabResult && labHistory[0]?.id === openLabResult)
        labHistory = [{ ...labHistory[0], areaKm2: peaks.area, buildings: peaks.buildings, maxDepth: peaks.depth }, ...labHistory.slice(1)];
      return { stats: s, peaks, labHistory };
    }),
  onSeriesPoint: (p) => set((st) => ({ series: [...st.series, p] })),
  onFinished: () => {
    set({ playing: false, finished: true, ffActive: false });
    const lab = get().scenario.settings.rain_lab;
    if (lab) {
      const pk = get().peaks;
      openLabResult = crypto.randomUUID();
      set((st) => ({
        labHistory: [
          { id: openLabResult as string, intensity: lab.intensity, hours: lab.hours, pattern: lab.pattern, river: lab.river, drainsBlocked: lab.drainsBlocked, areaKm2: pk.area, buildings: pk.buildings, maxDepth: pk.depth },
          ...st.labHistory,
        ].slice(0, 8),
      }));
    }
    setTimeout(() => {
      syncRun(get, true, 'completed');
      const { runId, impact, places } = get();
      if (runId && impact) {
        const rows = places
          .map((p, i) => ({ run_id: runId, place_id: p.id, max_depth_m: Math.round(impact.maxDepth[i] * 100) / 100, first_wet_hours: impact.firstWet[i] >= 0 ? Math.round(impact.firstWet[i] * 10) / 10 : null }))
          .filter((r) => r.max_depth_m >= 0.1);
        repo.saveRunImpacts(rows).catch(() => undefined);
      }
    }, 600);
    get().notify('จำลองครบทุกเฟสแล้ว — บันทึกผลลงฐานข้อมูล', 'ok');
  },

  saveCurrent: async () => {
    let s = get().scenario;
    // built-in scenarios stay pristine (they are refreshed when their data changes): save edits as a copy
    if (s.slug && (s.source === 'preset' || s.source === 'historical')) {
      s = { ...s, id: undefined, slug: undefined, source: 'custom', name: `${s.name} (ฉบับแก้ไข)`, settings: { ...s.settings, preset_version: undefined } };
    }
    set({ busy: 'กำลังบันทึก…' });
    try {
      const id = await repo.saveScenario(s);
      set({ scenario: { ...s, id }, dirty: false });
      await get().refreshLists();
      get().notify(get().db === 'supabase' ? 'บันทึกลง Supabase แล้ว' : 'บันทึกในเบราว์เซอร์แล้ว (ออฟไลน์)', 'ok');
    } catch (e) {
      get().notify(`บันทึกไม่สำเร็จ: ${(e as Error).message}`, 'error');
    } finally {
      set({ busy: null });
    }
  },
  loadSaved: async (id) => {
    try {
      const s = await repo.loadScenario(id);
      get().setScenario(s);
    } catch (e) {
      get().notify(`โหลดไม่สำเร็จ: ${(e as Error).message}`, 'error');
    }
  },
  deleteSaved: async (id) => {
    try {
      await repo.deleteScenario(id);
      if (get().scenario.id === id) set((st) => ({ scenario: { ...st.scenario, id: undefined, slug: undefined }, dirty: true }));
      await get().refreshLists();
    } catch (e) {
      get().notify(`ลบไม่สำเร็จ: ${(e as Error).message}`, 'error');
    }
  },
  randomize: (seed) => {
    const city = get().city;
    const s = randomScenario(seed ?? randomSeed(), city ? bankPoints(city.waterways) : []);
    get().setScenario(s, { keepDirty: true });
    get().notify(`สุ่มสถานการณ์ใหม่: ${s.name}`, 'info');
  },
  loadForecast: async () => {
    set({ busy: 'กำลังดึงพยากรณ์อากาศและน้ำท่า…' });
    try {
      const f = await repo.cached(`forecast:${new Date().toISOString().slice(0, 13)}`, 3, fetchForecastForcing);
      const phases = phasesFromHourly(f, { minHours: 3, maxHours: 12 });
      const total = f.rainMmHr.reduce((a, b) => a + b, 0);
      get().setScenario(
        {
          name: `พยากรณ์ 7 วันข้างหน้า (${new Date(f.start).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })})`,
          description: `ฝนพยากรณ์รวม ${total.toFixed(0)} มม. จาก Open-Meteo · ${f.note}`,
          source: 'forecast',
          seed: randomSeed(),
          start_time: f.start,
          settings: { initial_inflow_m3s: Math.round(f.inflowM3s[0]), initial_lake_m: f.lakeM[0] },
          phases,
        },
        { keepDirty: true },
      );
      get().notify('สร้างสถานการณ์จากพยากรณ์จริงแล้ว', 'ok');
    } catch (e) {
      get().notify(`ดึงพยากรณ์ไม่สำเร็จ: ${(e as Error).message}`, 'error');
    } finally {
      set({ busy: null });
    }
  },
  loadHistorical: async (date, days) => {
    set({ busy: 'กำลังดึงข้อมูลย้อนหลัง (ThaiWater + ERA5)…' });
    try {
      const f = await repo.cached(`historical:${date}:${days}`, 24 * 365, () => fetchHistoricalForcing(date, days));
      const phases = phasesFromHourly(f);
      const total = f.rainMmHr.reduce((a, b) => a + b, 0);
      get().setScenario(
        {
          name: `ย้อนเหตุการณ์ ${new Date(date).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' })} (${days} วัน)`,
          description: `ฝนรวม ${total.toFixed(0)} มม. · ${f.note}`,
          source: 'historical',
          seed: randomSeed(),
          start_time: f.start,
          settings: { initial_inflow_m3s: Math.round(f.inflowM3s[0]), initial_lake_m: f.lakeM[0] },
          phases,
        },
        { keepDirty: true },
      );
      get().notify('สร้างสถานการณ์จากข้อมูลจริงแล้ว', 'ok');
    } catch (e) {
      get().notify(`ดึงข้อมูลย้อนหลังไม่สำเร็จ: ${(e as Error).message}`, 'error');
    } finally {
      set({ busy: null });
    }
  },
  loadEvent: async (id) => {
    const e = get().events.find((x) => x.id === id);
    if (!e) return;
    const stored = get().saved.find((s) => s.slug === `event-${id}`);
    if (stored) await get().loadSaved(stored.id);
    else get().setScenario(scenarioFromEvent(e));
  },
  refreshLists: async () => {
    try {
      const [saved, runs] = await Promise.all([repo.listScenarios(), repo.listRuns(25)]);
      set({ saved, runs });
    } catch (e) {
      get().notify(`อ่านฐานข้อมูลไม่สำเร็จ: ${(e as Error).message}`, 'error');
    }
  },
  deleteRun: async (id) => {
    await repo.deleteRun(id).catch(() => undefined);
    await get().refreshLists();
  },
  refreshLive: async () => {
    try {
      const live = await fetchLiveStatus();
      set({ live, liveError: null });
    } catch (e) {
      set({ liveError: (e as Error).message });
    }
  },
  setPanel: (p) => set({ panel: p }),
  onDaySnapshot: (d) => set((st) => ({ days: [...st.days.filter((x) => x.key !== d.key), d].sort((a, b) => a.key.localeCompare(b.key)) })),
  onFastForwardDone: () => set({ ffActive: false }),
  viewDay: (key) => {
    engine?.viewDay(key);
    set({ viewingDay: key, playing: key ? false : get().playing });
  },
  nextDay: () => {
    if (!engine) return;
    if (get().viewingDay) set({ viewingDay: null });
    if (engine.fastForwardToNextDay()) {
      set({ ffActive: true, playing: false });
      if (!get().runId) {
        repo
          .createRun(cloneScenario(get().scenario), get().city?.meta.cell ?? 20)
          .then((id) => set({ runId: id }))
          .catch(() => undefined);
      }
    }
  },
  loadOutlook: async (force) => {
    set({ outlookLoading: true, outlookError: null });
    try {
      const key = `outlook:${new Date().toISOString().slice(0, 13)}${force ? `:${Date.now()}` : ''}`;
      const o = await repo.cached(key, 3, fetchOutlook);
      set({ outlook: o });
    } catch (e) {
      set({ outlookError: (e as Error).message });
    } finally {
      set({ outlookLoading: false });
    }
  },
  simulateDay: (dayIndex, variant) => {
    const o = get().outlook;
    if (!o) return;
    get().setScenario(dayScenario(o, dayIndex, variant), { keepDirty: true });
    set({ speed: 1800 });
    get().play();
  },
  simulateOutlook: () => {
    const o = get().outlook;
    if (!o) return;
    get().setScenario(outlookScenario(o), { keepDirty: true });
    set({ speed: 5400 });
    get().play();
  },
  runRainLab: (o) => {
    get().setScenario(rainLabScenario(o), { keepDirty: true });
    set({ speed: 5400 });
    get().play();
  },
  dismissWelcome: () => {
    set({ showWelcome: false });
    try {
      localStorage.setItem(WELCOME_KEY, '1');
    } catch {
      /* private mode: it will just show again next time */
    }
  },
  onPlaceImpact: (im) => set({ impact: { depth: Float32Array.from(im.depth), maxDepth: Float32Array.from(im.maxDepth), firstWet: Float32Array.from(im.firstWet) } }),
  toggleCategory: (c) =>
    set((st) => {
      const has = st.layers.placeCategories.includes(c);
      return { layers: { ...st.layers, placeCategories: has ? st.layers.placeCategories.filter((x) => x !== c) : [...st.layers.placeCategories, c] } };
    }),
  notify: (text, kind = 'info') => {
    set({ toast: { text, kind } });
    const t = text;
    setTimeout(() => {
      if (get().toast?.text === t) set({ toast: null });
    }, 4200);
  },
}));

function syncRun(get: () => AppState, final: boolean, status?: 'completed' | 'stopped') {
  const st = get();
  if (!st.runId || !engine) return;
  lastRunSync = performance.now();
  const patch: repo.RunPatch = {
    sim_hours: engine.simTime / 3600,
    total_rain_mm: Math.round(engine.cumRainMm * 10) / 10,
    peak_flood_area_km2: st.peaks.area,
    peak_depth_m: st.peaks.depth,
    peak_volume_m3: st.peaks.volume,
    buildings_affected: st.peaks.buildings,
    poi_peaks: st.peaks.pois,
    timeseries: st.series,
  };
  if (final) {
    patch.status = status ?? 'completed';
    patch.finished_at = new Date().toISOString();
  }
  repo
    .updateRun(st.runId, patch)
    .then(() => (final ? st.refreshLists() : undefined))
    .catch(() => undefined);
}

export const scenarioHours = (s: Scenario) => totalHours(s);
