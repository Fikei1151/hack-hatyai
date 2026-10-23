// Rules of the Hat Yai flood-rescue board game. Pure logic: no rendering, no GPU. The flood itself comes
// in as a depth grid after each round (from the live simulation), and everything that depends on it is
// derived here, so the whole game can be replayed headlessly.
import type { Scenario } from '../sim/types';
import { bankPoints } from '../sim/random';
import { CARDS, GIVEN_NAMES, TIPS, type CardDef } from './cards';
import { AGE_DISTRESS, distressFromDepth, LOST_DISTRESS, PICKUP_MP, SHELTER_CLOSE_DEPTH, STALL_DEPTH, STALL_MP } from './params';
import { edgeDepths, edgePoint, nearestNode, type EdgeDepths } from './roadGraph';
import { ROLES, TEAM_COLORS, vehicleOf, type RoleId } from './roles';
import { routeTo, routeTree, truncateRoute, type FloodView, type Mode, type Route, type RouteStep, type RouteTree, type Vehicle } from './routing';
import { DIFFICULTY, generateStorm, type Difficulty, type StormRound } from './storm';
import { cellAt, type GameWorld, type Site } from './world';

/** relative number of calls for 1..4 teams */
const TEAM_FACTOR = [0, 0.6, 1, 1.3, 1.6];

/** radius of the district a game is played in, m */
export const REGION_R = 3800;

export type Phase = 'event' | 'action' | 'flood' | 'resolve' | 'over';
export type CallKind = 'family' | 'elderly' | 'patient' | 'kids';

export const CALL_KINDS: Record<CallKind, { emoji: string; label: string; people: [number, number]; weight: number }> = {
  family: { emoji: '👨‍👩‍👧', label: 'ครอบครัว', people: [2, 4], weight: 5 },
  elderly: { emoji: '👵', label: 'ผู้สูงอายุ', people: [1, 2], weight: 2.5 },
  patient: { emoji: '🧑‍🦽', label: 'ผู้ป่วยติดเตียง', people: [1, 1], weight: 1.5 },
  kids: { emoji: '🧒', label: 'บ้านมีเด็กเล็ก', people: [2, 3], weight: 2 },
};

export interface GameConfig {
  seed: number;
  difficulty: Difficulty;
  rounds: number;
  roundHours: number;
  teams: { name: string; role: RoleId }[];
}

export interface Call {
  id: number;
  name: string;
  kind: CallKind;
  people: number;
  x: number;
  y: number;
  cell: number;
  node: number;
  hand: number;
  status: 'waiting' | 'aboard' | 'safe' | 'lost';
  distress: number;
  calledRound: number;
  doneRound: number | null;
  /** water at the home now, and the deepest it has been */
  depth: number;
  maxDepth: number;
  by: number | null;
  at: string | null;
  points: number;
}

export interface Team {
  id: number;
  name: string;
  role: RoleId;
  color: string;
  node: number;
  mode: Mode;
  mp: number;
  maxMp: number;
  /** this round only */
  capBonus: number;
  stalled: boolean;
  load: number[];
  rescued: number;
  /** has done something this round (the how-to hint hides once it has) */
  moved: boolean;
}

export interface Shelter {
  id: string;
  name: string;
  kind: string;
  icon: string;
  x: number;
  y: number;
  cell: number;
  node: number;
  capacity: number;
  occupants: number;
  hospital: boolean;
  closed: boolean;
  depth: number;
}

export interface Block {
  id: number;
  edge: number;
  x: number;
  y: number;
  /** last round it is closed */
  until: number;
  emoji: string;
  title: string;
}

export interface LogEntry {
  round: number;
  emoji: string;
  text: string;
  tone: 'info' | 'good' | 'bad';
}

/** A change to this round's weather made by an event card; the host applies it to the live scenario. */
export interface WeatherPatch {
  round: number;
  rainMul?: number;
  inflowMul?: number;
  lakeAdd?: number;
  drainMul?: number;
  surge?: { x: number; y: number; m3s: number; hours: number; label: string };
}

export interface CardView {
  def: CardDef;
  notes: string[];
}

export interface ForecastView {
  known: boolean;
  exact: boolean;
  mid: number;
  lo: number;
  hi: number;
  riverMid: number;
  nextMid: number | null;
  nextRiver: number | null;
}

export interface RoundRecord {
  round: number;
  rain: number;
  floodedKm2: number;
  /** km of roads in the district the truck cannot cross / all roads in the district */
  roadKmBlocked: number;
  roadKm: number;
  safe: number;
  lost: number;
  open: number;
}

