#!/usr/bin/env node
// Fetch observed forcing for historical Hat Yai floods and store it as hourly series:
//   • Rain   — TMD Hat Yai Airport daily totals (via ThaiWater) distributed over the day with the
//              hourly shape from Open-Meteo / ERA5 reanalysis
//   • Inflow — RID river gauges X.90 (Khlong U-Taphao, Ban Bang Sala) + X.174 (Khlong Wa) (ThaiWater);
//              for 2010 (pre-telemetry) the GloFAS hydrograph is scaled to the RID-reported peak
//   • Check  — observed X.44 water level in the city, for comparing against the simulation
// Output: public/city/hatyai/events.json

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cached, USER_AGENT } from './lib/fetchers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache', 'hatyai', 'events');
const OUT = path.join(ROOT, 'public', 'city', 'hatyai', 'events.json');
const TW = 'https://api-v3.thaiwater.net/api/v1/thaiwater30/public';
const HAT_YAI = { lat: 7.0086, lon: 100.4747 };
const GLOFAS_CELL = { lat: 6.975, lon: 100.425 }; // GloFAS 0.05° cell carrying the U-Taphao main stem

async function getJson(url, name) {
  const buf = await cached(path.join(CACHE, name), async () => {
    const r = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Origin: 'http://localhost' }, signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return Buffer.from(await r.text());
  });
  return JSON.parse(buf.toString());
}

const hourKey = (d) => d.toISOString().slice(0, 13);
const bkk = (s) => new Date(s.replace(' ', 'T') + ':00+07:00'); // ThaiWater timestamps are local time

function hoursBetween(startIso, endIso) {
  const out = [];
  for (let t = Date.parse(startIso); t < Date.parse(endIso); t += 3600_000) out.push(new Date(t));
  return out;
}

/** Linear interpolation of a sparse {Date → value} map onto an hourly axis. */
function fillSeries(hours, points) {
  const known = [...points.entries()].map(([k, v]) => [Date.parse(k + ':00:00Z'), v]).sort((a, b) => a[0] - b[0]);
  return hours.map((h) => {
    const t = h.getTime();
    if (!known.length) return null;
    if (t <= known[0][0]) return known[0][1];
    if (t >= known[known.length - 1][0]) return known[known.length - 1][1];
    let i = 1;
    while (known[i][0] < t) i++;
    const [t0, v0] = known[i - 1];
    const [t1, v1] = known[i];
    return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
  });
}

async function gauge(stationId, start, end) {
  const d = await getJson(
    `${TW}/waterlevel_graph?station_type=tele_waterlevel&station_id=${stationId}&start_date=${start}&end_date=${end}`,
    `wl_${stationId}_${start}_${end}.json`,
  );
  const level = new Map();
  const q = new Map();
  for (const r of d.data?.graph_data ?? []) {
    const k = hourKey(bkk(r.datetime));
    if (r.value !== null && r.value !== '') level.set(k, Number(r.value));
    if (r.discharge !== null && r.discharge !== '') q.set(k, Number(r.discharge));
  }
  return { level, q, meta: { warning: d.data?.warning_level, critical: d.data?.critical_level, minBank: d.data?.min_bank } };
}

