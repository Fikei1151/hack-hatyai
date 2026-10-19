#!/usr/bin/env node
// Build a simulation-ready 3D model of Hat Yai (หาดใหญ่) from open data:
//   • Terrain        — Copernicus GLO-30 DEM (ESA), cloud-optimised GeoTIFFs on AWS Open Data
//   • Buildings      — OpenStreetMap footprints (Overpass API), heights from tags or estimated
//   • Canals/ponds   — OpenStreetMap waterways, burned into the DEM so they actually carry water
//   • Landmarks      — OpenStreetMap
//   • Imagery        — Esri World Imagery tiles
//
// Usage: node scripts/build-city.mjs [--cell 20] [--refresh]
// Output: public/city/hatyai/*  (raw API responses are cached in .cache/)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromUrl } from 'geotiff';
import sharp from 'sharp';
import { makeProjection, lonToTileX, latToTileY, hash01, polygonArea, polygonCentroid } from './lib/geo.mjs';
import { overpass, cached, fetchBuffer, mapLimit } from './lib/fetchers.mjs';
import * as R from './lib/raster.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? true : all[i + 1]] : [])).filter((e) => e.length),
);

const CITY = {
  id: 'hatyai',
  name: 'Hat Yai',
  nameTh: 'หาดใหญ่',
  center: { lat: 7.01, lon: 100.47 },
  halfSize: 7200, // metres → 14.4 km × 14.4 km domain
  cell: Number(args.cell ?? 20),
  detail: { lat: 7.0065, lon: 100.4725, halfSize: 2400 }, // high-res imagery over the city core
};

// RID telemetry gauges inside the domain (ThaiWater station ids) with official warning levels (m MSL)
const GAUGES = [
  { id: 'x44', code: 'X.44', name: 'บ้านหาดใหญ่ใน (คลองอู่ตะเภา)', stationId: 2591, lat: 7.00218, lon: 100.456062, watch: 6.0, critical: 7.4, bank: 8.3 },
  { id: 'x174', code: 'X.174', name: 'บ้านคลองหวะ (คลองหวะ)', stationId: 2590, lat: 6.98637, lon: 100.481857, watch: 7.4, critical: 8.88, bank: 8.88 },
];
// building type codes stored in buildings.bin (mirrored in src/engine/cityData.ts)
const BTYPE = { generic: 0, house: 1, shophouse: 2, commercial: 3, industrial: 4, religious: 5, education: 6, hospital: 7, civic: 8, shed: 9 };
// OSM highway class → [render class, default carriageway width m]
const ROAD_CLASS = {
  motorway: [0, 22],
  trunk: [1, 18],
  primary: [2, 14],
  secondary: [3, 11],
  tertiary: [4, 9],
  unclassified: [5, 6.5],
  residential: [5, 6],
  living_street: [5, 5],
  service: [6, 4],
  pedestrian: [6, 4],
};
const OUT = path.join(ROOT, 'public', 'city', CITY.id);
const CACHE = path.join(ROOT, '.cache', CITY.id);
const refresh = Boolean(args.refresh);
const log = (...m) => console.log(...m);
const t0 = Date.now();
const step = (msg) => log(`\n[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

const proj = makeProjection(CITY.center.lat, CITY.center.lon);
const nx = Math.round((2 * CITY.halfSize) / CITY.cell);
const ny = nx;
const grid = new R.Grid(nx, ny, CITY.cell, -(nx * CITY.cell) / 2, -(ny * CITY.cell) / 2);
const [south, west] = proj.toLatLon(grid.x0, grid.y0);
const [north, east] = proj.toLatLon(grid.x0 + nx * CITY.cell, grid.y0 + ny * CITY.cell);
const bbox = `${south.toFixed(5)},${west.toFixed(5)},${north.toFixed(5)},${east.toFixed(5)}`;
// waterways are fetched with a margin so canals entering the domain are complete
const [mS, mW] = proj.toLatLon(grid.x0 - 4000, grid.y0 - 4000);
const [mN, mE] = proj.toLatLon(-grid.x0 + 4000, -grid.y0 + 4000);
const bboxWide = `${mS.toFixed(5)},${mW.toFixed(5)},${mN.toFixed(5)},${mE.toFixed(5)}`;

await fs.mkdir(OUT, { recursive: true });
log(`City: ${CITY.nameTh} (${CITY.name})  grid ${nx}×${ny} @ ${CITY.cell} m  bbox ${bbox}`);

// ─────────────────────────────────────────────────────────────── 1. DEM
step('Terrain: reading Copernicus GLO-30 DEM windows (HTTP range requests)…');
const sampleDEM = await openCopernicus({ south: south - 0.01, west: west - 0.01, north: north + 0.01, east: east + 0.01 });
const zRaw = new Float32Array(grid.size);
for (let j = 0; j < ny; j++)
  for (let i = 0; i < nx; i++) {
    const [x, y] = grid.center(i, j);
    const [lat, lon] = proj.toLatLon(x, y);
    zRaw[j * nx + i] = sampleDEM(lat, lon);
  }
log(`  elevation range ${stats(zRaw).min.toFixed(1)} … ${stats(zRaw).max.toFixed(1)} m (EGM2008)`);

// ─────────────────────────────────────────────────────────────── 2. OSM
step('OpenStreetMap: landmarks…');
const poiJson = await overpass(
  `[out:json][timeout:180];(
    nwr["railway"="station"](${bbox});
    nwr["amenity"~"^(hospital|university|townhall|bus_station)$"](${bbox});
    nwr["shop"="mall"](${bbox});
    nwr["amenity"="marketplace"](${bbox});
    node["place"~"^(suburb|neighbourhood|quarter|village|town|city)$"](${bbox});
  );out center tags;`,
  path.join(CACHE, 'osm_pois.json'),
  { refresh, log },
);
const { pois, places, downtown } = pickLandmarks(poiJson.elements);
log(`  ${pois.length} landmarks, ${places.length} place labels; downtown anchor ${downtown.name}`);

step('OpenStreetMap: waterways…');
const wwJson = await overpass(
  `[out:json][timeout:240];(way["waterway"~"^(river|canal|stream|drain|ditch)$"](${bboxWide}););out tags geom;`,
  path.join(CACHE, 'osm_waterways.json'),
  { refresh, log },
);
step('OpenStreetMap: water bodies…');
const wbJson = await overpass(
  `[out:json][timeout:240];(way["natural"="water"](${bbox});relation["natural"="water"](${bbox});way["landuse"~"^(reservoir|basin)$"](${bbox}););out geom;`,
  path.join(CACHE, 'osm_waterbodies.json'),
  { refresh, log },
);
step('OpenStreetMap: building footprints (large query)…');
const bJson = await overpass(
  `[out:json][timeout:600][maxsize:1073741824];(way["building"](${bbox});relation["building"]["type"="multipolygon"](${bbox}););out geom qt;`,
  path.join(CACHE, 'osm_buildings.json'),
  { refresh, log },
);

step('OpenStreetMap: roads…');
const roadJson = await overpass(
  `[out:json][timeout:300];(way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|pedestrian)$"](${bbox}););out tags geom qt;`,
  path.join(CACHE, 'osm_roads.json'),
  { refresh, log },
);
step('OpenStreetMap: important places…');
const placeJson = await overpass(
  `[out:json][timeout:240];(
    nwr["amenity"~"^(hospital|clinic|doctors|school|university|college|kindergarten|place_of_worship|marketplace|police|fire_station|townhall|community_centre|bus_station|library|social_facility|nursing_home|shelter|courthouse|post_office)$"](${bbox});
    nwr["shop"~"^(mall|supermarket|department_store)$"](${bbox});
    nwr["railway"="station"](${bbox});
    nwr["aeroway"="aerodrome"](${bbox});
    nwr["tourism"~"^(hotel|museum|attraction)$"](${bbox});
    nwr["leisure"~"^(park|stadium|sports_centre)$"]["name"](${bbox});
    nwr["office"="government"](${bbox});
    nwr["emergency"="assembly_point"](${bbox});
  );out center tags;`,
  path.join(CACHE, 'osm_places.json'),
  { refresh, log },
);