export interface Stats {
  people: number;
  calls: number;
  lostCalls: number;
  lostPeople: number;
  points: number;
  stalls: number;
  dice: number;
  diceFailed: number;
}

export interface GameState {
  rev: number;
  floodRev: number;
  cfg: GameConfig;
  center: { x: number; y: number; name: string };
  region: number[];
  regionEdges: number[];
  round: number;
  phase: Phase;
  active: number;
  teams: Team[];
  calls: Call[];
  shelters: Shelter[];
  blocks: Block[];
  storm: StormRound[];
  deck: string[];
  scenario: Scenario;
  patches: WeatherPatch[];
  card: CardView | null;
  forecast: ForecastView | null;
  tip: string | null;
  log: LogEntry[];
  flood: { depth: Float32Array; edges: EdgeDepths; blocked: Uint8Array };
  history: RoundRecord[];
  stats: Stats;
  rngA: number;
  nextId: number;
}

/** deterministic random stream kept inside the game state (mulberry32) */
export function rand(s: { rngA: number }): number {
  s.rngA = (s.rngA + 0x6d2b79f5) >>> 0;
  let t = s.rngA;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const randInt = (s: { rngA: number }, lo: number, hi: number) => lo + Math.floor(rand(s) * (hi - lo + 1));
const pick = <T>(s: { rngA: number }, a: readonly T[]): T => a[Math.floor(rand(s) * a.length)];

function weighted<T>(s: { rngA: number }, items: readonly T[], w: (t: T) => number): T | null {
  let total = 0;
  for (const it of items) total += w(it);
  if (total <= 0) return null;
  let x = rand(s) * total;
  for (const it of items) if ((x -= w(it)) <= 0) return it;
  return items[items.length - 1];
}

const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);

export function log(s: GameState, emoji: string, text: string, tone: LogEntry['tone'] = 'info') {
  s.log.push({ round: s.round, emoji, text, tone });
  if (s.log.length > 300) s.log.splice(0, s.log.length - 300);
}

// ───────────────────────────────────────────────────────── setup

export function newGame(cfg: GameConfig, world: GameWorld, startIso: string): GameState {
  const g = world.graph;
  const s = { rngA: (cfg.seed * 2654435761) >>> 0 || 1 } as { rngA: number };

  // district: around a random school / temple / market near the middle of town
  const core = world.sites.filter((c) => !c.hospital && (c.x / 2800) ** 2 + (c.y / 2800) ** 2 <= 1);
  const heart = pick(s, core.length ? core : world.sites);
  const center = { x: heart.x, y: heart.y, name: `ย่านรอบ${/^[A-Za-z]/.test(heart.name) ? ' ' : ''}${heart.name}` };

  const region: number[] = [];
  world.houses.forEach((h, i) => dist(h.x, h.y, center.x, center.y) <= REGION_R && region.push(i));
  const regionEdges: number[] = [];
  for (let e = 0; e < g.edgeCount; e++) {
    const a = g.edgeA[e];
    const b = g.edgeB[e];
    if (dist((g.x[a] + g.x[b]) / 2, (g.y[a] + g.y[b]) / 2, center.x, center.y) <= REGION_R) regionEdges.push(e);
  }

  const shelters = pickShelters(s, world, center);
  const { rounds: storm, scenario } = generateStorm(cfg.seed, cfg.difficulty, cfg.rounds, cfg.roundHours, startIso);

  const teams: Team[] = cfg.teams.map((t, i) => {
    const ang = (2 * Math.PI * i) / cfg.teams.length + 0.6;
    const node = nearestNode(g, center.x + Math.cos(ang) * 160, center.y + Math.sin(ang) * 160, 600);
    const role = ROLES[t.role];
    return { id: i, name: t.name, role: t.role, color: TEAM_COLORS[i % TEAM_COLORS.length], node: node >= 0 ? node : nearestNode(g, center.x, center.y, 2000), mode: 0 as Mode, mp: role.mp, maxMp: role.mp, capBonus: 0, stalled: false, load: [], rescued: 0, moved: false };
  });

  const state: GameState = {
    rev: 0,
    floodRev: 0,
    cfg,
    center,
    region,
    regionEdges,
    round: 0,
    phase: 'event',
    active: 0,
    teams,
    calls: [],
    shelters,
    blocks: [],
    storm,
    deck: [],
    scenario,
    patches: [],
    card: null,
    forecast: null,
    tip: null,
    log: [],
    flood: { depth: new Float32Array(world.grid.nx * world.grid.ny), edges: { max: new Float32Array(g.edgeCount), mean: new Float32Array(g.edgeCount) }, blocked: new Uint8Array(g.edgeCount) },
    history: [],
    stats: { people: 0, calls: 0, lostCalls: 0, lostPeople: 0, points: 0, stalls: 0, dice: 0, diceFailed: 0 },
    rngA: s.rngA,
    nextId: 1,
  };
  state.deck = drawDeck(state);
  log(state, '🌧️', `เริ่มเกมที่${center.name} — ${cfg.rounds} รอบ รอบละ ${cfg.roundHours} ชั่วโมง`);
  return state;
}

