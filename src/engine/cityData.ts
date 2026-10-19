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
  bounds: { south: number; west: number; north: number; east: number };
  elevation: { min: number; max: number; p05: number; p50: number; p95: number };
  files: Record<'terrain' | 'landcover' | 'buildings' | 'waterways' | 'imageryBase' | 'imageryDetail' | 'roads' | 'roadLabels' | 'places', string>;
  imagery: Record<'base' | 'detail', { file: string; zoom: number; x0: number; y0: number; x1: number; y1: number; size: number }>;
  buildings: { count: number };
  inflows: { id: string; name: string; share: number; x: number; y: number }[];
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

export interface RoadLabel {
  name: string;
  en: string;
  cls: number;
  x: number;
  y: number;
}

export type PlaceCategory = 'health' | 'education' | 'religion' | 'market' | 'emergency' | 'government' | 'transport' | 'lodging' | 'landmark' | 'shelter';

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
  const steps = 9;
  const tick = (label: string) => onProgress(label, 0.05 + (0.9 * ++done) / steps);

  const [terrainBuf, lcBuf, bBuf, waterways, imageryBase, imageryDetail, roadBuf, roadLabels, places] = await Promise.all([
    fetchOk(url(meta.files.terrain)).then((r) => r.arrayBuffer()).then((b) => (tick('ภูมิประเทศ (Copernicus DEM)'), b)),
    fetchOk(url(meta.files.landcover)).then((r) => r.arrayBuffer()).then((b) => (tick('การใช้ที่ดิน'), b)),
    fetchOk(url(meta.files.buildings)).then((r) => r.arrayBuffer()).then((b) => (tick('อาคาร (OpenStreetMap)'), b)),
    fetchOk(url(meta.files.waterways)).then((r) => r.json() as Promise<Waterway[]>).then((b) => (tick('คลองและทางน้ำ'), b)),
    loadImage(url(meta.files.imageryBase)).then((b) => (tick('ภาพถ่ายดาวเทียม'), b)),
    loadImage(url(meta.files.imageryDetail)).then((b) => (tick('ภาพถ่ายดาวเทียมละเอียด'), b)),
    fetchOk(url(meta.files.roads)).then((r) => r.arrayBuffer()).then((b) => (tick('ถนน (OpenStreetMap)'), b)),
    fetchOk(url(meta.files.roadLabels)).then((r) => r.json() as Promise<RoadLabel[]>).then((b) => (tick('ชื่อถนน'), b)),
    fetchOk(url(meta.files.places)).then((r) => r.json() as Promise<Place[]>).then((b) => (tick('สถานที่สำคัญ'), b)),
  ]);

  const terrain = new Float32Array(terrainBuf);
  if (terrain.length !== meta.nx * meta.ny) throw new Error('terrain.f32 does not match meta.json grid size — rebuild the city data');
  return {
    meta,
    terrain,
    landcover: new Uint8Array(lcBuf),
    buildings: decodeBuildings(bBuf),
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

function decodeBuildings(buf: ArrayBuffer): BuildingSet {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'HYB1') throw new Error('buildings.bin: unknown format');
  const count = dv.getUint32(4, true);
  const totalVerts = dv.getUint32(8, true);
  const pad4 = (n: number) => (n + 3) & ~3;
  const offCounts = 12;
  const offHeights = offCounts + pad4(count * 2);
  const offTypes = offHeights + pad4(count * 2);
  const offCoords = offTypes + pad4(count);
  const vertCounts = new Uint16Array(buf, offCounts, count);
  const hDm = new Uint16Array(buf, offHeights, count);
  const types = new Uint8Array(buf, offTypes, count);
  const raw = new Int16Array(buf, offCoords, totalVerts * 2);
  const coords = new Float32Array(totalVerts * 2);
  for (let i = 0; i < raw.length; i++) coords[i] = raw[i] * 0.5;
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

function decodeRoads(buf: ArrayBuffer): RoadSet {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'HYR1') throw new Error('roads.bin: unknown format');
  const count = dv.getUint32(4, true);
  const totalVerts = dv.getUint32(8, true);
  const pad4 = (n: number) => (n + 3) & ~3;
  const offCounts = 12;
  const offWidth = offCounts + pad4(count * 2);
  const offCls = offWidth + pad4(count * 2);
  const offCoords = offCls + pad4(count);
  const vertCounts = new Uint16Array(buf, offCounts, count);
  const wDm = new Uint16Array(buf, offWidth, count);
  const flags = new Uint8Array(buf, offCls, count);
  const raw = new Int16Array(buf, offCoords, totalVerts * 2);
  const coords = new Float32Array(totalVerts * 2);
  for (let i = 0; i < raw.length; i++) coords[i] = raw[i] * 0.5;
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

/** Bilinear sample of a cell-centred grid at local metres (x east, y north). */
export function sampleGrid(meta: CityMeta, grid: Float32Array, x: number, y: number): number {
  const fi = Math.min(Math.max((x + meta.width / 2) / meta.cell - 0.5, 0), meta.nx - 1.001);
  const fj = Math.min(Math.max((y + meta.height / 2) / meta.cell - 0.5, 0), meta.ny - 1.001);
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
  const i = Math.min(meta.nx - 1, Math.max(0, Math.floor((x + meta.width / 2) / meta.cell)));
  const j = Math.min(meta.ny - 1, Math.max(0, Math.floor((y + meta.height / 2) / meta.cell)));
  return j * meta.nx + i;
}

export function toLatLon(meta: CityMeta, x: number, y: number): [number, number] {
  return [meta.origin.lat + y / meta.projection.mPerDegLat, meta.origin.lon + x / meta.projection.mPerDegLon];
}

export function toLocal(meta: CityMeta, lat: number, lon: number): [number, number] {
  return [(lon - meta.origin.lon) * meta.projection.mPerDegLon, (lat - meta.origin.lat) * meta.projection.mPerDegLat];
}