// ─────────────────────────────────────────────────────────────── 3. Buildings
step('Processing buildings…');
const buildings = processBuildings(bJson.elements, downtown);
log(`  ${buildings.length} buildings kept, ${buildings.filter((b) => b.tagged).length} with tagged height/levels`);
const buildingFrac = R.polygonCoverage(
  buildings.map((b) => b.pts),
  grid,
  4,
);

// ─────────────────────────────────────────────────────────────── 4. DEM conditioning
step('Conditioning DEM (urban DSM→DTM, smoothing, canal burning)…');
// Copernicus is a surface model (X-band radar): in Hat Yai's dense shophouse blocks the "ground"
// it reports sits metres up the buildings. Subtract part of the building volume seen at the DEM's
// 30 m footprint (OSM coverage × height, towers capped — radar layover makes them unreliable).
// River banks are left alone: the DSM there carries the real bank/flood-wall crests (RID X.44:
// left bank 7.15 m, right bank 8.66 m MSL), which decide when the city overtops.
const bldHeightCov = R.polygonCoverage(
  buildings.map((b) => b.pts),
  grid,
  4,
  buildings.map((b) => Math.min(b.h, 15)),
);
// smoothed at block scale so big single buildings (malls, hotels) do not leave holes in the ground
const dsmBias = R.gaussianBlur(bldHeightCov, nx, ny, 70 / CITY.cell);
const bankZone = new Uint8Array(grid.size);
for (const el of wwJson.elements) {
  const name = el.tags?.name ?? '';
  if (el.type !== 'way' || !/อู่ตะเภา|อุ่ตะเภา|ร\.\s?1(?!\d)|คลองหวะ/.test(name)) continue;
  const pts = el.geometry.map((g) => proj.toLocal(g.lat, g.lon));
  const reach = channelParams(el.tags).width / 2 + 70;
  for (const [x, y] of R.densify(pts, CITY.cell / 2)) {
    const [fi, fj] = grid.frac(x, y);
    const r = Math.ceil(reach / CITY.cell);
    for (let dj = -r; dj <= r; dj++)
      for (let di = -r; di <= r; di++) {
        const i = Math.round(fi) + di;
        const j = Math.round(fj) + dj;
        if (i < 0 || j < 0 || i >= nx || j >= ny || Math.hypot(di, dj) * CITY.cell > reach) continue;
        bankZone[j * nx + i] = 1;
      }
  }
}
const zDtm = new Float32Array(grid.size);
// calibrated so the Kim Yong / clock-tower area sits near 9 m MSL (≈1 m deep when X.44 peaked at 9.97 m in 2025)
for (let id = 0; id < grid.size; id++) zDtm[id] = zRaw[id] - (bankZone[id] ? 0 : 1.0 * dsmBias[id]);
// no building-shaped holes: in built-up areas the ground may not sit more than 1 m below its
// 150 m neighbourhood average
{
  const bf150 = R.gaussianBlur(buildingFrac, nx, ny, 150 / CITY.cell);
  const zAvg = R.gaussianBlur(zDtm, nx, ny, 150 / CITY.cell);
  for (let id = 0; id < grid.size; id++) if (bf150[id] > 0.05 && !bankZone[id]) zDtm[id] = Math.max(zDtm[id], zAvg[id] - 1.0);
}
{
  const s = stats(dsmBias);
  log(`  DSM building bias: median ${s.p50.toFixed(2)} m, p95 ${s.p95.toFixed(2)} m, max ${s.max.toFixed(1)} m (river banks kept)`);
}
// Built-up density at ~100 m scale drives where remaining building bumps are removed.
const urban = R.gaussianBlur(buildingFrac, nx, ny, 100 / CITY.cell);
const zOpen = R.opening(zDtm, nx, ny, Math.max(1, Math.round(50 / CITY.cell)));
const zSm = R.gaussianBlur(zDtm, nx, ny, 60 / CITY.cell);
const z = new Float32Array(grid.size);
for (let j = 0; j < ny; j++)
  for (let i = 0; i < nx; i++) {
    const id = j * nx + i;
    const sx = (zSm[j * nx + Math.min(nx - 1, i + 1)] - zSm[j * nx + Math.max(0, i - 1)]) / (2 * CITY.cell);
    const sy = (zSm[Math.min(ny - 1, j + 1) * nx + i] - zSm[Math.max(0, j - 1) * nx + i]) / (2 * CITY.cell);
    const flat = 1 - Math.min(1, Math.max(0, (Math.hypot(sx, sy) - 0.02) / 0.04));
    const w = Math.min(1, Math.max(0, (urban[id] - 0.06) / 0.14)) * flat;
    z[id] = zDtm[id] + (zOpen[id] - zDtm[id]) * w;
  }