function pickShelters(s: { rngA: number }, world: GameWorld, center: { x: number; y: number }): Shelter[] {
  const near = world.sites.filter((c) => dist(c.x, c.y, center.x, center.y) <= REGION_R + 800);
  const make = (c: Site): Shelter => ({ id: c.id, name: c.name, kind: c.kind, icon: c.icon, x: c.x, y: c.y, cell: c.cell, node: c.node, capacity: c.capacity, occupants: 0, hospital: c.hospital, closed: false, depth: 0 });
  const chosen: Site[] = [];
  const homes = near.filter((c) => !c.hospital).sort((a, b) => b.importance - a.importance || b.capacity - a.capacity);
  if (homes.length) chosen.push(homes[0]);
  while (chosen.length < 9) {
    let best: Site | null = null;
    let bestScore = 0;
    for (const c of homes) {
      if (chosen.includes(c)) continue;
      const d = Math.min(...chosen.map((q) => dist(q.x, q.y, c.x, c.y)));
      if (d < 450) continue;
      const score = d * (1 + 0.1 * c.importance) * (0.9 + 0.2 * rand(s));
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (!best) break;
    chosen.push(best);
  }
  const hospitals: Site[] = [];
  for (const c of near.filter((q) => q.hospital).sort((a, b) => dist(a.x, a.y, center.x, center.y) - dist(b.x, b.y, center.x, center.y))) {
    if (hospitals.length < 3 && hospitals.every((q) => dist(q.x, q.y, c.x, c.y) > 600)) hospitals.push(c);
  }
  return [...chosen, ...hospitals].map(make);
}

const weatherBad = (d: CardDef) => (d.effect.rainMul ?? 1) > 1 || (d.effect.inflowMul ?? 1) > 1 || !!d.effect.surge || !!d.effect.lakeAdd || (d.effect.drainMul ?? 1) < 1;

function drawDeck(state: GameState): string[] {
  const d = DIFFICULTY[state.cfg.difficulty];
  const deck: string[] = [];
  let last = '';
  for (let k = 1; k <= state.cfg.rounds; k++) {
    const tone = rand(state) < (k === 1 ? d.badShare / 2 : d.badShare) ? 'bad' : rand(state) < 0.2 ? 'info' : 'good';
    const pool = CARDS.filter((c) => c.tone === tone && c.id !== last && !(k === 1 && weatherBad(c)));
    const card = weighted(state, pool.length ? pool : CARDS.filter((c) => c.id === 'calm'), (c) => c.weight) ?? CARDS[CARDS.length - 1];
    deck.push(card.id);
    last = card.id;
  }
  return deck;
}

// ───────────────────────────────────────────────────────── rounds

/** Round opens: team points reset, the event card is drawn and applied, the forecast and new calls appear. */
export function beginRound(state: GameState, world: GameWorld): void {
  state.round++;
  state.phase = 'event';
  state.active = 0;
  state.patches = [];
  state.tip = null;
  const d = DIFFICULTY[state.cfg.difficulty];
  for (const t of state.teams) {
    t.mp = ROLES[t.role].mp - (t.stalled ? STALL_MP : 0);
    if (t.stalled) log(state, '🚙', `${t.name} รถดับเมื่อรอบก่อน เสียแต้มเดิน ${STALL_MP}`, 'bad');
    t.stalled = false;
    t.capBonus = 0;
    t.moved = false;
  }

  const def = CARDS.find((c) => c.id === state.deck[state.round - 1]) ?? CARDS[CARDS.length - 1];
  const notes = applyCard(state, world, def);
  state.card = { def, notes };
  log(state, def.emoji, `การ์ด: ${def.title}`, def.tone === 'bad' ? 'bad' : def.tone === 'good' ? 'good' : 'info');

  const storm = state.storm[state.round - 1];
  const next = state.storm[state.round] ?? null;
  const hidden = def.effect.forecast === 'hidden';
  const exact = def.effect.forecast === 'exact';
  const sigma = exact ? 0 : d.forecastSigma;
  const noise = () => (rand(state) + rand(state) + rand(state) - 1.5) * 1.1;
  const actualRain = storm.rain * (def.effect.rainMul ?? 1);
  const baseRain = exact ? actualRain : storm.rain;
  const mid = baseRain * (1 + sigma * noise());
  const band = 1.2 * sigma + 0.05;
  state.forecast = {
    known: !hidden,
    exact,
    mid: Math.max(0, mid),
    lo: Math.max(0, mid * (1 - band)),
    hi: mid * (1 + band),
    riverMid: Math.round(storm.inflow * (1 + sigma * 0.6 * noise())),
    nextMid: next ? Math.max(0, next.rain * (1 + 1.6 * sigma * noise())) : null,
    nextRiver: next ? Math.round(next.inflow * (1 + sigma * 0.8 * noise())) : null,
  };

  // the number of calls follows the number of teams (one team can only handle a handful)
  const f = TEAM_FACTOR[Math.min(4, state.teams.length)];
  let n: number;
  if (state.round === 1) n = Math.max(2, Math.round(d.startCalls * f));
  else if (state.round >= state.cfg.rounds) n = 0;
  else {
    const rate = d.callsPerRound * f * (state.round === state.cfg.rounds - 1 ? 0.5 : 1);
    n = Math.floor(rate) + (rand(state) < rate - Math.floor(rate) ? 1 : 0);
  }
  spawnCalls(state, world, n);
  state.rev++;
}

function applyCard(state: GameState, world: GameWorld, def: CardDef): string[] {
  const e = def.effect;
  const notes: string[] = [];
  const g = world.graph;
  const k = state.round;
  const patch: WeatherPatch = { round: k };
  if (e.rainMul) patch.rainMul = e.rainMul;
  if (e.inflowMul) patch.inflowMul = e.inflowMul;
  if (e.lakeAdd) patch.lakeAdd = e.lakeAdd;
  if (e.drainMul) patch.drainMul = e.drainMul;
  if (e.surge) {
    const banks = bankPoints(world.city.waterways).filter((b) => dist(b.x, b.y, state.center.x, state.center.y) <= REGION_R + 1000);
    const b = banks.length ? pick(state, banks) : null;
    if (b) {
      const m3s = e.surge.m3s * (state.cfg.difficulty === 'hard' ? 1.5 : state.cfg.difficulty === 'easy' ? 0.6 : 1);
      patch.surge = { x: b.x, y: b.y, m3s, hours: e.surge.hours, label: 'คันกั้นน้ำพัง' };
      notes.push(`น้ำทะลักที่${b.canal}`);
    } else notes.push('คันกั้นน้ำเกือบพัง แต่รอดมาได้');
  }
  if (Object.keys(patch).length > 1) state.patches.push(patch);

  if (e.clearBlocks) {
    notes.push(state.blocks.length ? `เปิดถนน ${state.blocks.length} สาย` : 'ไม่มีถนนปิดอยู่ตอนนี้');
    state.blocks = [];
    rebuildBlocked(state);
  }
  if (e.blocks) {
    const cands = state.regionEdges.filter((ed) => {
      if (g.edgeBridge[ed] || g.edgeLen[ed] < 60 || state.flood.blocked[ed] || state.flood.edges.max[ed] > 0.3) return false;
      return e.blocks!.major ? g.edgeClass[ed] <= 3 : g.edgeClass[ed] <= 5;
    });
    for (let i = 0; i < e.blocks.count && cands.length; i++) {
      const idx = Math.floor(rand(state) * cands.length);
      const ed = cands.splice(idx, 1)[0];
      const p = edgePoint(g, ed, 0.5);
      state.blocks.push({ id: state.nextId++, edge: ed, x: p.x, y: p.y, until: k + e.blocks.rounds - 1, emoji: def.emoji, title: def.title });
      notes.push('ถนนถูกปิด');
    }
    rebuildBlocked(state);
  }
  if (e.mpAll) {
    for (const t of state.teams) t.mp = Math.max(0, t.mp + e.mpAll);
    notes.push(`ทุกทีม ${e.mpAll > 0 ? '+' : ''}${e.mpAll} แต้มเดิน`);
  }
  if (e.mpOne) {
    const t = pick(state, state.teams);
    t.mp += e.mpOne;
    notes.push(`${t.name} +${e.mpOne} แต้มเดิน`);
  }
  if (e.capOne) {
    const t = pick(state, state.teams);
    t.capBonus += e.capOne;
    notes.push(`${t.name} รับได้เพิ่ม +${e.capOne} คน`);
  }
  return notes;
}

function rebuildBlocked(state: GameState) {
  state.flood.blocked.fill(0);
  for (const b of state.blocks) state.flood.blocked[b.edge] = 1;
  state.floodRev++;
}

function spawnCalls(state: GameState, world: GameWorld, n: number): void {
  if (n <= 0) return;
  const g = world.graph;
  const open = state.calls.filter((c) => c.status === 'waiting' || c.status === 'aboard');
  const room = Math.max(0, 9 - open.filter((c) => c.status === 'waiting').length);
  n = Math.min(n, room);
  if (n <= 0) return;
  // every home must be reachable from the middle of the district by a truck or a boat
  const start = nearestNode(g, state.center.x, state.center.y, 1500);
  const probe: Vehicle = { truckLimit: 0.5, boatMin: 0.35, truckM: 600, boatM: 420, switchCost: 1, canBoat: true };
  const tree = start >= 0 ? routeTree(g, floodView(state), probe, start, 0) : null;
  const depth = state.flood.depth;
  const w = (i: number) => {
    const h = world.houses[i];
    const base = h.hand < -0.5 ? 6 : h.hand < 0.2 ? 4 : h.hand < 1.5 ? 1.5 : 0.4;
    return base * (depth[h.cell] >= 0.1 ? 3 : 1) * (h.nodeDist < 50 ? 1 : 0.5);
  };
  for (let made = 0, tries = 0; made < n && tries < 80; tries++) {
    const i = weighted(state, state.region, w);
    if (i === null) break;
    const h = world.houses[i];
    if (tree && !isFinite(tree.w[h.node * 2]) && !isFinite(tree.w[h.node * 2 + 1])) continue;
    if (state.calls.some((c) => (c.status === 'waiting' || c.status === 'aboard') && dist(c.x, c.y, h.x, h.y) < 250)) continue;
    if (state.shelters.some((sh) => dist(sh.x, sh.y, h.x, h.y) < 100)) continue;
    const kind = weighted(state, Object.keys(CALL_KINDS) as CallKind[], (k) => CALL_KINDS[k].weight) ?? 'family';
    const info = CALL_KINDS[kind];
    const people = randInt(state, info.people[0], info.people[1]);
    const given = pick(state, GIVEN_NAMES);
    const name = kind === 'family' ? `${pick(state, ['บ้านลุง', 'บ้านป้า', 'บ้านน้า', 'บ้านพี่'])}${given}` : kind === 'elderly' ? `${pick(state, ['คุณยาย', 'คุณตา'])}${given}` : kind === 'patient' ? `คุณ${given}` : `ครอบครัวคุณ${given}`;
    const call: Call = {
      id: state.nextId++,
      name,
      kind,
      people,
      x: h.x,
      y: h.y,
      cell: h.cell,
      node: h.node,
      hand: h.hand,
      status: 'waiting',
      distress: 0,
      calledRound: state.round,
      doneRound: null,
      depth: depth[h.cell],
      maxDepth: depth[h.cell],
      by: null,
      at: null,
      points: 0,
    };
    state.calls.push(call);
    state.stats.calls++;
    state.stats.people += people;
    log(state, '📞', `สายเข้า: ${name} (${people} คน) ขอความช่วยเหลือ${call.depth >= 0.1 ? ` — น้ำท่วมแล้ว ${call.depth.toFixed(1)} ม.` : ''}`, 'info');
    made++;
  }
}

export function startActions(state: GameState): void {
  state.phase = 'action';
  state.active = 0;
  state.rev++;
}

// ───────────────────────────────────────────────────────── moving

export function floodView(state: GameState): FloodView {
  return { edgeMax: state.flood.edges.max, edgeMean: state.flood.edges.mean, blocked: state.flood.blocked };
}

export function vehicleFor(team: Team): Vehicle {
  return vehicleOf(ROLES[team.role]);
}

export function seatsLeft(state: GameState, team: Team): number {
  const used = team.load.reduce((sum, id) => sum + (state.calls.find((c) => c.id === id)?.people ?? 0), 0);
  return ROLES[team.role].capacity + team.capBonus - used;
}

const trees = new WeakMap<GameState, Map<number, { key: string; tree: RouteTree }>>();

export function treeFor(state: GameState, world: GameWorld, team: Team): RouteTree {
  let m = trees.get(state);
  if (!m) trees.set(state, (m = new Map()));
  const key = `${team.node}:${team.mode}:${state.floodRev}`;
  const hit = m.get(team.id);
  if (hit && hit.key === key) return hit.tree;
  const tree = routeTree(world.graph, floodView(state), vehicleFor(team), team.node, team.mode);
  m.set(team.id, { key, tree });
  return tree;
}

export interface Plan {
  target: number;
  /** all the way to the target */
  full: Route;
  /** the part the team can afford this round */
  route: Route;
  partial: boolean;
}

export function planMove(state: GameState, world: GameWorld, teamId: number, target: number): Plan | null {
  const team = state.teams[teamId];
  const full = routeTo(world.graph, floodView(state), vehicleFor(team), treeFor(state, world, team), target);
  if (!full) return null;
  const route = truncateRoute(full, team.mp);
  return { target, full, route, partial: route.steps.length < full.steps.length };
}

export interface DiceRoll {
  edge: number;
  risk: number;
  /** 1..6 */
  face: number;
  failed: boolean;
}

export interface MoveReport {
  steps: RouteStep[];
  dice: DiceRoll[];
  /** node where the team stopped (a failed crossing stops it before the edge) */
  endNode: number;
  stalled: boolean;
  picked: Call[];
  delivered: { call: Call; shelter: Shelter; points: number }[];
}

export function executeMove(state: GameState, world: GameWorld, teamId: number, route: Route): MoveReport {
  const team = state.teams[teamId];
  const report: MoveReport = { steps: [], dice: [], endNode: team.node, stalled: false, picked: [], delivered: [] };
  team.moved = true;
  for (const st of route.steps) {
    if (st.kind === 'drive' && st.risk > 0) {
      const r = rand(state);
      const failed = r < st.risk;
      report.dice.push({ edge: st.edge, risk: st.risk, face: Math.min(6, 1 + Math.floor(r * 6)), failed });
      state.stats.dice++;
      if (failed) {
        state.stats.diceFailed++;
        state.stats.stalls++;
        team.mp = 0;
        report.stalled = true;
        log(state, '🎲', `${team.name} ลุยน้ำลึก ${st.depth.toFixed(2)} ม. แล้วรถดับกลางทาง!`, 'bad');
        break;
      }
    }
    team.mp = Math.max(0, team.mp - st.mp);
    team.mode = st.mode;
    team.node = st.to;
    report.steps.push(st);
    report.endNode = st.to;
  }
  if (!report.stalled) arrive(state, world, team, report);
  state.rev++;
  return report;
}

/** Whether the team can pick someone up or drop someone off right where it stands. */
export function canAct(state: GameState, team: Team): boolean {
  if (state.phase !== 'action') return false;
  const here = (c: Call) => c.status === 'waiting' && c.node === team.node && c.people <= seatsLeft(state, team) && team.mp >= PICKUP_MP - 1e-6;
  if (state.calls.some(here)) return true;
  return team.load.length > 0 && state.shelters.some((sh) => sh.node === team.node && !sh.closed && team.load.some((id) => accepts(team, sh, state.calls.find((c) => c.id === id)!)));
}

export function act(state: GameState, world: GameWorld, teamId: number): MoveReport {
  const team = state.teams[teamId];
  team.moved = true;
  const report: MoveReport = { steps: [], dice: [], endNode: team.node, stalled: false, picked: [], delivered: [] };
  arrive(state, world, team, report);
  state.rev++;
  return report;
}

function accepts(team: Team, sh: Shelter, c: Call): boolean {
  if (sh.closed || sh.occupants + c.people > sh.capacity) return false;
  if (sh.hospital) return c.kind === 'patient';
  return c.kind !== 'patient' || ROLES[team.role].medic;
}

/** Auto-actions on arrival: drop everyone a shelter will take, then board waiting families that fit. */
function arrive(state: GameState, _world: GameWorld, team: Team, report: MoveReport) {
  for (const sh of state.shelters.filter((q) => q.node === team.node).sort((a, b) => Number(b.hospital) - Number(a.hospital))) {
    for (const id of [...team.load]) {
      const c = state.calls.find((q) => q.id === id)!;
      if (!accepts(team, sh, c)) continue;
      const pts = Math.round(c.people * (c.kind === 'patient' ? 15 : 10) * (1 - 0.1 * Math.min(3, Math.floor(c.distress))) + (c.calledRound === state.round ? 5 : 0));
      c.status = 'safe';
      c.doneRound = state.round;
      c.at = sh.name;
      c.points = pts;
      c.by = team.id;
      sh.occupants += c.people;
      team.load = team.load.filter((x) => x !== id);
      team.rescued += c.people;
      state.stats.points += pts;
      report.delivered.push({ call: c, shelter: sh, points: pts });
      log(state, '✅', `${team.name} ส่ง${c.name} (${c.people} คน) ถึง${sh.name} +${pts}`, 'good');
    }
    if (team.load.length && !sh.closed && sh.occupants >= sh.capacity) log(state, '🈵', `${sh.name} เต็มแล้ว`, 'bad');
    else if (team.load.length && sh.closed) log(state, '🚫', `${sh.name} น้ำท่วมถึง ปิดรับผู้อพยพ`, 'bad');
  }
  const waiting = state.calls.filter((c) => c.status === 'waiting' && c.node === team.node).sort((a, b) => b.distress - a.distress || b.people - a.people);
  for (const c of waiting) {
    if (c.people > seatsLeft(state, team) || team.mp < PICKUP_MP - 1e-6) continue;
    team.mp = Math.max(0, team.mp - PICKUP_MP);
    c.status = 'aboard';
    c.by = team.id;
    team.load.push(c.id);
    report.picked.push(c);
    log(state, '🙋', `${team.name} รับ${c.name} (${c.people} คน) ขึ้น${team.mode === 1 ? 'เรือ' : 'รถ'}`, 'info');
  }
}

export function endTurn(state: GameState): void {
  if (state.phase !== 'action') return;
  state.active++;
  if (state.active >= state.teams.length) {
    state.active = state.teams.length - 1;
    state.phase = 'flood';
  }
  state.rev++;
}

// ───────────────────────────────────────────────────────── the flood arrives

export interface ResolveReport {
  newlyLost: Call[];
  worse: Call[];
  closed: Shelter[];
  reopened: Shelter[];
  stalled: Team[];
  floodedKm2: number;
  roadKmBlocked: number;
  roadKm: number;
  over: boolean;
}

/** The round's water is in: update roads, homes, shelters and vehicles from the depth grid. */
export function resolveFlood(state: GameState, world: GameWorld, depth: Float32Array): ResolveReport {
  const g = world.graph;
  state.flood.depth = depth;
  edgeDepths(g, depth, state.flood.edges);
  state.blocks = state.blocks.filter((b) => b.until > state.round);
  rebuildBlocked(state);

  const rep: ResolveReport = { newlyLost: [], worse: [], closed: [], reopened: [], stalled: [], floodedKm2: 0, roadKmBlocked: 0, roadKm: 0, over: false };
  const limit = ROLES.rescue.truckLimit;
  for (const e of state.regionEdges) {
    rep.roadKm += g.edgeLen[e] / 1000;
    if (state.flood.blocked[e] || state.flood.edges.max[e] > limit) rep.roadKmBlocked += g.edgeLen[e] / 1000;
  }
  let wet = 0;
  for (let i = 0; i < depth.length; i++) if (depth[i] > 0.1 && !world.permanent[i]) wet++;
  rep.floodedKm2 = (wet * world.grid.cell * world.grid.cell) / 1e6;

  for (const c of state.calls) {
    if (c.status !== 'waiting' && c.status !== 'aboard') continue;
    const d = depth[c.cell];
    c.depth = d;
    c.maxDepth = Math.max(c.maxDepth, d);
    if (c.status === 'aboard') {
      const team = state.teams[c.by!];
      if (c.kind === 'patient' && !ROLES[team.role].medic) c.distress += 0.5;
      continue;
    }
    const before = c.distress;
    let add = distressFromDepth(d) + (state.round - c.calledRound >= 2 ? AGE_DISTRESS : 0);
    // a fresh call always gets at least one round to be reached
    if (c.calledRound === state.round) add = Math.min(add, LOST_DISTRESS - 0.5 - c.distress);
    c.distress += Math.max(0, add);
    if (c.distress >= LOST_DISTRESS) {
      c.status = 'lost';
      c.doneRound = state.round;
      state.stats.lostCalls++;
      state.stats.lostPeople += c.people;
      rep.newlyLost.push(c);
      log(state, '💔', `${c.name} (${c.people} คน) ติดค้างในน้ำลึก ${d.toFixed(1)} ม. — ช่วยไม่ทัน`, 'bad');
    } else if (Math.floor(c.distress) > Math.floor(before) || (d >= 0.4 && c.distress > before)) {
      rep.worse.push(c);
      log(state, '😟', `${c.name}: น้ำที่บ้านสูง ${d.toFixed(1)} ม. ผู้ประสบภัยเริ่มแย่ลง`, 'bad');
    }
  }

  for (const sh of state.shelters) {
    sh.depth = depth[sh.cell];
    if (!sh.closed && sh.depth > SHELTER_CLOSE_DEPTH) {
      sh.closed = true;
      rep.closed.push(sh);
      log(state, '🚫', `${sh.name} น้ำท่วมถึง ${sh.depth.toFixed(1)} ม. — ปิดรับผู้อพยพ`, 'bad');
    } else if (sh.closed && sh.depth < SHELTER_CLOSE_DEPTH / 2) {
      sh.closed = false;
      rep.reopened.push(sh);
      log(state, '🟢', `${sh.name} น้ำลดแล้ว เปิดรับผู้อพยพอีกครั้ง`, 'good');
    }
  }

  for (const team of state.teams) {
    const cell = cellAt(world, g.x[team.node], g.y[team.node]);
    const here = world.permanent[cell] ? 0 : depth[cell];
    if (team.mode === 0 && here > STALL_DEPTH) {
      team.stalled = true;
      state.stats.stalls++;
      rep.stalled.push(team);
      for (const id of team.load) state.calls.find((c) => c.id === id)!.distress += 1;
      log(state, '🚙', `${team.name} จอดอยู่ในน้ำลึก ${here.toFixed(1)} ม. รถดับ!`, 'bad');
    }
  }

  const over = state.round >= state.cfg.rounds;
  if (over) {
    for (const c of state.calls) {
      if (c.status === 'waiting' || c.status === 'aboard') {
        c.status = 'lost';
        c.doneRound = state.round;
        state.stats.lostCalls++;
        state.stats.lostPeople += c.people;
      }
    }
    for (const t of state.teams) t.load = [];
    state.phase = 'over';
    rep.over = true;
  } else {
    state.phase = 'resolve';
    state.tip = TIPS[(state.round + state.cfg.seed) % TIPS.length];
  }
  state.history.push({
    round: state.round,
    rain: state.storm[state.round - 1].rain,
    floodedKm2: rep.floodedKm2,
    roadKmBlocked: rep.roadKmBlocked,
    roadKm: rep.roadKm,
    safe: state.calls.filter((c) => c.status === 'safe').length,
    lost: state.calls.filter((c) => c.status === 'lost').length,
    open: state.calls.filter((c) => c.status === 'waiting' || c.status === 'aboard').length,
  });
  state.rev++;
  return rep;
}

export function stars(state: GameState): number {
  const total = state.stats.people;
  if (!total) return 0;
  const saved = state.calls.filter((c) => c.status === 'safe').reduce((s, c) => s + c.people, 0);
  const r = saved / total;
  return r >= 0.85 ? 3 : r >= 0.65 ? 2 : r >= 0.4 ? 1 : 0;
}

export function savedPeople(state: GameState): number {
  return state.calls.filter((c) => c.status === 'safe').reduce((s, c) => s + c.people, 0);
}

// ───────────────────────────────────────────────────────── hints and bots

export interface Suggestion {
  node: number;
  why: string;
  plan: Plan;
}

/** A sensible next target for a team: deliver what it carries, or fetch the most urgent family it can reach. */
export function suggest(state: GameState, world: GameWorld, teamId: number): Suggestion | null {
  const team = state.teams[teamId];
  const g = world.graph;
  const f = floodView(state);
  const veh = vehicleFor(team);
  const tree = treeFor(state, world, team);
  const aboard = team.load.map((id) => state.calls.find((c) => c.id === id)!);
  let best: { score: number; node: number; why: string } | null = null;
  const consider = (score: number, node: number, why: string) => {
    if (!best || score > best.score) best = { score, node, why };
  };
  if (aboard.length) {
    for (const sh of state.shelters) {
      const take = aboard.filter((c) => accepts(team, sh, c));
      if (!take.length) continue;
      const r = routeTo(g, f, veh, tree, sh.node);
      if (!r) continue;
      const value = take.reduce((s, c) => s + c.people * (10 + 5 * c.distress), 0);
      consider((value * 2) / (1 + r.mp + r.risk * 3), sh.node, `ส่ง ${take.map((c) => c.name).join(', ')} ที่${sh.name}`);
    }
  }
  const seats = seatsLeft(state, team);
  if (seats > 0) {
    for (const c of state.calls) {
      if (c.status !== 'waiting' || c.people > seats) continue;
      const r = routeTo(g, f, veh, tree, c.node);
      if (!r) continue;
      const value = c.people * (10 + 6 * c.distress + (c.depth > 0.5 ? 5 : 0));
      consider(value / (1 + r.mp + r.risk * 3), c.node, `ไปรับ${c.name} (${c.people} คน)`);
    }
  }
  const b = best as { score: number; node: number; why: string } | null;
  if (!b) return null;
  const plan = planMove(state, world, teamId, b.node);
  return plan ? { node: b.node, why: b.why, plan } : null;
}

/** Play one team's turn greedily (used for hints in tests and the balance simulator). */
export function autoTurn(state: GameState, world: GameWorld, teamId: number): void {
  const team = state.teams[teamId];
  for (let i = 0; i < 10 && team.mp > 0.2; i++) {
    if (canAct(state, team)) {
      act(state, world, teamId);
      continue;
    }
    const sug = suggest(state, world, teamId);
    if (!sug || !sug.plan.route.steps.length) break;
    executeMove(state, world, teamId, sug.plan.route);
  }
}

export function callById(state: GameState, id: number): Call | undefined {
  return state.calls.find((c) => c.id === id);
}
