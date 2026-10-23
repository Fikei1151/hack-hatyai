// Node-side loader for the pre-built city (no images), used by the game's headless tests.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeBuildings, decodeRoads, type CityData, type CityMeta, type Place, type Waterway } from '../../src/engine/cityData';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/city/hatyai');
const ab = (f: string) => {
  const b = fs.readFileSync(path.join(ROOT, f));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const json = <T>(f: string) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')) as T;

export function loadCityNode(): CityData {
  const meta = json<CityMeta>('meta.json');
  return {
    meta,
    terrain: new Float32Array(ab(meta.files.terrain)),
    landcover: new Uint8Array(ab(meta.files.landcover)),
    buildings: decodeBuildings(ab(meta.files.buildings)),
    trees: null,
    roads: decodeRoads(ab(meta.files.roads)),
    roadLabels: [],
    places: json<Place[]>(meta.files.places),
    waterways: json<Waterway[]>(meta.files.waterways),
    imageryBase: null as unknown as HTMLImageElement,
    imageryDetail: null as unknown as HTMLImageElement,
  };
}

/** the same "always water" mask the engine builds: canal cells and ponds */
export function permanentMask(city: CityData): Uint8Array {
  const n = city.meta.nx * city.meta.ny;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = city.landcover[i * 4 + 1] > 0 || city.landcover[i * 4 + 2] === 255 ? 1 : 0;
  return out;
}
