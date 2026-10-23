import type { RoadGraph } from './roadGraph';

/** 0 = driving the truck on the road, 1 = in the boat on flooded street */
export type Mode = 0 | 1;

export interface Vehicle {
  /** deepest water the truck can wade through (m) */
  truckLimit: number;
  /** shallowest water the boat floats in (m) */
  boatMin: number;
  /** metres one movement point buys on a class-1.0 road */
  truckM: number;
  /** metres one movement point buys in the boat */
  boatM: number;
  /** movement points to swap between truck and boat */
  switchCost: number;
  canBoat: boolean;
}

/** speed of each road class relative to a plain town street (class 0 motorway … 6 service lane) */
export const CLASS_SPEED = [1.6, 1.5, 1.3, 1.1, 1.0, 0.8, 0.6] as const;
/** wading deeper than this risks stalling the truck */
export const RISK_FROM = 0.3;
const RISK_PENALTY = 2.5;

/** What the flood has done to the roads right now. */
export interface FloodView {
  edgeMax: Float32Array;
  edgeMean: Float32Array;
  /** edges closed by fallen trees, breakdowns … */
  blocked: Uint8Array | null;
}

let sMp = 0;
let sRisk = 0;

/** Cost of driving edge e in a mode into sMp / sRisk; false when the edge cannot be used. */
function costInto(g: RoadGraph, f: FloodView, v: Vehicle, e: number, mode: Mode): boolean {
  if (f.blocked && f.blocked[e]) return false;
  const d = f.edgeMax[e];
  const m = f.edgeMean[e];
  const len = g.edgeLen[e];
  if (mode === 0) {
    if (d > v.truckLimit) return false;
    sMp = (len / (v.truckM * CLASS_SPEED[g.edgeClass[e]])) * (1 + 3 * m);
    sRisk = v.truckLimit > RISK_FROM && d > RISK_FROM ? 0.5 * Math.min(1, (d - RISK_FROM) / (v.truckLimit - RISK_FROM)) : 0;
    return true;
  }
  if (!v.canBoat || m < v.boatMin * 0.8) return false;
  sMp = (len / v.boatM) * (1 + Math.max(0, 0.6 - m) * 1.5);
  sRisk = 0;
  return true;
}

export function edgeCost(g: RoadGraph, f: FloodView, v: Vehicle, e: number, mode: Mode): { mp: number; risk: number } | null {
  return costInto(g, f, v, e, mode) ? { mp: sMp, risk: sRisk } : null;
}

export interface RouteTree {
  /** ordering score per state (node * 2 + mode): movement points plus a penalty for risky wading */
  w: Float32Array;
  /** movement points along the best path to each state */
  mp: Float32Array;
  prev: Int32Array;
  /** edge used to enter the state; -1 = a truck/boat swap, -2 = the start */
  prevEdge: Int32Array;
  startNode: number;
  startMode: Mode;
}

class MinHeap {
  private ids: Int32Array;
  private keys: Float32Array;
  size = 0;
  constructor(cap: number) {
    this.ids = new Int32Array(cap);
    this.keys = new Float32Array(cap);
  }
  push(id: number, key: number) {
    if (this.size === this.ids.length) {
      const ids = new Int32Array(this.size * 2);
      const keys = new Float32Array(this.size * 2);
      ids.set(this.ids);
      keys.set(this.keys);
      this.ids = ids;
      this.keys = keys;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= key) break;
      this.ids[i] = this.ids[p];
      this.keys[i] = this.keys[p];
      i = p;
    }
    this.ids[i] = id;
    this.keys[i] = key;
  }
  /** removes the smallest; its key is left in lastKey */
  lastKey = 0;
  pop(): number {
    const top = this.ids[0];
    this.lastKey = this.keys[0];
    const id = this.ids[--this.size];
    const key = this.keys[this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.keys[c + 1] < this.keys[c]) c++;
      if (this.keys[c] >= key) break;
      this.ids[i] = this.ids[c];
      this.keys[i] = this.keys[c];
      i = c;
    }
    this.ids[i] = id;
    this.keys[i] = key;
    return top;
  }
}