const zSmooth = R.gaussianBlur(z, nx, ny, 0.8);
// fill DEM noise pits (≤ 0.8 m, ≤ 3 m in built-up areas where subtracting large buildings leaves
// holes) so rain runs off to the canals instead of speckling the city with puddles; deeper
// depressions are real basins (paddies, retention areas) and keep their storage
const zFilled = R.priorityFlood(zSmooth, nx, ny);
const zCond = new Float32Array(grid.size);
let filledCells = 0;
for (let id = 0; id < grid.size; id++) {
  const d = zFilled[id] - zSmooth[id];
  if (d > 0.01) filledCells++;
  zCond[id] = zSmooth[id] + Math.min(d, urban[id] > 0.1 ? 3 : 0.8);
}
log(`  filled ${filledCells} pit cells (≤ 0.8 m, ≤ 3 m in built-up areas)`);
const zBank = R.gaussianBlur(zCond, nx, ny, 40 / CITY.cell);
const channelMask = new Uint8Array(grid.size);
// 1 = natural river/stream (rough, vegetated banks, bridges), 2 = lined canal (concrete)
const channelKind = new Uint8Array(grid.size);

const waterways = [];
for (const el of wwJson.elements) {
  if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
  let pts = el.geometry.map((g) => proj.toLocal(g.lat, g.lon));
  if (!pts.some(([x, y]) => grid.contains(x, y, -200))) continue;
  // OSM waterways should point downstream; flip the rare ones drawn uphill so the running-min bed profile is valid
  const zStart = R.sampleBilinear(zBank, nx, ny, ...grid.frac(...pts[0]));
  const zEnd = R.sampleBilinear(zBank, nx, ny, ...grid.frac(...pts[pts.length - 1]));
  if (grid.contains(...pts[0]) && grid.contains(...pts[pts.length - 1]) && zStart < zEnd - 3) pts = pts.reverse();
  const p = channelParams(el.tags ?? {});
  const lined = (el.tags?.waterway === 'canal' || el.tags?.waterway === 'drain' || el.tags?.material === 'concrete') && !/อู่ตะเภา|อุ่ตะเภา|คลองหวะ/.test(el.tags?.name ?? '');
  waterways.push({ id: el.id, name: el.tags?.name ?? '', type: el.tags?.waterway, lined, ...p, pts });
}
// bank profiles, continued across split OSM ways so reaches join without sills
for (const w of waterways) w.prof = R.channelProfile(grid, w.pts, zBank);
const nodeKey = ([x, y]) => `${Math.round(x)},${Math.round(y)}`;
const endsAt = new Map();
for (const w of waterways) {
  const k = nodeKey(w.pts[w.pts.length - 1]);
  if (!endsAt.has(k)) endsAt.set(k, []);
  endsAt.get(k).push(w);
}
for (let iter = 0; iter < 40; iter++) {
  let changed = false;
  for (const w of waterways) {
    let cap = Infinity;
    for (const u of endsAt.get(nodeKey(w.pts[0])) ?? []) if (u !== w) cap = Math.min(cap, u.prof.bank[u.prof.bank.length - 1]);
    if (cap < w.prof.bank[0] - 1e-3) {
      w.prof = R.channelProfile(grid, w.pts, zBank, cap);
      changed = true;
    }
  }
  if (!changed) break;
}
// burn small ones first so main canals (deeper) win where they overlap
const zBeforeBurn = Float32Array.from(zCond);
waterways.sort((a, b) => a.depth - b.depth);
for (const w of waterways) {
  const effW = Math.max(w.width, 1.5 * CITY.cell); // keep channels 4-connected on the grid
  const effD = w.depth * Math.sqrt(w.width / effW);
  R.burnChannel(zCond, channelMask, grid, w.prof, { width: effW, depth: effD, bankWidth: Math.max(10, CITY.cell * 0.75), kind: w.lined ? 2 : 1, kindMask: channelKind });
}
log(`  burned ${waterways.length} waterways (${(waterways.reduce((s, w) => s + pathLen(w.pts), 0) / 1000).toFixed(0)} km)`);

const waterPolys = [];
for (const el of wbJson.elements) {
  if (el.type === 'way' && el.geometry?.length > 3) waterPolys.push(el.geometry.map((g) => proj.toLocal(g.lat, g.lon)));
  if (el.type === 'relation') for (const ring of assembleRings((el.members ?? []).filter((m) => m.role === 'outer'))) waterPolys.push(ring);
}
const waterFrac = R.polygonCoverage(waterPolys, grid, 2);
const waterMask = new Uint8Array(grid.size);
let pondCells = 0;
for (let id = 0; id < grid.size; id++)
  if (waterFrac[id] >= 0.5) {
    waterMask[id] = 255;
    if (!channelMask[id]) {
      // the DEM over a pond is its water surface: give it 1.5 m of depth below that surface
      zCond[id] -= 1.5;
      pondCells++;
    }
  }
log(`  ${waterPolys.length} water bodies (${((pondCells * CITY.cell * CITY.cell) / 1e6).toFixed(2)} km² of ponds lowered 1.5 m)`);

// ─────────────────────────────────────────────────────────────── 5. Inflow points
const inflows = findInflows(waterways);
for (const f of inflows) log(`  inflow ${f.name}: (${f.x.toFixed(0)}, ${f.y.toFixed(0)}) share ${f.share}`);

// ─────────────────────────────────────────────────────────────── 6. Imagery
step('Imagery: Esri World Imagery tiles…');
const imgBase = await buildImagery('imagery_base.jpg', 15, { south, west, north, east }, 3072);
const [dS, dW] = proj.toLatLon(...proj.toLocal(CITY.detail.lat, CITY.detail.lon).map((v) => v - CITY.detail.halfSize));
const [dN, dE] = proj.toLatLon(...proj.toLocal(CITY.detail.lat, CITY.detail.lon).map((v) => v + CITY.detail.halfSize));
const imgDetail = await buildImagery('imagery_detail.jpg', 17, { south: dS, west: dW, north: dN, east: dE }, 4096);

// ─────────────────────────────────────────────────────────────── 7. Write outputs
step('Writing outputs…');
await fs.writeFile(path.join(OUT, 'terrain.f32'), Buffer.from(zCond.buffer));
const lc = new Uint8Array(grid.size * 4);
for (let id = 0; id < grid.size; id++) {
  lc[id * 4] = Math.round(buildingFrac[id] * 255);
  // channel cells store their depth below the banks (5 cm units, ≥ 1) so the client can start
  // canals with realistic base flow; 0 = not a channel
  // (the burned trough's side slopes count as channel too, so they are not reported as "flooded")
  const burned = zBeforeBurn[id] - zCond[id];
  lc[id * 4 + 1] = channelMask[id] || burned > 0.5 ? Math.max(1, Math.min(255, Math.round(burned / 0.05))) : 0;
  // B: 255 = pond / water body, 10 = natural channel, 20 = lined canal, 0 = land
  lc[id * 4 + 2] = waterMask[id] && !channelMask[id] ? 255 : channelMask[id] ? (channelKind[id] === 2 ? 20 : 10) : 0;
  lc[id * 4 + 3] = Math.round(Math.min(1, urban[id] * 2.2) * 255); // imperviousness
}
await fs.writeFile(path.join(OUT, 'landcover.rgba'), Buffer.from(lc.buffer));
await fs.writeFile(path.join(OUT, 'buildings.bin'), encodeBuildings(buildings));
const wwOut = waterways
  .filter((w) => w.name || w.depth >= 3)
  .map((w) => ({ name: w.name, type: w.type, width: w.width, depth: w.depth, pts: w.pts.map(([x, y]) => [Math.round(x), Math.round(y)]) }));
