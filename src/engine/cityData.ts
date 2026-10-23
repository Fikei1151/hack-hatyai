// Loads the pre-built city model produced by scripts/build-city.mjs.

export interface CityMeta {
  id: string;
  name: string;
  nameTh: string;
  generatedAt: string;
  origin: { lat: number; lon: number };
  projection: { mPerDegLat: number; mPerDegLon: number };
  cell: number;
  nx: number;
  ny: number;
  width: number;
  height: number;
  /** local metres of the grid's south-west corner (absent in older builds: grid centred on the origin) */
  x0?: number;
  y0?: number;
  /**
   * what lies beyond the north edge: 'lake' = the edge is in Songkhla Lake (its level is the boundary),
   * 'rating' (older builds) = lowland channel still to come, approximated by a backwater rating
   */
  outlet?: 'lake' | 'rating';
  bounds: { south: number; west: number; north: number; east: number };
  elevation: { min: number; max: number; p05: number; p50: number; p95: number };
  files: Record<'terrain' | 'landcover' | 'buildings' | 'waterways' | 'imageryBase' | 'imageryDetail' | 'roads' | 'roadLabels' | 'places', string> & { trees?: string };
  imagery: Record<'base' | 'detail', { file: string; zoom: number; x0: number; y0: number; x1: number; y1: number; size: number }>;
  buildings: { count: number };
  trees?: { count: number };
  inflows: { id: string; name: string; share: number; x: number; y: number }[];
  /**
   * gated channel cross-sections (local metres; t = unit vector downstream, halfWidth across the
   * channel) whose channel discharge may not exceed capM3s
   */
  regulators?: {
    id: string;
    name: string;
    x: number;
    y: number;
    tx: number;
    ty: number;
    halfWidth: number;
    capM3s: number;
    designM3s?: number;
    /** operating rule: release `fraction` of the inflows `of` (+ all of `plus`), never above capM3s */
    release?: { fraction: number; of: string[]; plus?: string[] };
  }[];
  gauges: { id: string; code: string; name: string; stationId: number; lat: number; lon: number; x: number; y: number; watch: number; critical: number; bank: number }[];
  pois: { id: string; name: string; en: string; lat: number; lon: number; x: number; y: number }[];
  places: { name: string; en: string; kind: string; x: number; y: number }[];
  attribution: string[];
}

export interface Waterway {
  name: string;
  type: string;
  width: number;
  depth: number;
  pts: [number, number][];
}

/** Building type codes written by the build script. */
export const BUILDING_TYPES = ['generic', 'house', 'shophouse', 'commercial', 'industrial', 'religious', 'education', 'hospital', 'civic', 'shed'] as const;

export interface BuildingSet {
  count: number;
  vertCounts: Uint16Array;
  heights: Float32Array; // metres
  types: Uint8Array;
  /** local metres, interleaved x,y */
  coords: Float32Array;
  offsets: Uint32Array; // first vertex index of each building
}

export interface RoadSet {
  count: number;
  vertCounts: Uint16Array;
  widths: Float32Array;
  /** low nibble = class (0 motorway … 6 service), bit 4 = bridge, bit 5 = one-way */
  flags: Uint8Array;
  coords: Float32Array;
  offsets: Uint32Array;
}

/** Trees planted from the satellite imagery, in random order (any prefix is an even thinning). */
export interface TreeSet {
  count: number;
  /** local metres, x east / y north */
  x: Float32Array;
  y: Float32Array;
  height: Float32Array; // m
  radius: Float32Array; // crown radius, m
  /** crown colour sampled from the imagery, sRGB bytes */
  color: Uint8Array;
}

export interface RoadLabel {
  name: string;
  en: string;
  cls: number;
  x: number;
  y: number;
}

export type PlaceCategory =
  | 'health'
  | 'education'
  | 'religion'
  | 'market'
  | 'shop'
  | 'emergency'
  | 'government'
  | 'transport'
  | 'lodging'
  | 'landmark'
  | 'shelter'
  | 'finance'
  | 'fuel'
  | 'community';

export interface Place {
  id: string;
  name: string;
  name_en: string | null;
  category: PlaceCategory;
  kind: string;
  importance: number;
  lat: number;
  lon: number;
  x: number;
  y: number;
  ground_m: number | null;
}

export interface CityData {
  meta: CityMeta;
  /** bed elevation per cell (m), row 0 = south */
  terrain: Float32Array;
  /** RGBA8 per cell: building fraction, channel mask, water-body mask, imperviousness */
  landcover: Uint8Array;
  buildings: BuildingSet;
  /** null for city builds made before trees were added */
  trees: TreeSet | null;
  roads: RoadSet;
  roadLabels: RoadLabel[];
  /** important places shipped with the city build (Supabase `places` overrides when online) */
  places: Place[];
  waterways: Waterway[];
  imageryBase: HTMLImageElement;
  imageryDetail: HTMLImageElement;
}

export type Progress = (stage: string, fraction: number) => void;

