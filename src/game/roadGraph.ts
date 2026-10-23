import type { RoadSet } from '../engine/cityData';

/** Grid the flood model runs on (cell-centred, row 0 = south). */
export interface GridInfo {
  nx: number;
  ny: number;
  cell: number;
  x0: number;
  y0: number;
}

/**
 * The street network as a graph: nodes are junctions and dead ends, edges are the stretches of road
 * between them (an OSM way is cut wherever another way touches it). Only the main connected piece
 * is kept, so every node can reach every other.
 */
export interface RoadGraph {
  nodeCount: number;
  x: Float32Array;
  y: Float32Array;
  /** CSR adjacency: edges leaving node n are adjEdge[adjStart[n] .. adjStart[n + 1]) */
  adjStart: Uint32Array;
  adjEdge: Uint32Array;
  adjTo: Uint32Array;
  edgeCount: number;
  edgeA: Uint32Array;
  edgeB: Uint32Array;
  edgeLen: Float32Array;
  /** 0 motorway … 6 service, as in roads.bin */
  edgeClass: Uint8Array;
  edgeBridge: Uint8Array;
  /** polyline of edge e (A → B): geoXY[2 * geoStart[e] .. 2 * geoStart[e + 1]) */
  geoStart: Uint32Array;
  geoXY: Float32Array;
  /** flood-grid cells under edge e (bridges and permanent water excluded) */
  cellStart: Uint32Array;
  cellIds: Uint32Array;
  hash: SpatialHash;
}

interface SpatialHash {
  size: number;
  x0: number;
  y0: number;
  w: number;
  h: number;
  start: Uint32Array;
  nodes: Uint32Array;
}

const HASH = 150;