await fs.writeFile(path.join(OUT, 'waterways.json'), JSON.stringify(wwOut));

const roads = processRoads(roadJson.elements);
await fs.writeFile(path.join(OUT, 'roads.bin'), encodeRoads(roads.list));
await fs.writeFile(path.join(OUT, 'road_labels.json'), JSON.stringify(roads.labels));
log(`  ${roads.list.length} road segments, ${roads.labels.length} named main roads`);

const keyPlaces = processPlaces(placeJson.elements);
await fs.writeFile(path.join(OUT, 'places.json'), JSON.stringify(keyPlaces));
await fs.mkdir(path.join(ROOT, 'supabase', 'seeds'), { recursive: true });
await fs.writeFile(path.join(ROOT, 'supabase', 'seeds', 'places.sql'), placesSeedSql(keyPlaces));
log(`  ${keyPlaces.length} important places → public/city/${CITY.id}/places.json + supabase/seeds/places.sql`);

const zs = stats(zCond);
const meta = {
  id: CITY.id,
  name: CITY.name,
  nameTh: CITY.nameTh,
  generatedAt: new Date().toISOString(),
  origin: CITY.center,
  projection: { mPerDegLat: proj.mLat, mPerDegLon: proj.mLon },
  cell: CITY.cell,
  nx,
  ny,
  width: nx * CITY.cell,
  height: ny * CITY.cell,
  bounds: { south, west, north, east },
  elevation: { min: zs.min, max: zs.max, p05: zs.p05, p50: zs.p50, p95: zs.p95 },
  files: {
    terrain: 'terrain.f32',
    landcover: 'landcover.rgba',
    buildings: 'buildings.bin',
    waterways: 'waterways.json',
    roads: 'roads.bin',
    roadLabels: 'road_labels.json',
    places: 'places.json',
    imageryBase: 'imagery_base.jpg',
    imageryDetail: 'imagery_detail.jpg',
  },
  imagery: { base: imgBase, detail: imgDetail },
  buildings: { count: buildings.length },
  inflows,
  gauges: GAUGES.map((g) => {
    const [x, y] = proj.toLocal(g.lat, g.lon);
    return { ...g, x, y };
  }),
  pois,
  places,
  attribution: [
    'Terrain: Copernicus GLO-30 DEM © DLR e.V. 2010-2014 and © Airbus 2014-2018, provided under COPERNICUS by the European Union and ESA',
    'Buildings, canals, landmarks: © OpenStreetMap contributors (ODbL)',
    'Imagery: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  ],
};
await fs.writeFile(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 1));
step(`Done → ${path.relative(ROOT, OUT)}`);
for (const f of await fs.readdir(OUT)) {
  const s = await fs.stat(path.join(OUT, f));
  log(`  ${f.padEnd(22)} ${(s.size / 1024 / 1024).toFixed(2)} MB`);
}

// ═══════════════════════════════════════════════════════════════ helpers

async function openCopernicus(b) {
  const tiles = [];
  for (let la = Math.floor(b.south); la <= Math.floor(b.north); la++)
    for (let lo = Math.floor(b.west); lo <= Math.floor(b.east); lo++) {
      const ns = la >= 0 ? 'N' : 'S';
      const ew = lo >= 0 ? 'E' : 'W';
      const name = `Copernicus_DSM_COG_10_${ns}${String(Math.abs(la)).padStart(2, '0')}_00_${ew}${String(Math.abs(lo)).padStart(3, '0')}_00_DEM`;
      const url = `https://copernicus-dem-30m.s3.amazonaws.com/${name}/${name}.tif`;
      const cacheFile = path.join(CACHE, `dem_${name}_${b.south.toFixed(3)}_${b.west.toFixed(3)}_${b.north.toFixed(3)}_${b.east.toFixed(3)}.json`);
      const buf = await cached(
        cacheFile,
        async () => {
          log(`  ${name}`);
          const tiff = await fromUrl(url);
          const img = await tiff.getImage();
          const [ox, oy] = img.getOrigin();
          const [rx, ry] = img.getResolution();
          const W = img.getWidth();
          const H = img.getHeight();
          const half = img.getGeoKeys()?.GTRasterTypeGeoKey === 2 ? 0 : 0.5;
          const c0 = Math.max(0, Math.floor((b.west - ox) / rx) - 2);
          const c1 = Math.min(W, Math.ceil((b.east - ox) / rx) + 2);
          const r0 = Math.max(0, Math.floor((b.north - oy) / ry) - 2);
          const r1 = Math.min(H, Math.ceil((b.south - oy) / ry) + 2);
          if (c1 <= c0 || r1 <= r0) return Buffer.from('null');
          const ras = await img.readRasters({ window: [c0, r0, c1, r1], samples: [0], interleave: true });
          return Buffer.from(JSON.stringify({ ox, oy, rx, ry, c0, r0, w: c1 - c0, h: r1 - r0, half, data: Array.from(ras, (v) => Math.round(v * 100) / 100) }));
        },
        { refresh },
      );
      const t = JSON.parse(buf.toString());
      if (t) tiles.push(t);
    }
  if (!tiles.length) throw new Error('No DEM tiles intersect the domain');
  return (lat, lon) => {
    let best = null;
    for (const t of tiles) {
      const fc = (lon - t.ox) / t.rx - t.half - t.c0;
      const fr = (lat - t.oy) / t.ry - t.half - t.r0;
      const inside = fc >= 0 && fr >= 0 && fc <= t.w - 1 && fr <= t.h - 1;
      if (inside) return bilinear(t, fc, fr);
      if (fc > -2 && fr > -2 && fc < t.w + 1 && fr < t.h + 1) best = [t, fc, fr];
    }
    if (best) return bilinear(best[0], Math.min(Math.max(best[1], 0), best[0].w - 1), Math.min(Math.max(best[2], 0), best[0].h - 1));
    return NaN;
  };
}

