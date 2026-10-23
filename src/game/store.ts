import { create } from 'zustand';
import * as repo from '../lib/repository';
import { cloneScenario } from '../sim/scenario';
import { randomSeed } from '../sim/rng';
import { getEngine, useApp } from '../store';
import { GameLayer } from './layer';
import {
  act as actRule,
  beginRound,
  endTurn as endTurnRule,
  executeMove,
  floodView,
  newGame,
  planMove,
  resolveFlood,
  savedPeople,
  stars,
  startActions,
  suggest,
  treeFor,
  vehicleFor,
  type DiceRoll,
  type GameState,
  type MoveReport,
  type Phase,
  type Plan,
  type ResolveReport,
  type WeatherPatch,
} from './rules';
import type { RoleId } from './roles';
import { gameStartIso, type Difficulty } from './storm';
import { getWorld, type GameWorld } from './world';

export interface SetupForm {
  teams: { name: string; role: RoleId }[];
  difficulty: Difficulty;
  rounds: number;
  seed: number;
}

export interface Toast {
  id: number;
  emoji: string;
  text: string;
  tone: 'info' | 'good' | 'bad';
}

type Modal = null | 'event' | 'resolve' | 'help' | 'quit';

interface GameStore {
  screen: 'setup' | 'play' | 'result';
  form: SetupForm;
  state: GameState | null;
  world: GameWorld | null;
  /** bumps whenever `state` was mutated (the state object itself is mutated in place) */
  rev: number;
  busy: null | 'loading' | 'moving' | 'flood';
  floodPct: number;
  modal: Modal;
  resolve: ResolveReport | null;
  preview: Plan | null;
  pinned: number | null;
  hint: string | null;
  hover: { x: number; y: number } | null;
  dice: { team: string; rolls: DiceRoll[] } | null;
  toasts: Toast[];
  watch: boolean;
  realLight: boolean;
  /** red dots on roads the active team cannot cross */
  showCut: boolean;
  /** how fast this device runs the flood model: milliseconds per solver step */
  bench: number | null;
  best: repo.GameResult[];
  setForm: (p: Partial<SetupForm>) => void;
  open: () => void;
  close: () => void;
  loadBest: () => Promise<void>;
  start: (seed?: number) => Promise<void>;
  setModal: (m: Modal) => void;
  beginActions: () => void;
  clickNode: (node: number | null) => void;
  hoverNode: (node: number | null, px: number, py: number) => void;
  clearPin: () => void;
  confirm: () => Promise<void>;
  actHere: () => void;
  askHint: () => void;
  endTurn: () => void;
  skipFlood: () => void;
  nextRound: () => void;
  toggleWatch: () => void;
  toggleLight: () => void;
  toggleCut: () => void;
  onFloodDone: () => Promise<void>;
  toast: (emoji: string, text: string, tone?: Toast['tone']) => void;
}

/** simulated seconds per real second while the water is rising on screen */
const FLOOD_WATCH_SPEED = 2400;

/** the phase, read without TypeScript's narrowing (rules mutate the state in place) */
const phaseOf = (s: GameState): Phase => s.phase;

let layer: GameLayer | null = null;
let savedLayers: ReturnType<typeof useApp.getState>['layers'] | null = null;
let floodTimer = 0;
let resolving = false;
let toastId = 1;
let lastHover = -2;

const defaultForm = (): SetupForm => ({
  teams: [
    { name: 'ทีมส้ม', role: 'rescue' },
    { name: 'ทีมฟ้า', role: 'boat' },
  ],
  difficulty: 'normal',
  rounds: 8,
  seed: randomSeed() % 100000,
});

