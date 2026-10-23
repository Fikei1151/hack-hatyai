import { gridOrigin, type CityData } from '../engine/cityData';
import { buildRoadGraph, nearestNode, type GridInfo, type RoadGraph } from './roadGraph';

export interface House {
  x: number;
  y: number;
  cell: number;
  node: number;
  /** metres from the house to its nearest street junction */
  nodeDist: number;
  /** ground height above the nearest canal bank, m (negative = below the bank top) */
  hand: number;
}

export interface Site {
  id: string;
  name: string;
  kind: string;
  icon: string;
  x: number;
  y: number;
  cell: number;
  node: number;
  capacity: number;
  hospital: boolean;
  importance: number;
}

/** Everything the board game needs to know about the city, built once from the city data. */
export interface GameWorld {
  city: CityData;
  grid: GridInfo;
  graph: RoadGraph;
  permanent: Uint8Array;
  hand: Float32Array;
  houses: House[];
  sites: Site[];
}

const SHELTER_KINDS: Record<string, { cap: number; icon: string }> = {
  university: { cap: 16, icon: '🎓' },
  faculty: { cap: 10, icon: '🎓' },
  school: { cap: 12, icon: '🏫' },
  kindergarten: { cap: 6, icon: '🧸' },
  temple: { cap: 10, icon: '🛕' },
  mosque: { cap: 8, icon: '🕌' },
  church: { cap: 8, icon: '⛪' },
  community_centre: { cap: 12, icon: '🏛️' },
  government: { cap: 10, icon: '🏛️' },
  market: { cap: 14, icon: '🧺' },
  mall: { cap: 16, icon: '🛍️' },
  stadium: { cap: 14, icon: '🏟️' },
  shelter: { cap: 12, icon: '⛺' },
};

const KIND_TH: Record<string, string> = { university: 'มหาวิทยาลัย', faculty: 'คณะ', school: 'โรงเรียน', kindergarten: 'โรงเรียนอนุบาล', temple: 'วัด', mosque: 'มัสยิด', market: 'ตลาด', mall: 'ห้าง', hospital: 'โรงพยาบาล', government: 'สำนักงาน', community_centre: 'ศูนย์ชุมชน', stadium: 'สนามกีฬา' };

/** OSM names sometimes carry notes ("market (3 days per week)") or are just a bare English word. */
function siteName(raw: string, kind: string): string {
  const name = raw.replace(/\s*\([^)]*\)\s*$/, '').trim() || raw;
  const th = KIND_TH[kind];
  return th && !/[\u0E00-\u0E7F]/.test(name) && name.length < 14 ? `${th} ${name}` : name;
}

const worlds = new WeakMap<CityData, GameWorld>();

export function getWorld(city: CityData, permanent: Uint8Array): GameWorld {
  let w = worlds.get(city);
  if (!w) {
    w = createWorld(city, permanent);
    worlds.set(city, w);
  }
  return w;
}

export function createWorld(city: CityData, permanent: Uint8Array): GameWorld {
  const { meta } = city;
  const o = gridOrigin(meta);
  const grid: GridInfo = { nx: meta.nx, ny: meta.ny, cell: meta.cell, x0: o.x0, y0: o.y0 };
  const graph = buildRoadGraph(city.roads, grid, permanent);
  const hand = heightAboveBank(city, grid);
  const cellOf = (x: number, y: number) => {
    const i = Math.min(grid.nx - 1, Math.max(0, Math.floor((x - grid.x0) / grid.cell)));
    const j = Math.min(grid.ny - 1, Math.max(0, Math.floor((y - grid.y0) / grid.cell)));
    return j * grid.nx + i;
  };

  // homes: small buildings with a street within a short walk. Which cells count as "always water" for this
  // choice comes from the land cover alone (not the engine's spin-up result), so a scene code gives the
  // same homes, calls and cards on every machine.
  const houses: House[] = [];
  const staticWater = (cell: number) => city.landcover[cell * 4 + 1] > 0 || city.landcover[cell * 4 + 2] === 255;
  const b = city.buildings;
  for (let i = 0; i < b.count; i++) {
    const t = b.types[i];
    if ((t !== 0 && t !== 1 && t !== 2) || b.heights[i] > 14) continue;
    let sx = 0;
    let sy = 0;
    const n = b.vertCounts[i];
    for (let k = 0; k < n; k++) {
      sx += b.coords[2 * (b.offsets[i] + k)];
      sy += b.coords[2 * (b.offsets[i] + k) + 1];
    }
    const x = sx / n;
    const y = sy / n;
    const cell = cellOf(x, y);
    if (staticWater(cell)) continue;
    const node = nearestNode(graph, x, y, 70);
    if (node < 0) continue;
    houses.push({ x, y, cell, node, nodeDist: Math.hypot(graph.x[node] - x, graph.y[node] - y), hand: hand[cell] });
  }

  // shelters and hospitals from the important places
  const sites: Site[] = [];
  for (const p of city.places) {
    const hospital = p.kind === 'hospital';
    const k = SHELTER_KINDS[p.kind];
    if (!hospital && !k) continue;
    const node = nearestNode(graph, p.x, p.y, 300);
    if (node < 0) continue;
    const name = siteName(p.name, p.kind);
    if (sites.some((s) => s.name === name && Math.hypot(s.x - p.x, s.y - p.y) < 150)) continue;
    sites.push({ id: p.id, name, kind: p.kind, icon: hospital ? '🏥' : k.icon, x: p.x, y: p.y, cell: cellOf(p.x, p.y), node, capacity: hospital ? 10 : k.cap, hospital, importance: p.importance });
  }
  return { city, grid, graph, permanent, hand, houses, sites };
}

/**
 * Ground height above the top of the nearest canal bank (a cheap "height above nearest drainage"):
 * low or negative values flood first when the canals run full.
 */
export function heightAboveBank(city: CityData, grid: GridInfo, reach = 120): Float32Array {
  const { nx, ny } = grid;
  const n = nx * ny;
  const z = city.terrain;
  const lc = city.landcover;
  const bank = new Float32Array(n);
  const dist = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n; i++) {
    if (lc[i * 4 + 1] > 0) {
      bank[i] = z[i] + lc[i * 4 + 1] * 0.05;
      dist[i] = 1;
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const c = queue[head++];
    if (dist[c] > reach) continue;
    const ci = c % nx;
    const cj = (c - ci) / nx;
    for (let k = 0; k < 4; k++) {
      const i = ci + (k === 0 ? 1 : k === 1 ? -1 : 0);
      const j = cj + (k === 2 ? 1 : k === 3 ? -1 : 0);
      if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
      const m = j * nx + i;
      if (dist[m]) continue;
      dist[m] = dist[c] + 1;
      bank[m] = bank[c];
      queue[tail++] = m;
    }
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = dist[i] ? z[i] - bank[i] : 99;
  return out;
}

export function cellAt(world: GameWorld, x: number, y: number): number {
  const g = world.grid;
  const i = Math.min(g.nx - 1, Math.max(0, Math.floor((x - g.x0) / g.cell)));
  const j = Math.min(g.ny - 1, Math.max(0, Math.floor((y - g.y0) / g.cell)));
  return j * g.nx + i;
}