function bilinear(t, fc, fr) {
  const c = Math.min(Math.floor(fc), t.w - 2);
  const r = Math.min(Math.floor(fr), t.h - 2);
  const dc = fc - c;
  const dr = fr - r;
  const d = t.data;
  return (d[r * t.w + c] * (1 - dc) + d[r * t.w + c + 1] * dc) * (1 - dr) + (d[(r + 1) * t.w + c] * (1 - dc) + d[(r + 1) * t.w + c + 1] * dc) * dr;
}

function stats(a) {
  const s = Float32Array.from(a).sort();
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { min: s[0], max: s[s.length - 1], p05: q(0.05), p50: q(0.5), p95: q(0.95) };
}

/** Join multipolygon member ways that share endpoints into closed rings (local metres). */
function assembleRings(members) {
  const segs = members.filter((m) => m.geometry?.length > 1).map((m) => m.geometry.map((g) => proj.toLocal(g.lat, g.lon)));
  const same = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.05;
  const rings = [];
  while (segs.length) {
    let ring = segs.shift();
    let grown = true;
    while (!same(ring[0], ring[ring.length - 1]) && grown) {
      grown = false;
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        const end = ring[ring.length - 1];
        if (same(end, s[0])) ring = ring.concat(s.slice(1));
        else if (same(end, s[s.length - 1])) ring = ring.concat(s.slice(0, -1).reverse());
        else continue;
        segs.splice(i, 1);
        grown = true;
        break;
      }
    }
    if (same(ring[0], ring[ring.length - 1]) && ring.length > 3) rings.push(ring);
  }
  return rings;
}

function pathLen(pts) {
  let l = 0;
  for (let k = 1; k < pts.length; k++) l += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
  return l;
}

function channelParams(tags) {
  const name = `${tags.name ?? ''} ${tags['name:en'] ?? ''}`;
  const type = tags.waterway;
  let width = parseFloat(tags.width) || { river: 25, canal: 14, stream: 6, drain: 4, ditch: 3 }[type] || 5;
  let depth = { river: 4, canal: 3, stream: 1.8, drain: 1.5, ditch: 1 }[type] || 1.5;
  // Wide channels are visible in the 30 m DEM as their low-flow WATER SURFACE, with the real banks
  // beside them, so their depth here is measured below that surface. Checked against RID gauge X.44:
  // bed ≈ -2.2 m MSL, banks 7.15–8.7 m MSL, bank-full ≈ 521 m³/s. R.1 is the 70 m concrete
  // diversion canal (≈ 1,200 m³/s design).
  if (/อู่ตะเภา|อุ่ตะเภา|U-?\s?Ta-?\s?phao/i.test(name)) {
    width = Math.max(width, 40);
    depth = 4;
  } else if (/ร\.\s?1(?!\d)/.test(name)) {
    // calibrated against the Nov 2025 X.44 hydrograph: any deeper and R.1 swallows the whole flood wave
    width = Math.max(width, 70);
    depth = 2.5;
  } else if (/ร\.\s?[3-6]|Ror (See|Hok)/i.test(name)) {
    width = Math.max(width, 20);
    depth = 3.5;
  } else if (/คลองหวะ|Khlong Wa\b/i.test(name)) {
    width = Math.max(width, 20);
    depth = 4;
  } else if (/คลองเตย|Klong Toei/i.test(name)) {
    width = Math.max(width, 12);
    depth = 3;
  }
  return { width, depth };
}

function findInflows(ways) {
  const defs = [
    // split of the total upstream inflow — from the Nov 2025 peaks at RID gauges X.90 (U-Taphao) and X.174 (Khlong Wa)
    { id: 'utaphao', re: /อู่ตะเภา|อุ่ตะเภา/, name: 'คลองอู่ตะเภา', share: 0.82 },
    { id: 'wa', re: /คลองหวะ/, name: 'คลองหวะ', share: 0.15 },
    { id: 'wat', re: /คลองวาด/, name: 'คลองวาด', share: 0.03 },
  ];
  const key = ([x, y]) => `${Math.round(x)},${Math.round(y)}`;
  const byEnd = new Map();
  for (const w of ways) {
    const k = key(w.pts[w.pts.length - 1]);
    if (!byEnd.has(k)) byEnd.set(k, []);
    byEnd.get(k).push(w);
  }
  const inside = (p) => grid.contains(p[0], p[1], CITY.cell * 2);
  // Walk upstream through connected ways (named or not) until the channel leaves the domain;
  // the first in-domain point after the crossing is where river inflow is injected.
  const trace = (w) => {
    for (let hop = 0; hop < 80 && w; hop++) {
      for (let k = 1; k < w.pts.length; k++) if (!inside(w.pts[k - 1]) && inside(w.pts[k])) return { x: w.pts[k][0], y: w.pts[k][1] };
      const ups = (byEnd.get(key(w.pts[0])) ?? []).filter((u) => u !== w);
      if (!ups.length) return inside(w.pts[0]) && distToEdge(w.pts[0]) < 1500 ? { x: w.pts[0][0], y: w.pts[0][1] } : null;
      w = ups.sort((a, b) => b.depth * b.width - a.depth * a.width)[0];
    }
    return null;
  };
  const out = [];
  for (const d of defs) {
    const named = ways.filter((w) => d.re.test(w.name) && w.pts.some(inside));
    // most upstream in-domain piece: the one whose start has no named predecessor
    const heads = named.filter((w) => !named.some((o) => o !== w && key(o.pts[o.pts.length - 1]) === key(w.pts[0])));
    let found = null;
    for (const h of heads.length ? heads : named) found ??= trace(h);
    if (found) out.push({ id: d.id, name: d.name, share: d.share, ...found });
    else log(`  (no inflow point found for ${d.name})`);
  }
  const total = out.reduce((s, f) => s + f.share, 0) || 1;
  for (const f of out) f.share = Math.round((f.share / total) * 100) / 100;
  return out;
}

function distToEdge([x, y]) {
  const hw = (nx * CITY.cell) / 2;
  return Math.min(hw - Math.abs(x), hw - Math.abs(y));
}