export async function loadCity(base: string, onProgress: Progress): Promise<CityData> {
  const url = (f: string) => `${base}/${f}`;
  onProgress('โหลดข้อมูลเมือง', 0.02);
  const meta: CityMeta = await (await fetchOk(url('meta.json'))).json();

  let done = 0;
  const steps = meta.files.trees ? 10 : 9;
  const tick = (label: string) => onProgress(label, 0.05 + (0.9 * ++done) / steps);

  const [terrainBuf, lcBuf, bBuf, waterways, imageryBase, imageryDetail, roadBuf, roadLabels, places, treeBuf] = await Promise.all([
    fetchOk(url(meta.files.terrain)).then((r) => r.arrayBuffer()).then((b) => (tick('ภูมิประเทศ (Copernicus DEM)'), b)),
    fetchOk(url(meta.files.landcover)).then((r) => r.arrayBuffer()).then((b) => (tick('การใช้ที่ดิน'), b)),
    fetchOk(url(meta.files.buildings)).then((r) => r.arrayBuffer()).then((b) => (tick('อาคาร (OpenStreetMap)'), b)),
    fetchOk(url(meta.files.waterways)).then((r) => r.json() as Promise<Waterway[]>).then((b) => (tick('คลองและทางน้ำ'), b)),
    loadImage(url(meta.files.imageryBase)).then((b) => (tick('ภาพถ่ายดาวเทียม'), b)),
    loadImage(url(meta.files.imageryDetail)).then((b) => (tick('ภาพถ่ายดาวเทียมละเอียด'), b)),
    fetchOk(url(meta.files.roads)).then((r) => r.arrayBuffer()).then((b) => (tick('ถนน (OpenStreetMap)'), b)),
    fetchOk(url(meta.files.roadLabels)).then((r) => r.json() as Promise<RoadLabel[]>).then((b) => (tick('ชื่อถนน'), b)),
    fetchOk(url(meta.files.places)).then((r) => r.json() as Promise<Place[]>).then((b) => (tick('สถานที่สำคัญ'), b)),
    meta.files.trees ? fetchOk(url(meta.files.trees)).then((r) => r.arrayBuffer()).then((b) => (tick('ต้นไม้ (จากภาพดาวเทียม)'), b)) : null,
  ]);

  const terrain = new Float32Array(terrainBuf);
  if (terrain.length !== meta.nx * meta.ny) throw new Error('terrain.f32 does not match meta.json grid size — rebuild the city data');
  return {
    meta,
    terrain,
    landcover: new Uint8Array(lcBuf),
    buildings: decodeBuildings(bBuf),
    trees: treeBuf ? decodeTrees(treeBuf) : null,
    roads: decodeRoads(roadBuf),
    roadLabels,
    places,
    waterways,
    imageryBase,
    imageryDetail,
  };
}

async function fetchOk(u: string) {
  const r = await fetch(u);
  if (!r.ok) throw new Error(`โหลด ${u} ไม่สำเร็จ (${r.status}) — รัน npm run city:build ก่อน`);
  return r;
}

function loadImage(u: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`โหลดภาพ ${u} ไม่สำเร็จ`));
    img.src = u;
  });
}

/**
 * Polygon/polyline files store int16 coordinates in 0.5 m units. Version 1 is relative to the
 * projection origin (±16 km); version 2 adds a float32 origin (the domain centre) to the header so
 * domains reaching further from the origin still fit.
 */
function polyHeader(dv: DataView, kind: 'HYB' | 'HYR', file: string) {
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  const v2 = magic === `${kind}2`;
  if (!v2 && magic !== `${kind}1`) throw new Error(`${file}: unknown format`);
  return {
    count: dv.getUint32(4, true),
    totalVerts: dv.getUint32(8, true),
    cx: v2 ? dv.getFloat32(12, true) : 0,
    cy: v2 ? dv.getFloat32(16, true) : 0,
    start: v2 ? 20 : 12,
  };
}

function decodeCoords(buf: ArrayBuffer, off: number, totalVerts: number, cx: number, cy: number) {
  const raw = new Int16Array(buf, off, totalVerts * 2);
  const coords = new Float32Array(totalVerts * 2);
  for (let i = 0; i < raw.length; i += 2) {
    coords[i] = cx + raw[i] * 0.5;
    coords[i + 1] = cy + raw[i + 1] * 0.5;
  }
  return coords;
}

export function decodeBuildings(buf: ArrayBuffer): BuildingSet {
  const { count, totalVerts, cx, cy, start } = polyHeader(new DataView(buf), 'HYB', 'buildings.bin');
  const pad4 = (n: number) => (n + 3) & ~3;
  const offCounts = start;
  const offHeights = offCounts + pad4(count * 2);
  const offTypes = offHeights + pad4(count * 2);
  const offCoords = offTypes + pad4(count);
  const vertCounts = new Uint16Array(buf, offCounts, count);
  const hDm = new Uint16Array(buf, offHeights, count);
  const types = new Uint8Array(buf, offTypes, count);
  const coords = decodeCoords(buf, offCoords, totalVerts, cx, cy);
  const heights = new Float32Array(count);
  const offsets = new Uint32Array(count);
  let v = 0;
  for (let i = 0; i < count; i++) {
    heights[i] = hDm[i] / 10;
    offsets[i] = v;
    v += vertCounts[i];
  }
  return { count, vertCounts, heights, types, coords, offsets };
}