/** Cheapest ways from a node (in a vehicle mode) to everywhere, never spending more than `limit` points. */
export function routeTree(g: RoadGraph, f: FloodView, v: Vehicle, startNode: number, startMode: Mode, limit = Infinity): RouteTree {
  const n = g.nodeCount * 2;
  const w = new Float32Array(n).fill(Infinity);
  const mp = new Float32Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const prevEdge = new Int32Array(n).fill(-2);
  const heap = new MinHeap(1 << 16);
  const s0 = startNode * 2 + startMode;
  w[s0] = 0;
  mp[s0] = 0;
  heap.push(s0, 0);
  while (heap.size) {
    const s = heap.pop();
    if (heap.lastKey > w[s]) continue; // stale entry
    if (heap.lastKey > limit) break;
    const node = s >> 1;
    const mode = (s & 1) as Mode;
    // swap vehicle in place
    if (v.canBoat) {
      const o = node * 2 + (1 - mode);
      const nw = w[s] + v.switchCost;
      if (nw < w[o]) {
        w[o] = nw;
        mp[o] = mp[s] + v.switchCost;
        prev[o] = s;
        prevEdge[o] = -1;
        heap.push(o, nw);
      }
    }
    for (let q = g.adjStart[node]; q < g.adjStart[node + 1]; q++) {
      const e = g.adjEdge[q];
      if (!costInto(g, f, v, e, mode)) continue;
      const t = g.adjTo[q] * 2 + mode;
      const nw = w[s] + sMp + RISK_PENALTY * sRisk;
      if (nw < w[t]) {
        w[t] = nw;
        mp[t] = mp[s] + sMp;
        prev[t] = s;
        prevEdge[t] = e;
        heap.push(t, nw);
      }
    }
  }
  return { w, mp, prev, prevEdge, startNode, startMode };
}

export interface RouteStep {
  kind: 'drive' | 'switch';
  edge: number;
  from: number;
  to: number;
  mode: Mode;
  mp: number;
  risk: number;
  depth: number;
}

export interface Route {
  steps: RouteStep[];
  mp: number;
  /** chance of stalling somewhere on the way */
  risk: number;
  end: number;
  endMode: Mode;
  switches: number;
  maxDepth: number;
}

/** Path to a node in whichever mode gets there cheapest. */
export function routeTo(g: RoadGraph, f: FloodView, v: Vehicle, tree: RouteTree, node: number): Route | null {
  const a = tree.w[node * 2];
  const b = tree.w[node * 2 + 1];
  if (!isFinite(a) && !isFinite(b)) return null;
  let s = a <= b ? node * 2 : node * 2 + 1;
  const back: RouteStep[] = [];
  while (tree.prev[s] >= 0) {
    const p = tree.prev[s];
    const e = tree.prevEdge[s];
    const mode = (s & 1) as Mode;
    if (e === -1) back.push({ kind: 'switch', edge: -1, from: s >> 1, to: s >> 1, mode, mp: v.switchCost, risk: 0, depth: 0 });
    else {
      const c = edgeCost(g, f, v, e, mode);
      back.push({ kind: 'drive', edge: e, from: p >> 1, to: s >> 1, mode, mp: c?.mp ?? 0, risk: c?.risk ?? 0, depth: f.edgeMax[e] });
    }
    s = p;
  }
  return summarise(back.reverse(), node, tree.w[node * 2] <= tree.w[node * 2 + 1] ? 0 : 1);
}

function summarise(steps: RouteStep[], end: number, endMode: Mode): Route {
  let mp = 0;
  let ok = 1;
  let switches = 0;
  let maxDepth = 0;
  for (const st of steps) {
    mp += st.mp;
    ok *= 1 - st.risk;
    if (st.kind === 'switch') switches++;
    else maxDepth = Math.max(maxDepth, st.depth);
  }
  return { steps, mp, risk: 1 - ok, end, endMode, switches, maxDepth };
}

/** The part of a route that fits in `budget` movement points (always ends at a node). */
export function truncateRoute(route: Route, budget: number): Route {
  const steps: RouteStep[] = [];
  let spent = 0;
  for (const st of route.steps) {
    if (spent + st.mp > budget + 1e-6) break;
    spent += st.mp;
    steps.push(st);
  }
  const last = steps[steps.length - 1];
  const end = last ? last.to : route.steps[0]?.from ?? route.end;
  return summarise(steps, end, last ? last.mode : route.steps[0]?.mode ?? route.endMode);
}

/** Nodes reachable within `budget` points: their cheapest mode and cost. */
export function reachable(g: RoadGraph, tree: RouteTree, budget: number): { node: number; mode: Mode; mp: number }[] {
  const out: { node: number; mode: Mode; mp: number }[] = [];
  for (let n = 0; n < g.nodeCount; n++) {
    const a = tree.mp[n * 2];
    const b = tree.mp[n * 2 + 1];
    const best = Math.min(a, b);
    if (best <= budget) out.push({ node: n, mode: a <= b ? 0 : 1, mp: best });
  }
  return out;
}