function pickLandmarks(elements) {
  const wanted = [
    { id: 'station', name: 'สถานีรถไฟชุมทางหาดใหญ่', en: 'Hat Yai Junction Station', test: (t) => t.railway === 'station' && /หาดใหญ่|Hat ?Yai/i.test(nm(t)) && !/ใน|Nai/.test(nm(t)) },
    { id: 'kimyong', name: 'ตลาดกิมหยง', en: 'Kim Yong Market', test: (t) => /กิมหยง|Kim ?Yong/i.test(nm(t)) },
    { id: 'santisuk', name: 'ตลาดสันติสุข', en: 'Santisuk Market', test: (t) => /สันติสุข|Santisuk/i.test(nm(t)) },
    { id: 'central', name: 'เซ็นทรัลเฟสติวัล หาดใหญ่', en: 'Central Festival Hat Yai', test: (t) => t.shop === 'mall' && /เซ็นทรัล|Central/i.test(nm(t)) },
    { id: 'leegardens', name: 'ลีการ์เด้นส์ พลาซ่า', en: 'Lee Gardens Plaza', test: (t) => /ลีการ์เด้น|Lee ?Garden/i.test(nm(t)) },
    { id: 'hyhospital', name: 'โรงพยาบาลหาดใหญ่', en: 'Hat Yai Hospital', test: (t) => t.amenity === 'hospital' && /^(โรงพยาบาลหาดใหญ่|Hat ?Yai Hospital)$/i.test(nm(t).trim()) },
    { id: 'songkla', name: 'โรงพยาบาลสงขลานครินทร์', en: 'Songklanagarind Hospital', test: (t) => t.amenity === 'hospital' && /สงขลานครินทร์|Songklanagarind/i.test(nm(t)) },
    { id: 'psu', name: 'ม.สงขลานครินทร์', en: 'Prince of Songkla University', test: (t) => t.amenity === 'university' && /สงขลานครินทร์|Prince of Songkla/i.test(nm(t)) },
    { id: 'cityhall', name: 'เทศบาลนครหาดใหญ่', en: 'Hat Yai City Municipality', test: (t) => t.amenity === 'townhall' && /หาดใหญ่|Hat ?Yai/i.test(nm(t)) },
    { id: 'bus', name: 'สถานีขนส่งหาดใหญ่', en: 'Hat Yai Bus Terminal', test: (t) => t.amenity === 'bus_station' && /หาดใหญ่|Hat ?Yai/i.test(nm(t)) },
  ];
  const pois = [];
  for (const w of wanted) {
    const el = elements.find((e) => e.tags && w.test(e.tags));
    if (!el) {
      log(`  (landmark not found in OSM: ${w.name})`);
      continue;
    }
    const c = el.center ?? { lat: el.lat, lon: el.lon };
    const [x, y] = proj.toLocal(c.lat, c.lon);
    if (!grid.contains(x, y)) continue;
    pois.push({ id: w.id, name: w.name, en: w.en, osmName: el.tags.name, lat: c.lat, lon: c.lon, x, y });
  }
  const places = elements
    .filter((e) => e.type === 'node' && e.tags?.place && e.tags?.name)
    .map((e) => {
      const [x, y] = proj.toLocal(e.lat, e.lon);
      return { name: e.tags.name, en: e.tags['name:en'] ?? '', kind: e.tags.place, x, y };
    })
    .filter((p) => grid.contains(p.x, p.y, 300));
  const anchor = pois.find((p) => p.id === 'kimyong') ?? pois.find((p) => p.id === 'station');
  const downtown = anchor ? { name: anchor.name, x: anchor.x, y: anchor.y } : { name: 'domain centre', x: 0, y: 0 };
  return { pois, places, downtown };
}

function nm(t) {
  return `${t.name ?? ''} ${t['name:en'] ?? ''} ${t['name:th'] ?? ''}`;
}

function classify(t) {
  const b = t.building ?? 'yes';
  if (t.amenity === 'hospital' || b === 'hospital') return 'hospital';
  if (/^(school|university|college|kindergarten)$/.test(b) || /^(school|university|college)$/.test(t.amenity ?? '')) return 'education';
  if (/^(temple|church|mosque|shrine|religious|cathedral|chapel|monastery)$/.test(b) || t.amenity === 'place_of_worship') return 'religious';
  if (/^(industrial|warehouse|factory|manufacture)$/.test(b)) return 'industrial';
  if (/^(commercial|retail|office|hotel|supermarket)$/.test(b) || t.shop || t.tourism === 'hotel') return 'commercial';
  if (/^(apartments|terrace|dormitory)$/.test(b)) return 'shophouse';
  if (/^(house|residential|detached|semidetached_house|bungalow)$/.test(b)) return 'house';
  if (/^(shed|roof|hut|garage|garages|carport|cabin|farm_auxiliary|stable|construction|greenhouse|service|toilets|kiosk)$/.test(b)) return 'shed';
  if (/^(public|government|civic|train_station|transportation|fire_station|police)$/.test(b)) return 'civic';
  return 'generic';
}

function estimateHeight(t, cls, area, distDowntown, id) {
  const tagH = parseFloat(t.height);
  if (tagH > 2 && tagH < 400) return { h: tagH, tagged: true };
  const lv = parseFloat(t['building:levels']);
  if (lv >= 1 && lv < 120) return { h: lv * 3.3 + 0.8, tagged: true };
  const r = hash01(id);
  const r2 = hash01(id * 7 + 3);
  const floors = (a, b) => a + Math.floor(r * (b - a + 1));
  const core = distDowntown < 1300;
  const inner = distDowntown < 2600;
  let h;
  switch (cls) {
    case 'shed':
      h = 2.6 + r * 1.4;
      break;
    case 'house':
      h = area < 70 ? 3.2 + r : floors(1, 2) * 3.2 + 0.8;
      break;
    case 'shophouse':
      h = floors(3, 5) * 3.4 + 0.8;
      break;
    case 'commercial':
      h = (area > 3000 ? floors(3, 5) * 4.5 : area > 600 ? floors(3, 8) * 3.6 : floors(2, 4) * 3.5) + 1;
      break;
    case 'industrial':
      h = 6 + r * 4;
      break;
    case 'religious':
      h = 7 + r * 8;
      break;
    case 'education':
    case 'civic':
      h = floors(2, 4) * 3.6 + 1;
      break;
    case 'hospital':
      h = floors(3, 8) * 3.8 + 1;
      break;
    default:
      // Untagged footprints. Hat Yai's centre is dominated by 3–4 storey shophouses (ตึกแถว)
      // with scattered hotel/condo towers; suburbs are 1–2 storey houses.
      if (area < 25) h = 2.8 + r * 0.8;
      else if (core && area < 600) h = floors(3, 4) * 3.4 + 0.8 + (r2 > 0.975 ? floors(3, 9) * 3.3 : 0);
      else if (core) h = floors(3, 7) * 3.6 + 1;
      else if (inner && area < 400) h = floors(2, 3) * 3.3 + 0.8;
      else if (area > 1500) h = floors(2, 3) * 4.0 + 1;
      else h = floors(1, 2) * 3.2 + 0.8;
  }
  return { h, tagged: false };
}