async function eraHourly(start, end) {
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${HAT_YAI.lat}&longitude=${HAT_YAI.lon}&start_date=${start}&end_date=${end}&hourly=precipitation,wind_speed_10m,wind_direction_10m&timezone=GMT`;
  const d = await getJson(url, `era_${start}_${end}.json`);
  const rain = new Map();
  const wind = new Map();
  d.hourly.time.forEach((t, i) => {
    // Open-Meteo precipitation is the sum over the PRECEDING hour; key it by the hour's start
    const k = hourKey(new Date(Date.parse(t + ':00Z') - 3600_000));
    rain.set(k, d.hourly.precipitation[i] ?? 0);
    wind.set(k, [d.hourly.wind_speed_10m[i] ?? 10, d.hourly.wind_direction_10m[i] ?? 45]);
  });
  return { rain, wind };
}

/** Scale reanalysis hourly rain so each 07:00–07:00 (Thai climatological day) matches the gauge. */
function scaleToDaily(hours, eraRain, daily) {
  const out = hours.map((h) => eraRain.get(hourKey(h)) ?? 0);
  for (const [day, total] of daily) {
    const t0 = Date.parse(`${day}T07:00:00+07:00`);
    const idx = hours.map((h, i) => [h.getTime(), i]).filter(([t]) => t >= t0 && t < t0 + 86400_000).map(([, i]) => i);
    if (!idx.length) continue;
    const s = idx.reduce((a, i) => a + out[i], 0);
    for (const i of idx) out[i] = s > 0.5 ? (out[i] * total) / s : total / idx.length;
  }
  return out.map((v) => Math.round(v * 100) / 100);
}

// ───────────────────────────────────────────── 2025: the record flood (observed)
async function event2025() {
  const start = '2025-11-19T00:00:00+07:00';
  const end = '2025-11-29T00:00:00+07:00';
  const hours = hoursBetween(start, end);
  const [x90, x174, x44] = await Promise.all([gauge(2589, '2025-11-17', '2025-12-01'), gauge(2590, '2025-11-17', '2025-12-01'), gauge(2591, '2025-11-17', '2025-12-01')]);
  const tmd = await getJson(`${TW}/rain_monthly_graph?station_type=rainfall_24h&station_id=3749&year=2025&month=11`, 'rain_3749_2025_11.json');
  // ThaiWater dates each 24 h total by the day it STARTS at 07:00 (21 Nov = 370.2 mm, 07:00 21 → 07:00 22)
  const daily = (tmd.data ?? []).map((r) => [r.rainfall_datetime, Number(r.rainfall_value) || 0]);
  const era = await eraHourly('2025-11-18', '2025-11-30');
  const rain = scaleToDaily(hours, era.rain, daily);
  const qU = fillSeries(hours, x90.q);
  const qW = fillSeries(hours, x174.q);
  const lakePts = new Map([
    [hourKey(new Date('2025-11-18T00:00:00+07:00')), 0.75],
    [hourKey(new Date('2025-11-21T12:00:00+07:00')), 0.82],
    [hourKey(new Date('2025-11-25T12:00:00+07:00')), 1.17],
    [hourKey(new Date('2025-12-01T00:00:00+07:00')), 0.98],
  ]);
  return {
    id: '2025-11',
    name: 'มหาอุทกภัยหาดใหญ่ 19–28 พ.ย. 2568',
    nameEn: 'Hat Yai flood, 19–28 Nov 2025',
    start,
    hours: hours.length,
    rainMmHr: rain,
    inflowM3s: qU.map((q, i) => Math.round(((q ?? 40) + (qW[i] ?? 8)) * 10) / 10),
    lakeM: fillSeries(hours, lakePts).map((v) => Math.round(v * 100) / 100),
    windKmh: hours.map((h) => Math.round(era.wind.get(hourKey(h))?.[0] ?? 15)),
    windDir: hours.map((h) => Math.round(era.wind.get(hourKey(h))?.[1] ?? 45)),
    observed: {
      x44LevelM: hours.map((h) => x44.level.get(hourKey(h)) ?? null),
      x44Thresholds: { normal: 6.0, critical: 7.4, rightBank: 8.3, record2010: 9.1 },
      x90Q: qU.map((v) => (v === null ? null : Math.round(v))),
      x174Q: qW.map((v) => (v === null ? null : Math.round(v))),
      dailyRainTmd: daily.filter(([d]) => d >= '2025-11-18' && d <= '2025-11-28'),
    },
    facts: [
      'ฝนสถานีอุตุฯ สนามบินหาดใหญ่ 370.2 มม. ใน 24 ชม. (21–22 พ.ย.) สูงสุดเป็นประวัติการณ์',
      'X.44 สูงสุด 9.97 ม.รทก. 25 พ.ย. 10:00 (สถิติเดิม 9.10 ม. ปี 2553)',
      'ตลาดกิมหยง/หอนาฬิกา ราว 1 ม. (22 พ.ย.), บางจุด 2–3 ม. (GISTDA 24 พ.ย.)',
      'ระบบ ร.1 รับน้ำ ~1,800 ลบ.ม./วิ เทียบความจุออกแบบ 1,200',
    ],
    sources: ['ThaiWater/HII (RID gauges X.90, X.174, X.44; TMD Hat Yai Airport)', 'Open-Meteo ERA5 (hourly rain shape, wind)', 'DWR Songkhla Lake bulletin'],
  };
}

// ───────────────────────────────────────────── 2010: reconstructed from RID figures
async function event2010() {
  const start = '2010-10-30T00:00:00+07:00';
  const end = '2010-11-05T00:00:00+07:00';
  const hours = hoursBetween(start, end);
  const era = await eraHourly('2010-10-29', '2010-11-06');
  // RID: basin 3-day rainfall 428 mm (31 Oct – 2 Nov)
  let rain = hours.map((h) => era.rain.get(hourKey(h)) ?? 0);
  const t0 = Date.parse('2010-10-31T07:00:00+07:00');
  const inWin = hours.map((h) => h.getTime() >= t0 && h.getTime() < t0 + 3 * 86400_000);
  const s = rain.reduce((a, v, i) => a + (inWin[i] ? v : 0), 0);
  rain = rain.map((v, i) => Math.round((inWin[i] ? (v * 428) / Math.max(1, s) : v * 0.6) * 100) / 100);

  const gl = await getJson(
    `https://flood-api.open-meteo.com/v1/flood?latitude=${GLOFAS_CELL.lat}&longitude=${GLOFAS_CELL.lon}&start_date=2010-10-25&end_date=2010-11-10&daily=river_discharge`,
    'glofas_2010.json',
  );
  const pts = new Map(gl.daily.time.map((d, i) => [hourKey(new Date(`${d}T12:00:00+07:00`)), gl.daily.river_discharge[i] ?? 0]));
  let q = fillSeries(hours, pts);
  // shift the GloFAS crest onto the RID-observed crest (11:00 2 Nov 2010) and scale it to 1,623.5 m³/s
  const crestIdx = q.indexOf(Math.max(...q));
  const targetIdx = hours.findIndex((h) => h.getTime() === Date.parse('2010-11-02T11:00:00+07:00'));
  const shift = targetIdx - crestIdx;
  q = hours.map((_, i) => q[Math.min(q.length - 1, Math.max(0, i - shift))]);
  const base = Math.min(...q);
  const k = (1623.5 - base) / (Math.max(...q) - base);
  q = q.map((v) => Math.round((base + (v - base) * k) * 10) / 10);
  return {
    id: '2010-11',
    name: 'น้ำท่วมใหญ่หาดใหญ่ 31 ต.ค.–2 พ.ย. 2553',
    nameEn: 'Hat Yai flood, 1 Nov 2010',
    start,
    hours: hours.length,
    rainMmHr: rain,
    inflowM3s: q,
    lakeM: hours.map(() => 0.9),
    windKmh: hours.map((h) => Math.round(era.wind.get(hourKey(h))?.[0] ?? 15)),
    windDir: hours.map((h) => Math.round(era.wind.get(hourKey(h))?.[1] ?? 45)),
    observed: { x44Thresholds: { normal: 6.0, critical: 7.4, rightBank: 8.3, record2010: 9.1 } },
    facts: [
      'ฝนสะสม 3 วัน 428 มม. (กรมชลประทาน)',
      'น้ำสูงสุด 1,623.5 ลบ.ม./วิ วันที่ 2 พ.ย. 11:00 (อู่ตะเภา 930 + ร.1 693.5)',
      'X.44 สูงสุด 9.10 ม.รทก. น้ำเข้าเมือง 1 พ.ย. 22:00 ลึกสูงสุดราว 2 ม.',
    ],
    sources: ['RID project brief (kb.psu.ac.th/psukb/handle/2016/15340)', 'Open-Meteo ERA5', 'GloFAS v4 via Open-Meteo Flood API'],
  };
}

const events = [await event2025(), await event2010()];
await fs.writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), events }));
for (const e of events) {
  const total = e.rainMmHr.reduce((a, b) => a + b, 0);
  console.log(`${e.id}: ${e.hours} h, rain ${total.toFixed(0)} mm (max ${Math.max(...e.rainMmHr).toFixed(1)} mm/h), inflow peak ${Math.max(...e.inflowM3s).toFixed(0)} m³/s`);
}
console.log(`→ ${path.relative(ROOT, OUT)}`);