export function buildRoadGraph(roads: RoadSet, grid: GridInfo, skip: Uint8Array): RoadGraph {
  const { coords, vertCounts, offsets, flags, count } = roads;
  // vertices of different ways that share an OSM node have identical (0.5 m quantised) coordinates
  const key = (v: number) => (Math.round(coords[2 * v] * 2) + 100000) * 400000 + (Math.round(coords[2 * v + 1] * 2) + 200000);

  const occ = new Map<number, number>();
  for (let r = 0; r < count; r++) for (let k = 0; k < vertCounts[r]; k++) occ.set(key(offsets[r] + k), (occ.get(key(offsets[r] + k)) ?? 0) + 1);

  const nodeOf = new Map<number, number>();
  const nx0: number[] = [];
  const ny0: number[] = [];
  for (let r = 0; r < count; r++) {
    const n = vertCounts[r];
    for (let k = 0; k < n; k++) {
      const v = offsets[r] + k;
      const kk = key(v);
      if ((k === 0 || k === n - 1 || (occ.get(kk) ?? 0) > 1) && !nodeOf.has(kk)) {
        nodeOf.set(kk, nx0.length);
        nx0.push(coords[2 * v]);
        ny0.push(coords[2 * v + 1]);
      }
    }
  }

  const ea: number[] = [];
  const eb: number[] = [];
  const elen: number[] = [];
  const ecls: number[] = [];
  const ebr: number[] = [];
  const egs: number[] = [];
  const ege: number[] = [];
  const geo: number[] = [];
  for (let r = 0; r < count; r++) {
    const n = vertCounts[r];
    const cls = flags[r] & 15;
    const bridge = (flags[r] >> 4) & 1;
    let prev = -1;
    let start = 0;
    let acc = 0;
    let lx = 0;
    let ly = 0;
    for (let k = 0; k < n; k++) {
      const v = offsets[r] + k;
      const x = coords[2 * v];
      const y = coords[2 * v + 1];
      if (prev >= 0) {
        geo.push(x, y);
        acc += Math.hypot(x - lx, y - ly);
      }
      lx = x;
      ly = y;
      const nd = nodeOf.get(key(v));
      if (nd === undefined) continue;
      if (prev >= 0 && (prev !== nd || acc > 8)) {
        ea.push(prev);
        eb.push(nd);
        elen.push(acc);
        ecls.push(cls);
        ebr.push(bridge);
        egs.push(start);
        ege.push(geo.length / 2);
      }
      prev = nd;
      start = geo.length / 2;
      geo.push(x, y);
      acc = 0;
    }
  }

  // keep the main connected component
  const nNodes = nx0.length;
  const parent = new Int32Array(nNodes);
  for (let i = 0; i < nNodes; i++) parent[i] = i;
  const find = (a: number) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  for (let e = 0; e < ea.length; e++) parent[find(ea[e])] = find(eb[e]);
  const size = new Map<number, number>();
  for (let i = 0; i < nNodes; i++) size.set(find(i), (size.get(find(i)) ?? 0) + 1);
  let main = 0;
  let best = -1;
  for (const [root, s] of size) if (s > best) ((best = s), (main = root));
  const remap = new Int32Array(nNodes).fill(-1);
  let nodeCount = 0;
  for (let i = 0; i < nNodes; i++) if (find(i) === main) remap[i] = nodeCount++;

  const x = new Float32Array(nodeCount);
  const y = new Float32Array(nodeCount);
  for (let i = 0; i < nNodes; i++)
    if (remap[i] >= 0) {
      x[remap[i]] = nx0[i];
      y[remap[i]] = ny0[i];
    }

  const keep: number[] = [];
  for (let e = 0; e < ea.length; e++) if (remap[ea[e]] >= 0) keep.push(e);
  const edgeCount = keep.length;
  const edgeA = new Uint32Array(edgeCount);
  const edgeB = new Uint32Array(edgeCount);
  const edgeLen = new Float32Array(edgeCount);
  const edgeClass = new Uint8Array(edgeCount);
  const edgeBridge = new Uint8Array(edgeCount);
  const geoStart = new Uint32Array(edgeCount + 1);
  let geoLen = 0;
  for (const e of keep) geoLen += ege[e] - egs[e];
  const geoXY = new Float32Array(geoLen * 2);
  let gp = 0;
  keep.forEach((e, i) => {
    edgeA[i] = remap[ea[e]];
    edgeB[i] = remap[eb[e]];
    edgeLen[i] = elen[e];
    edgeClass[i] = ecls[e];
    edgeBridge[i] = ebr[e];
    geoStart[i] = gp;
    for (let q = egs[e]; q < ege[e]; q++) {
      geoXY[2 * gp] = geo[2 * q];
      geoXY[2 * gp + 1] = geo[2 * q + 1];
      gp++;
    }
  });
  geoStart[edgeCount] = gp;

  const deg = new Uint32Array(nodeCount + 1);
  for (let e = 0; e < edgeCount; e++) {
    deg[edgeA[e]]++;
    deg[edgeB[e]]++;
  }
  const adjStart = new Uint32Array(nodeCount + 1);
  for (let i = 0; i < nodeCount; i++) adjStart[i + 1] = adjStart[i] + deg[i];
  const fill = adjStart.slice(0, nodeCount);
  const adjEdge = new Uint32Array(adjStart[nodeCount]);
  const adjTo = new Uint32Array(adjStart[nodeCount]);
  for (let e = 0; e < edgeCount; e++) {
    adjEdge[fill[edgeA[e]]] = e;
    adjTo[fill[edgeA[e]]++] = edgeB[e];
    adjEdge[fill[edgeB[e]]] = e;
    adjTo[fill[edgeB[e]]++] = edgeA[e];
  }

  // flood-grid cells under each non-bridge edge, sampled every half cell
  const cellStart = new Uint32Array(edgeCount + 1);
  const cells: number[] = [];
  const step = grid.cell / 2;
  for (let e = 0; e < edgeCount; e++) {
    cellStart[e] = cells.length;
    if (edgeBridge[e]) continue;
    let last = -1;
    for (let q = geoStart[e] + 1; q < geoStart[e + 1]; q++) {
      const ax = geoXY[2 * q - 2];
      const ay = geoXY[2 * q - 1];
      const bx = geoXY[2 * q];
      const by = geoXY[2 * q + 1];
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
      for (let s = 0; s <= n; s++) {
        const px = ax + ((bx - ax) * s) / n;
        const py = ay + ((by - ay) * s) / n;
        const i = Math.floor((px - grid.x0) / grid.cell);
        const j = Math.floor((py - grid.y0) / grid.cell);
        if (i < 0 || j < 0 || i >= grid.nx || j >= grid.ny) continue;
        const id = j * grid.nx + i;
        if (id === last || skip[id]) continue;
        last = id;
        cells.push(id);
      }
    }
  }
  cellStart[edgeCount] = cells.length;

  return {
    nodeCount,
    x,
    y,
    adjStart,
    adjEdge,
    adjTo,
    edgeCount,
    edgeA,
    edgeB,
    edgeLen,
    edgeClass,
    edgeBridge,
    geoStart,
    geoXY,
    cellStart,
    cellIds: Uint32Array.from(cells),
    hash: buildHash(x, y, nodeCount),
  };
}