function processBuildings(elements, downtown) {
  const out = [];
  const add = (geom, tags, id) => {
    if (!geom || geom.length < 4) return;
    let pts = geom.map((g) => proj.toLocal(g.lat, g.lon));
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 0.01) pts = pts.slice(0, -1);
    if (pts.length < 3) return;
    const area = polygonArea(pts);
    if (area < 6 || pts.length > 4000) return;
    const [cx, cy] = polygonCentroid(pts);
    if (!grid.contains(cx, cy, 2)) return;
    // ensure counter-clockwise winding (x east, y north) for consistent wall normals
    let signed = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) signed += (pts[j][0] - pts[i][0]) * (pts[j][1] + pts[i][1]);
    if (signed > 0) pts.reverse();
    const cls = classify(tags);
    const { h, tagged } = estimateHeight(tags, cls, area, Math.hypot(cx - downtown.x, cy - downtown.y), id);
    out.push({ pts, h: Math.min(h, 250), type: BTYPE[cls], tagged });
  };
  for (const el of elements) {
    if (el.type === 'way') add(el.geometry, el.tags ?? {}, el.id);
    else if (el.type === 'relation')
      assembleRings((el.members ?? []).filter((m) => m.role === 'outer')).forEach((ring, k) =>
        add(
          ring.map(([x, y]) => {
            const [lat, lon] = proj.toLatLon(x, y);
            return { lat, lon };
          }),
          el.tags ?? {},
          el.id * 31 + k,
        ),
      );
  }
  return out;
}

function encodeBuildings(list) {
  const count = list.length;
  const totalVerts = list.reduce((s, b) => s + b.pts.length, 0);
  const pad4 = (n) => (n + 3) & ~3;
  const offCounts = 12;
  const offHeights = offCounts + pad4(count * 2);
  const offTypes = offHeights + pad4(count * 2);
  const offCoords = offTypes + pad4(count);
  const buf = Buffer.alloc(offCoords + totalVerts * 4);
  buf.write('HYB1', 0, 'ascii');
  buf.writeUInt32LE(count, 4);
  buf.writeUInt32LE(totalVerts, 8);
  let v = 0;
  list.forEach((b, i) => {
    buf.writeUInt16LE(b.pts.length, offCounts + i * 2);
    buf.writeUInt16LE(Math.round(b.h * 10), offHeights + i * 2);
    buf.writeUInt8(b.type, offTypes + i);
    for (const [x, y] of b.pts) {
      buf.writeInt16LE(Math.round(x * 2), offCoords + v * 4);
      buf.writeInt16LE(Math.round(y * 2), offCoords + v * 4 + 2);
      v++;
    }
  });
  return buf;
}