function decodeTrees(buf: ArrayBuffer): TreeSet {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  // HYT1: int16 x/y in 0.25 m from the projection origin; HYT2: 0.5 m from a float32 origin in the header
  const v2 = magic === 'HYT2';
  if (!v2 && magic !== 'HYT1') throw new Error('trees.bin: unknown format');
  const count = dv.getUint32(4, true);
  const cx = v2 ? dv.getFloat32(8, true) : 0;
  const cy = v2 ? dv.getFloat32(12, true) : 0;
  const unit = v2 ? 0.5 : 0.25;
  const pad4 = (n: number) => (n + 3) & ~3;
  const offX = v2 ? 16 : 8;
  const offY = offX + pad4(count * 2);
  const offH = offY + pad4(count * 2);
  const offR = offH + pad4(count);
  const offC = offR + pad4(count);
  const qx = new Int16Array(buf, offX, count);
  const qy = new Int16Array(buf, offY, count);
  const qh = new Uint8Array(buf, offH, count);
  const qr = new Uint8Array(buf, offR, count);
  const x = new Float32Array(count);
  const y = new Float32Array(count);
  const height = new Float32Array(count);
  const radius = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    x[i] = cx + qx[i] * unit;
    y[i] = cy + qy[i] * unit;
    height[i] = qh[i] / 10;
    radius[i] = qr[i] / 10;
  }
  return { count, x, y, height, radius, color: new Uint8Array(buf, offC, count * 3) };
}

export function decodeRoads(buf: ArrayBuffer): RoadSet {
  const { count, totalVerts, cx, cy, start } = polyHeader(new DataView(buf), 'HYR', 'roads.bin');
  const pad4 = (n: number) => (n + 3) & ~3;
  const offCounts = start;
  const offWidth = offCounts + pad4(count * 2);
  const offCls = offWidth + pad4(count * 2);
  const offCoords = offCls + pad4(count);
  const vertCounts = new Uint16Array(buf, offCounts, count);
  const wDm = new Uint16Array(buf, offWidth, count);
  const flags = new Uint8Array(buf, offCls, count);
  const coords = decodeCoords(buf, offCoords, totalVerts, cx, cy);
  const widths = new Float32Array(count);
  const offsets = new Uint32Array(count);
  let v = 0;
  for (let i = 0; i < count; i++) {
    widths[i] = wDm[i] / 10;
    offsets[i] = v;
    v += vertCounts[i];
  }
  return { count, vertCounts, widths, flags, coords, offsets };
}

/** Local metres of the grid's south-west corner. */
export function gridOrigin(meta: CityMeta): { x0: number; y0: number } {
  return { x0: meta.x0 ?? -meta.width / 2, y0: meta.y0 ?? -meta.height / 2 };
}

/** Local metres of the middle of the domain. */
export function gridCentre(meta: CityMeta): { x: number; y: number } {
  const { x0, y0 } = gridOrigin(meta);
  return { x: x0 + meta.width / 2, y: y0 + meta.height / 2 };
}

/** Bilinear sample of a cell-centred grid at local metres (x east, y north). */
export function sampleGrid(meta: CityMeta, grid: Float32Array, x: number, y: number): number {
  const { x0, y0 } = gridOrigin(meta);
  const fi = Math.min(Math.max((x - x0) / meta.cell - 0.5, 0), meta.nx - 1.001);
  const fj = Math.min(Math.max((y - y0) / meta.cell - 0.5, 0), meta.ny - 1.001);
  const i = Math.floor(fi);
  const j = Math.floor(fj);
  const di = fi - i;
  const dj = fj - j;
  const n = meta.nx;
  const i1 = Math.min(i + 1, n - 1);
  const j1 = Math.min(j + 1, meta.ny - 1);
  return (grid[j * n + i] * (1 - di) + grid[j * n + i1] * di) * (1 - dj) + (grid[j1 * n + i] * (1 - di) + grid[j1 * n + i1] * di) * dj;
}

export function cellIndex(meta: CityMeta, x: number, y: number): number {
  const { x0, y0 } = gridOrigin(meta);
  const i = Math.min(meta.nx - 1, Math.max(0, Math.floor((x - x0) / meta.cell)));
  const j = Math.min(meta.ny - 1, Math.max(0, Math.floor((y - y0) / meta.cell)));
  return j * meta.nx + i;
}

export function toLatLon(meta: CityMeta, x: number, y: number): [number, number] {
  return [meta.origin.lat + y / meta.projection.mPerDegLat, meta.origin.lon + x / meta.projection.mPerDegLon];
}

export function toLocal(meta: CityMeta, lat: number, lon: number): [number, number] {
  return [(lon - meta.origin.lon) * meta.projection.mPerDegLon, (lat - meta.origin.lat) * meta.projection.mPerDegLat];
}