function buildHash(x: Float32Array, y: Float32Array, n: number): SpatialHash {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, x[i]);
    maxX = Math.max(maxX, x[i]);
    minY = Math.min(minY, y[i]);
    maxY = Math.max(maxY, y[i]);
  }
  const w = Math.floor((maxX - minX) / HASH) + 1;
  const h = Math.floor((maxY - minY) / HASH) + 1;
  const counts = new Uint32Array(w * h + 1);
  const cellOf = (i: number) => Math.floor((y[i] - minY) / HASH) * w + Math.floor((x[i] - minX) / HASH);
  for (let i = 0; i < n; i++) counts[cellOf(i) + 1]++;
  for (let i = 0; i < w * h; i++) counts[i + 1] += counts[i];
  const fill = counts.slice(0, w * h);
  const nodes = new Uint32Array(n);
  for (let i = 0; i < n; i++) nodes[fill[cellOf(i)]++] = i;
  return { size: HASH, x0: minX, y0: minY, w, h, start: counts, nodes };
}

/** Nearest graph node to a point, or -1 if none lies within maxDist metres. */
export function nearestNode(g: RoadGraph, px: number, py: number, maxDist = 150): number {
  const H = g.hash;
  const ci = Math.floor((px - H.x0) / H.size);
  const cj = Math.floor((py - H.y0) / H.size);
  const rings = Math.ceil(maxDist / H.size) + 1;
  let best = -1;
  let bestD = maxDist * maxDist;
  for (let dj = -rings; dj <= rings; dj++) {
    const j = cj + dj;
    if (j < 0 || j >= H.h) continue;
    for (let di = -rings; di <= rings; di++) {
      const i = ci + di;
      if (i < 0 || i >= H.w) continue;
      const c = j * H.w + i;
      for (let q = H.start[c]; q < H.start[c + 1]; q++) {
        const n = H.nodes[q];
        const d = (g.x[n] - px) ** 2 + (g.y[n] - py) ** 2;
        if (d < bestD) {
          bestD = d;
          best = n;
        }
      }
    }
  }
  return best;
}

export interface EdgeDepths {
  /** deepest water anywhere along each edge, m */
  max: Float32Array;
  /** average water depth along each edge, m */
  mean: Float32Array;
}

/** Water depth on every road edge from the flood grid (h per cell, m). */
export function edgeDepths(g: RoadGraph, depth: Float32Array, out?: EdgeDepths): EdgeDepths {
  const max = out?.max ?? new Float32Array(g.edgeCount);
  const mean = out?.mean ?? new Float32Array(g.edgeCount);
  for (let e = 0; e < g.edgeCount; e++) {
    const a = g.cellStart[e];
    const b = g.cellStart[e + 1];
    let m = 0;
    let s = 0;
    for (let q = a; q < b; q++) {
      const d = depth[g.cellIds[q]];
      if (d > m) m = d;
      s += d;
    }
    max[e] = m;
    mean[e] = b > a ? s / (b - a) : 0;
  }
  return { max, mean };
}

/** Point along edge e at fraction t (0 = node A, 1 = node B), plus the heading there. */
export function edgePoint(g: RoadGraph, e: number, t: number): { x: number; y: number } {
  const a = g.geoStart[e];
  const b = g.geoStart[e + 1];
  const total = g.edgeLen[e] || 1;
  let want = t * total;
  for (let q = a + 1; q < b; q++) {
    const ax = g.geoXY[2 * q - 2];
    const ay = g.geoXY[2 * q - 1];
    const bx = g.geoXY[2 * q];
    const by = g.geoXY[2 * q + 1];
    const l = Math.hypot(bx - ax, by - ay);
    if (want <= l || q === b - 1) {
      const u = l > 0 ? Math.min(1, want / l) : 0;
      return { x: ax + (bx - ax) * u, y: ay + (by - ay) * u };
    }
    want -= l;
  }
  return { x: g.x[g.edgeA[e]], y: g.y[g.edgeA[e]] };
}