async function buildImagery(file, z, b, size) {
  const tx0 = Math.floor(lonToTileX(b.west, z));
  const tx1 = Math.floor(lonToTileX(b.east, z));
  const ty0 = Math.floor(latToTileY(b.north, z));
  const ty1 = Math.floor(latToTileY(b.south, z));
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push({ tx, ty });
  log(`  z${z}: ${jobs.length} tiles`);
  let done = 0;
  const tiles = await mapLimit(jobs, 8, async ({ tx, ty }) => {
    const buf = await cached(path.join(ROOT, '.cache', 'tiles', 'esri', String(z), String(tx), `${ty}.jpg`), () =>
      fetchBuffer(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${ty}/${tx}`),
    );
    if (++done % 50 === 0) log(`    ${done}/${jobs.length}`);
    return { input: buf, left: (tx - tx0) * 256, top: (ty - ty0) * 256 };
  });
  const mosaic = await sharp({ create: { width: (tx1 - tx0 + 1) * 256, height: (ty1 - ty0 + 1) * 256, channels: 3, background: '#4b5a46' } })
    .composite(tiles)
    .png({ compressionLevel: 0 })
    .toBuffer();
  const left = (lonToTileX(b.west, z) - tx0) * 256;
  const top = (latToTileY(b.north, z) - ty0) * 256;
  const w = (lonToTileX(b.east, z) - tx0) * 256 - left;
  const h = (latToTileY(b.south, z) - ty0) * 256 - top;
  await sharp(mosaic)
    .extract({ left: Math.round(left), top: Math.round(top), width: Math.round(w), height: Math.round(h) })
    .resize(size, size, { fit: 'fill' })
    .modulate({ saturation: 1.05 })
    .jpeg({ quality: 84, mozjpeg: true })
    .toFile(path.join(OUT, file));
  const [x0, y0] = proj.toLocal(b.south, b.west);
  const [x1, y1] = proj.toLocal(b.north, b.east);
  return { file, zoom: z, x0, y0, x1, y1, size };
}

// ─────────────────────────────────────────────────────────────── roads


function processRoads(elements) {
  const list = [];
  const named = new Map();
  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    const t = el.tags ?? {};
    if (t.area === 'yes' || /^(parking_aisle|driveway|drive-through|emergency_access)$/.test(t.service ?? '')) continue;
    const base = t.highway.replace(/_link$/, '');
    const [cls, defW] = ROAD_CLASS[base] ?? [6, 4];
    const lanes = parseFloat(t.lanes);
    const width = parseFloat(t.width) || (lanes >= 1 ? Math.max(defW * 0.6, lanes * 3.3) : defW) * (t.highway.endsWith('_link') ? 0.6 : 1);
    const pts = el.geometry.map((g) => proj.toLocal(g.lat, g.lon));
    if (!pts.some(([x, y]) => grid.contains(x, y))) continue;
    const bridge = t.bridge && t.bridge !== 'no' ? 1 : 0;
    list.push({ cls, width: Math.min(40, width), bridge, oneway: t.oneway === 'yes' ? 1 : 0, pts });
    const name = t.name;
    if (name && cls <= 4) {
      const len = pathLen(pts);
      const cur = named.get(name);
      if (!cur || cur.len < len) named.set(name, { name, nameEn: t['name:en'] ?? '', cls, len, pts });
    }
  }
  // biggest roads first so they draw on top
  list.sort((a, b) => b.cls - a.cls);
  const labels = [...named.values()]
    .filter((r) => r.len > 400)
    .sort((a, b) => a.cls - b.cls || b.len - a.len)
    .slice(0, 40)
    .map((r) => {
      const mid = pointAlong(r.pts, 0.5);
      return { name: r.name, en: r.nameEn, cls: r.cls, x: Math.round(mid[0]), y: Math.round(mid[1]) };
    });
  return { list, labels };
}

function pointAlong(pts, f) {
  const total = pathLen(pts);
  let acc = 0;
  for (let k = 1; k < pts.length; k++) {
    const l = Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    if (acc + l >= total * f) {
      const u = (total * f - acc) / (l || 1);
      return [pts[k - 1][0] + (pts[k][0] - pts[k - 1][0]) * u, pts[k - 1][1] + (pts[k][1] - pts[k - 1][1]) * u];
    }
    acc += l;
  }
  return pts[pts.length - 1];
}

function encodeRoads(list) {
  const count = list.length;
  const totalVerts = list.reduce((s, r) => s + r.pts.length, 0);
  const pad4 = (n) => (n + 3) & ~3;
  const offCounts = 12;
  const offWidth = offCounts + pad4(count * 2);
  const offCls = offWidth + pad4(count * 2);
  const offCoords = offCls + pad4(count);
  const buf = Buffer.alloc(offCoords + totalVerts * 4);
  buf.write('HYR1', 0, 'ascii');
  buf.writeUInt32LE(count, 4);
  buf.writeUInt32LE(totalVerts, 8);
  let v = 0;
  list.forEach((r, i) => {
    buf.writeUInt16LE(r.pts.length, offCounts + i * 2);
    buf.writeUInt16LE(Math.round(r.width * 10), offWidth + i * 2);
    buf.writeUInt8(r.cls | (r.bridge << 4) | (r.oneway << 5), offCls + i);
    for (const [x, y] of r.pts) {
      buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x * 2))), offCoords + v * 4);
      buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(y * 2))), offCoords + v * 4 + 2);
      v++;
    }
  });
  return buf;
}

// ─────────────────────────────────────────────────────────────── important places

function placeCategory(t) {
  const a = t.amenity;
  if (a === 'hospital') return ['health', 'hospital', 10];
  if (a === 'clinic' || a === 'doctors') return ['health', 'clinic', 5];
  if (a === 'university' || a === 'college') return ['education', 'university', 8];
  if (a === 'school') return ['education', 'school', 6];
  if (a === 'kindergarten') return ['education', 'kindergarten', 4];
  if (a === 'place_of_worship') {
    const r = t.religion;
    return ['religion', r === 'muslim' ? 'mosque' : r === 'christian' ? 'church' : r === 'buddhist' ? 'temple' : 'shrine', 5];
  }
  if (a === 'marketplace') return ['market', 'market', 7];
  if (['mall', 'department_store'].includes(t.shop)) return ['market', 'mall', 7];
  // only the big-box stores people actually navigate by (convenience chains are not landmarks)
  if (t.shop === 'supermarket') return /big ?c|บิ๊กซี|lotus|โลตัส|makro|แม็คโคร|tops|ท็อปส์|villa|วิลล่า/i.test(`${t.name ?? ''} ${t.brand ?? ''}`) ? ['market', 'supermarket', 5] : null;
  if (a === 'police') return ['emergency', 'police', 8];
  if (a === 'fire_station') return ['emergency', 'fire_station', 9];
  // amenity=shelter is mostly bus-stop roofs and gazebos; keep real evacuation points only
  if (t.emergency === 'assembly_point' || t.social_facility === 'shelter' || (a === 'shelter' && /พักพิง|อพยพ|evacuat|relief/i.test(t.name ?? ''))) return ['shelter', 'shelter', 8];
  if (a === 'social_facility' || a === 'nursing_home') return ['health', 'care_home', 6];
  if (a === 'townhall' || a === 'courthouse' || t.office === 'government') return ['government', 'government', 7];
  if (a === 'community_centre' || a === 'library' || a === 'post_office') return ['government', a, 4];
  if (t.railway === 'station') return ['transport', 'rail_station', 8];
  if (a === 'bus_station') return ['transport', 'bus_station', 7];
  if (t.aeroway === 'aerodrome') return ['transport', 'airport', 9];
  if (t.tourism === 'hotel') return ['lodging', 'hotel', 3];
  if (t.tourism === 'museum' || t.tourism === 'attraction') return ['landmark', t.tourism, 5];
  if (t.leisure) return ['landmark', t.leisure, 4];
  return null;
}

function processPlaces(elements) {
  const out = [];
  const seen = new Set();
  for (const el of elements) {
    const t = el.tags ?? {};
    const cat = placeCategory(t);
    if (!cat) continue;
    const name = t['name:th'] ?? t.name ?? t['name:en'];
    if (!name || /^(7-?eleven|เซเว่น|family ?mart|แฟมิลี่มาร์ท|lawson|ลอว์สัน)/i.test(name)) continue;
    const c = el.center ?? { lat: el.lat, lon: el.lon };
    if (c.lat === undefined) continue;
    const [x, y] = proj.toLocal(c.lat, c.lon);
    if (!grid.contains(x, y, 10)) continue;
    const key = `${name}|${cat[1]}|${Math.round(x / 50)}|${Math.round(y / 50)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ground = R.sampleBilinear(zCond, nx, ny, ...grid.frac(x, y));
    out.push({
      id: `osm:${el.type}/${el.id}`,
      name,
      name_en: t['name:en'] ?? (t.name !== name ? t.name : null) ?? null,
      category: cat[0],
      kind: cat[1],
      importance: cat[2],
      lat: Math.round(c.lat * 1e6) / 1e6,
      lon: Math.round(c.lon * 1e6) / 1e6,
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      ground_m: Math.round(ground * 100) / 100,
      tags: Object.fromEntries(Object.entries(t).filter(([k]) => /^(amenity|shop|religion|operator|healthcare|beds|isced:level|addr:street|phone|website|tourism|railway|leisure|office|emergency)$/.test(k))),
    });
  }
  return out.sort((a, b) => b.importance - a.importance || a.name.localeCompare(b.name, 'th'));
}

function placesSeedSql(list) {
  const q = (v) => (v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
  const rows = list.map(
    (p) =>
      `  (${q(p.id)}, ${q(p.name)}, ${q(p.name_en)}, ${q(p.category)}, ${q(p.kind)}, ${p.importance}, ${p.lat}, ${p.lon}, ${p.x}, ${p.y}, ${p.ground_m}, ${q(JSON.stringify(p.tags))}::jsonb)`,
  );
  return `-- Generated by scripts/build-city.mjs from OpenStreetMap (© OpenStreetMap contributors, ODbL).
-- Important places in the Hat Yai simulation domain; re-run \`npm run city:build\` to refresh.
insert into public.places (id, name, name_en, category, kind, importance, lat, lon, x, y, ground_m, tags) values
${rows.join(',\n')}
on conflict (id) do update set
  name = excluded.name, name_en = excluded.name_en, category = excluded.category, kind = excluded.kind,
  importance = excluded.importance, lat = excluded.lat, lon = excluded.lon, x = excluded.x, y = excluded.y,
  ground_m = excluded.ground_m, tags = excluded.tags, updated_at = now();
`;
}