export const useGame = create<GameStore>((set, get) => {
  const bump = () => set((s) => ({ rev: s.rev + 1 }));

  const sync = () => {
    const { state, world } = get();
    if (!state || !world || !layer) return;
    layer.setState(state, state.phase === 'action' ? state.active : null);
    const team = state.teams[state.active];
    layer.setCut(world.graph, state.regionEdges, floodView(state), vehicleFor(team), get().showCut && state.phase !== 'flood' && state.phase !== 'over');
    refreshReach();
  };

  const refreshReach = () => {
    const { state, world } = get();
    if (!state || !world || !layer) return;
    if (state.phase !== 'action' || get().busy) {
      layer.setReach(world.graph, null, 0, '#000000');
      return;
    }
    const team = state.teams[state.active];
    layer.setReach(world.graph, treeFor(state, world, team), team.mp, team.color);
  };

  const showPlan = (node: number | null, pin: boolean) => {
    const { state, world } = get();
    if (!state || !world || !layer) return;
    const team = state.teams[state.active];
    const plan = node === null ? null : planMove(state, world, state.active, node);
    layer.setRoute(world.graph, plan, team.color);
    if (pin) layer.setTarget(plan ? node : null);
    set({ preview: plan, ...(pin ? { pinned: plan ? node : null } : {}) });
    // frame the team and its target together so neither hides behind a panel
    const eng = getEngine();
    if (pin && plan && eng && node !== null) {
      const ax = world.graph.x[team.node];
      const ay = world.graph.y[team.node];
      const bx = world.graph.x[node];
      const by = world.graph.y[node];
      // the free middle of the screen is only ~40% wide (the panels cover the rest)
      eng.flyTo((ax + bx) / 2, (ay + by) / 2, Math.min(12000, Math.max(1800, Math.hypot(ax - bx, ay - by) * 3 + 900)));
    }
  };

  const applyPatches = (patches: WeatherPatch[]) => {
    if (!patches.length) return;
    const sc = cloneScenario(useApp.getState().scenario);
    for (const p of patches) {
      const ph = sc.phases[p.round - 1];
      if (!ph) continue;
      if (p.rainMul) ph.rain_mm_hr = Math.round(ph.rain_mm_hr * p.rainMul * 10) / 10;
      if (p.inflowMul) {
        ph.upstream_inflow_m3s = Math.round(ph.upstream_inflow_m3s * p.inflowMul);
        const next = sc.phases[p.round];
        if (next) next.upstream_inflow_m3s = Math.round(next.upstream_inflow_m3s * p.inflowMul);
      }
      if (p.lakeAdd) ph.lake_level_m += p.lakeAdd;
      if (p.drainMul) ph.drainage_mm_hr = Math.round(ph.drainage_mm_hr * p.drainMul);
      if (p.surge) ph.events.push({ type: 'surge', at_hours: 0.5, duration_hours: p.surge.hours, magnitude: p.surge.m3s, x: p.surge.x, y: p.surge.y, label: p.surge.label });
    }
    useApp.setState({ scenario: sc });
  };

  const focusTeam = () => {
    const { state, world } = get();
    const eng = getEngine();
    if (!state || !world || !eng) return;
    const t = state.teams[state.active];
    eng.flyTo(world.graph.x[t.node], world.graph.y[t.node], 2600);
  };

  const finishGame = () => {
    const { state } = get();
    if (!state) return;
    set({ screen: 'result', modal: null, preview: null, pinned: null });
    layer?.setRoute(get().world!.graph, null, '#000');
    layer?.setReach(get().world!.graph, null, 0, '#000');
    layer?.setTarget(null);
    const peak = state.history.reduce((m, h) => Math.max(m, h.roadKm ? h.roadKmBlocked / h.roadKm : 0), 0);
    repo
      .saveGameResult({
        seed: state.cfg.seed,
        difficulty: state.cfg.difficulty,
        rounds: state.cfg.rounds,
        teams: state.teams.map((t) => ({ name: t.name, role: t.role, rescued: t.rescued })),
        district: state.center.name,
        people_total: state.stats.people,
        people_saved: savedPeople(state),
        points: state.stats.points,
        stars: stars(state),
        summary: { calls: state.stats.calls, lostCalls: state.stats.lostCalls, stalls: state.stats.stalls, peakRoadsCutPct: Math.round(peak * 100), peakFloodKm2: Math.round(Math.max(...state.history.map((h) => h.floodedKm2))) },
      })
      .then(() => get().loadBest())
      .catch(() => undefined);
  };

  function startFlood() {
    const { state, world, watch } = get();
    const eng = getEngine();
    if (!state || !world || !eng) return;
    const target = state.round * state.cfg.roundHours * 3600;
    const t0 = eng.simTime;
    layer?.setReach(world.graph, null, 0, '#000');
    set({ busy: 'flood', floodPct: 0 });
    sync();
    window.clearInterval(floodTimer);
    floodTimer = window.setInterval(() => set({ floodPct: Math.min(1, (eng.simTime - t0) / Math.max(1, target - t0)) }), 120);
    if (!eng.runTo(target, watch ? FLOOD_WATCH_SPEED : 1e7)) void get().onFloodDone();
  }

  function afterMove(report: MoveReport) {
    const { state, world } = get();
    if (!state || !world) return;
    for (const d of report.delivered) get().toast('✅', `ส่ง${d.call.name} (${d.call.people} คน) ถึง${d.shelter.name} +${d.points}`, 'good');
    for (const c of report.picked) get().toast('🙋', `รับ${c.name} (${c.people} คน) ขึ้นรถแล้ว — พาไปศูนย์พักพิง${c.kind === 'patient' ? ' (โรงพยาบาล)' : ''}`, 'info');
    if (report.dice.length) {
      set({ dice: { team: state.teams[state.active].name, rolls: report.dice } });
      window.setTimeout(() => set({ dice: null }), report.stalled ? 3400 : 2400);
    }
    lastHover = -2;
    set({ busy: null });
    bump();
    sync();
  }

  return {
    screen: 'setup',
    form: defaultForm(),
    state: null,
    world: null,
    rev: 0,
    busy: null,
    floodPct: 0,
    modal: null,
    resolve: null,
    preview: null,
    pinned: null,
    hint: null,
    hover: null,
    dice: null,
    toasts: [],
    watch: true,
    realLight: false,
    showCut: true,
    bench: null,
    best: [],

    setForm: (p) => set((s) => ({ form: { ...s.form, ...p } })),

    open: () => {
      const app = useApp.getState();
      savedLayers = app.layers;
      app.pause();
      useApp.setState({ mode: 'game', layers: { ...app.layers, keyPlaces: false, labels: false, realLight: false, rain: true } });
      set({ screen: 'setup', modal: null, state: null, busy: null });
      void get().loadBest();
      getEngine()?.overview();
      if (get().bench === null) void getEngine()?.benchmark().then((ms) => set({ bench: ms }));
    },

    close: () => {
      layer?.dispose();
      layer = null;
      window.clearInterval(floodTimer);
      const eng = getEngine();
      eng?.setRunSpeed(1e7);
      useApp.setState({ mode: 'sim', ...(savedLayers ? { layers: savedLayers } : {}) });
      set({ screen: 'setup', state: null, world: null, busy: null, modal: null, preview: null, pinned: null });
    },

    loadBest: async () => {
      try {
        set({ best: await repo.listGameResults(8) });
      } catch {
        /* leaderboard is optional */
      }
    },

    start: async (seedOverride) => {
      const eng = getEngine();
      const city = useApp.getState().city;
      if (!eng || !city) return;
      if (useApp.getState().mode !== 'game') get().open();
      set({ busy: 'loading' });
      await new Promise((r) => setTimeout(r, 40)); // let the loading state paint before the heavy work
      const form = get().form;
      const seed = seedOverride ?? form.seed;
      const world = getWorld(city, eng.permanent);
      const state = newGame({ seed, difficulty: form.difficulty, rounds: form.rounds, roundHours: 4, teams: form.teams }, world, gameStartIso());
      window.clearInterval(floodTimer);
      useApp.getState().setScenario(state.scenario, { keepDirty: true });
      layer?.dispose();
      layer = new GameLayer(eng, world, eng.renderer.domElement.parentElement!, {
        wantsPointer: () => {
          const g = get();
          return g.state?.phase === 'action' && !g.busy && !g.modal;
        },
        onHover: (n, x, y) => get().hoverNode(n, x, y),
        onClick: (n) => get().clickNode(n),
        onMarker: (kind, id) => {
          const st = get().state;
          if (!st) return;
          if (kind === 'call') get().clickNode(st.calls.find((c) => c.id === Number(id))?.node ?? null);
          else if (kind === 'shelter') get().clickNode(st.shelters.find((s) => s.id === id)?.node ?? null);
          else if (kind === 'target') void get().confirm();
          else if (kind === 'team') {
            const t = st.teams[Number(id)];
            eng.flyTo(world.graph.x[t.node], world.graph.y[t.node], 1800);
          }
        },
      });
      beginRound(state, world);
      applyPatches(state.patches);
      useApp.setState({ layers: { ...useApp.getState().layers, realLight: get().realLight } });
      set({ screen: 'play', state, world, rev: get().rev + 1, busy: null, modal: 'event', resolve: null, preview: null, pinned: null, hint: null, dice: null, form: { ...form, seed } });
      sync();
      eng.flyTo(state.center.x, state.center.y, 5200);
    },

    setModal: (m) => set({ modal: m }),

    beginActions: () => {
      const { state } = get();
      if (!state || state.phase !== 'event') return set({ modal: null });
      startActions(state);
      set({ modal: null, preview: null, pinned: null, hint: null });
      bump();
      sync();
      focusTeam();
    },

    hoverNode: (node, px, py) => {
      const { state, busy, pinned, modal } = get();
      if (!state || state.phase !== 'action' || busy || modal) return;
      if (pinned !== null) return;
      if (node === null) {
        lastHover = -2;
        showPlan(null, false);
        set({ hover: null });
        return;
      }
      if (node !== lastHover) {
        lastHover = node;
        showPlan(node, false);
      }
      set({ hover: { x: px, y: py } });
    },

    clickNode: (node) => {
      const { state, busy, pinned, modal } = get();
      if (!state || state.phase !== 'action' || busy || modal) return;
      if (node === null) return get().clearPin();
      if (node === pinned) return void get().confirm();
      lastHover = node;
      set({ hint: null });
      showPlan(node, true);
    },

    clearPin: () => {
      lastHover = -2;
      set({ hint: null });
      showPlan(null, true);
    },

    confirm: async () => {
      const { state, world, preview, busy } = get();
      if (!state || !world || !layer || busy || state.phase !== 'action' || !preview) return;
      if (!preview.route.steps.length) return get().toast('⛽', 'แต้มเดินไม่พอสำหรับเส้นทางนี้ — รอรอบหน้า หรือเลือกจุดที่ใกล้กว่า', 'bad');
      const team = state.teams[state.active];
      set({ busy: 'moving', preview: null, pinned: null, hint: null, hover: null });
      layer.setRoute(world.graph, null, team.color);
      layer.setTarget(null);
      layer.setReach(world.graph, null, 0, team.color);
      const report = executeMove(state, world, team.id, preview.route);
      await layer.animate(team.id, world.graph, { ...preview.route, steps: report.steps });
      afterMove(report);
    },

    actHere: () => {
      const { state, world, busy } = get();
      if (!state || !world || busy || state.phase !== 'action') return;
      afterMove(actRule(state, world, state.active));
    },

    askHint: () => {
      const { state, world, busy } = get();
      if (!state || !world || busy || state.phase !== 'action') return;
      const sug = suggest(state, world, state.active);
      if (!sug) return get().toast('🤔', 'ตอนนี้ยังไม่มีเป้าหมายที่ทีมนี้ไปถึงได้ — ลองรอรอบหน้าหรือสลับทีม', 'info');
      lastHover = sug.node;
      showPlan(sug.node, true);
      set({ hint: sug.why });
    },

    endTurn: () => {
      const { state, busy } = get();
      if (!state || busy || state.phase !== 'action') return;
      endTurnRule(state);
      set({ preview: null, pinned: null, hint: null });
      layer?.setRoute(get().world!.graph, null, '#000');
      layer?.setTarget(null);
      bump();
      if (phaseOf(state) === 'flood') startFlood();
      else {
        sync();
        focusTeam();
      }
    },

    skipFlood: () => getEngine()?.setRunSpeed(1e7),

    nextRound: () => {
      const { state, world } = get();
      if (!state || !world || state.phase !== 'resolve') return;
      beginRound(state, world);
      applyPatches(state.patches);
      set({ modal: 'event', resolve: null, preview: null, pinned: null, hint: null });
      bump();
      sync();
      getEngine()?.flyTo(state.center.x, state.center.y, 4200);
    },

    toggleWatch: () => set((s) => ({ watch: !s.watch })),

    toggleCut: () => {
      set((s) => ({ showCut: !s.showCut }));
      sync();
    },

    toggleLight: () => {
      const realLight = !get().realLight;
      set({ realLight });
      useApp.setState({ layers: { ...useApp.getState().layers, realLight } });
    },

    onFloodDone: async () => {
      const { state, world } = get();
      const eng = getEngine();
      if (resolving || !state || !world || !eng || state.phase !== 'flood' || get().busy !== 'flood') return;
      resolving = true; // the depth read-back is async: a second "done" signal must not resolve the round twice
      try {
        window.clearInterval(floodTimer);
        const depth = await eng.readDepth();
        if (get().state !== state) return; // the game was restarted or closed while the depth was being read
        const rep = resolveFlood(state, world, depth);
        set({ busy: null, floodPct: 1, resolve: rep });
        bump();
        sync();
        if (rep.over) finishGame();
        else set({ modal: 'resolve' });
      } finally {
        resolving = false;
      }
    },

    toast: (emoji, text, tone = 'info') => {
      const id = toastId++;
      set((s) => ({ toasts: [...s.toasts.slice(-3), { id, emoji, text, tone }] }));
      window.setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 4200);
    },
  };
}
);
