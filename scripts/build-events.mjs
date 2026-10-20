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
  // RID stations report hourly, HII ones every 10 min: keep the reading nearest the top of the hour
  const minute = new Map();
  for (const r of d.data?.graph_data ?? []) {
    const t = bkk(r.datetime);
    const k = hourKey(t);
    if ((minute.get(k) ?? 60) < t.getUTCMinutes()) continue;
    minute.set(k, t.getUTCMinutes());
    if (r.value !== null && r.value !== '') level.set(k, Number(r.value));
    if (r.discharge !== null && r.discharge !== '') q.set(k, Number(r.discharge));
  }
  return { level, q, meta: { warning: d.data?.warning_level, critical: d.data?.critical_level, minBank: d.data?.min_bank, ground: d.data?.ground_level } };
}

const at = (map, hours) => hours.map((h) => map.get(hourKey(h)) ?? null);

/** Linear interpolation over nulls (ends held flat). */
function bridge(arr) {
  const out = arr.slice();
  const known = arr.map((v, i) => (v === null ? -1 : i)).filter((i) => i >= 0);
  if (!known.length) return out;
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== null) continue;
    const b = known.find((k) => k > i);
    const a = known.findLast((k) => k < i);
    out[i] = a === undefined ? arr[b] : b === undefined ? arr[a] : arr[a] + ((arr[b] - arr[a]) * (i - a)) / (b - a);
  }
  return out;
}

/**
 * Fill the discharge record of a gauge whose telemetry dropped out at the flood peak, using an
 * upstream gauge on the same river: route it through a lag + linear reservoir fitted on the hours
 * both gauges reported, then add the model residual interpolated across each gap so the filled
 * series joins the observations on both sides.
 */
function routeGaps(hours, obs, upstream) {
  const pad = 48;
  const ext = hoursBetween(new Date(hours[0].getTime() - pad * 3600_000).toISOString(), hours[hours.length - 1].toISOString()).concat([hours[hours.length - 1]]);
  const inflow = bridge(at(upstream.q, ext));
  if (inflow.every((v) => v === null)) return { q: bridge(obs), filled: 0, fit: null };
  let best = null;
  for (let lag = 0; lag <= 18; lag++)
    for (const k of [1, 2, 3, 4, 6, 8, 12, 16, 24]) {
      const s = [];
      let r = inflow[0];
      for (let i = 0; i < ext.length; i++) {
        r += (inflow[Math.max(0, i - lag)] - r) / k;
        s.push(r);
      }
      let sxy = 0;
      let sxx = 0;
      for (let i = 0; i < hours.length; i++) if (obs[i] !== null) (sxy += s[i + pad] * obs[i]), (sxx += s[i + pad] ** 2);
      const c = sxy / sxx;
      let se = 0;
      let n = 0;
      for (let i = 0; i < hours.length; i++) if (obs[i] !== null) (se += (c * s[i + pad] - obs[i]) ** 2), n++;
      if (!best || se / n < best.mse) best = { lag, k, c, mse: se / n, s: s.slice(pad) };
    }
  const model = best.s.map((v) => best.c * v);
  const resid = bridge(obs.map((v, i) => (v === null ? null : v - model[i])));
  const q = obs.map((v, i) => (v !== null ? v : Math.max(0, model[i] + resid[i])));
  return { q, filled: obs.filter((v) => v === null).length, fit: { lagH: best.lag, reservoirH: best.k, scale: Math.round(best.c * 100) / 100, rmse: Math.round(Math.sqrt(best.mse)) } };
}

/** Fill missing discharges from the gauge's own level record through its observed stage–discharge pairs. */
function fillByRating(hours, g) {
  const lv = at(g.level, hours);
  const qo = at(g.q, hours);
  const pairs = [...g.level].filter(([k]) => g.q.has(k)).map(([k, l]) => [l, g.q.get(k)]);
  // median discharge per 0.1 m of stage, forced monotonic
  const bins = new Map();
  for (const [l, q] of pairs) {
    const b = Math.round(l * 10) / 10;
    if (!bins.has(b)) bins.set(b, []);
    bins.get(b).push(q);
  }
  const curve = [...bins].map(([l, qs]) => [l, qs.sort((a, b) => a - b)[Math.floor(qs.length / 2)]]).sort((a, b) => a[0] - b[0]);
  for (let k = 1; k < curve.length; k++) curve[k][1] = Math.max(curve[k][1], curve[k - 1][1]);
  const top = curve.slice(-6);
  const slope = top.length > 1 ? (top[top.length - 1][1] - top[0][1]) / (top[top.length - 1][0] - top[0][0] || 1) : 0;
  const rate = (l) => {
    if (l >= curve[curve.length - 1][0]) return curve[curve.length - 1][1] + slope * (l - curve[curve.length - 1][0]);
    const k = curve.findIndex((c) => c[0] >= l);
    if (k <= 0) return curve[0][1];
    const [l0, q0] = curve[k - 1];
    const [l1, q1] = curve[k];
    return q0 + ((q1 - q0) * (l - l0)) / (l1 - l0);
  };
  const q = qo.map((v, i) => (v !== null ? v : lv[i] !== null && curve.length > 3 ? rate(lv[i]) : null));
  return { q: bridge(q), filled: qo.filter((v, i) => v === null && lv[i] !== null).length };
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

/**
 * Songkhla Lake at the U-Taphao / R.1 mouths: HII gauge SLA005 Pak Ro (west shore, same basin) where
 * it reported; before that, ONE038 (lake outlet at Songkhla city, complete record) plus the
 * Pak Ro − ONE038 set-up, which grows with the flood (fitted on the hours both reported).
 */
function lakeLevel(hours, pakRo, one038) {
  const w = at(pakRo.level, hours);
  const e = bridge(at(one038.level, hours));
  const base = Math.min(...e.slice(0, 24));
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < hours.length; i++) {
    if (w[i] === null) continue;
    const x = Math.max(0, e[i] - base);
    sxy += x * (w[i] - e[i]);
    sxx += x * x;
  }
  const k = sxx > 0 ? sxy / sxx : 0;
  const est = e.map((v) => v + k * Math.max(0, v - base));
  // offset the reconstruction onto Pak Ro's first readings so the series does not jump
  const first = w.findIndex((v) => v !== null);
  const jump = first >= 0 ? w[first] - est[first] : 0;
  const lake = est.map((v, i) => (w[i] !== null ? w[i] : i < first ? v + jump * Math.max(0, 1 - (first - i) / 48) : null));
  return { lake: bridge(lake), setupFactor: Math.round(k * 100) / 100 };
}

// ───────────────────────────────────────────── 2025: the record flood (observed)
async function event2025() {
  const start = '2025-11-19T00:00:00+07:00';
  const end = '2025-11-29T00:00:00+07:00';
  const hours = hoursBetween(start, end);
  const span = ['2025-11-17', '2025-12-01'];
  // RID X.90 / X.174 / X.44 + HII X.173A (upstream U-Taphao), SLA005 Pak Ro + ONE038 (Songkhla Lake),
  // ONE037 (U-Taphao bridge near the mouth) and SLA007 (Bang Klam) for downstream checks
  const [x90, x174, x44, x173a, pakRo, one038, one037, sla007] = await Promise.all([2589, 2590, 2591, 2585, 859, 1109527, 1109526, 858].map((id) => gauge(id, ...span)));
  const tmd = await getJson(`${TW}/rain_monthly_graph?station_type=rainfall_24h&station_id=3749&year=2025&month=11`, 'rain_3749_2025_11.json');
  // ThaiWater dates each 24 h total by the day it STARTS at 07:00 (21 Nov = 370.2 mm, 07:00 21 → 07:00 22)
  const daily = (tmd.data ?? []).map((r) => [r.rainfall_datetime, Number(r.rainfall_value) || 0]);
  const era = await eraHourly('2025-11-18', '2025-11-30');
  const rain = scaleToDaily(hours, era.rain, daily);
  // X.90 telemetry died at the crest (25 Nov 03:00 → 27 Nov 15:00): route the upstream gauge through it
  const u = routeGaps(hours, at(x90.q, hours), x173a);
  const wa = fillByRating(hours, x174);
  const lk = lakeLevel(hours, pakRo, one038);
  console.log(
    `  2025: X.90 ${u.filled} h filled from X.173A (lag ${u.fit?.lagH} h, K ${u.fit?.reservoirH} h, ×${u.fit?.scale}, RMSE ${u.fit?.rmse} m³/s); X.174 ${wa.filled} h from its rating; lake set-up ×${lk.setupFactor}`,
  );
  const round = (a, d = 0) => a.map((v) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d));
  return {
    id: '2025-11',
    name: 'มหาอุทกภัยหาดใหญ่ 19–28 พ.ย. 2568',
    nameEn: 'Hat Yai flood, 19–28 Nov 2025',
    start,
    hours: hours.length,
    rainMmHr: rain,
    inflowM3s: u.q.map((q, i) => Math.round(((q ?? 40) + (wa.q[i] ?? 8)) * 10) / 10),
    lakeM: round(lk.lake, 2),
    windKmh: hours.map((h) => Math.round(era.wind.get(hourKey(h))?.[0] ?? 15)),
    windDir: hours.map((h) => Math.round(era.wind.get(hourKey(h))?.[1] ?? 45)),
    observed: {
      x44LevelM: hours.map((h) => x44.level.get(hourKey(h)) ?? null),
      x44Thresholds: { normal: 6.0, critical: 7.4, rightBank: 8.3, record2010: 9.1 },
      x90Q: round(u.q),
      x90Reconstructed: at(x90.q, hours).map((v) => (v === null ? 1 : 0)),
      x174Q: round(wa.q),
      one037LevelM: round(at(one037.level, hours), 2),
      sla007LevelM: round(at(sla007.level, hours), 2),
      lakePakRoM: round(at(pakRo.level, hours), 2),
      lakeOne038M: round(at(one038.level, hours), 2),
      dailyRainTmd: daily.filter(([d]) => d >= '2025-11-18' && d <= '2025-11-28'),
    },
    facts: [
      'ฝนสถานีอุตุฯ สนามบินหาดใหญ่ 370.2 มม. ใน 24 ชม. (21–22 พ.ย.) สูงสุดเป็นประวัติการณ์',
      'X.44 สูงสุด 9.97 ม.รทก. 25 พ.ย. 10:00 (สถิติเดิม 9.10 ม. ปี 2553)',
      'ตลาดกิมหยง/หอนาฬิกา ราว 1 ม. (22 พ.ย.), บางจุด 2–3 ม. (GISTDA 24 พ.ย.)',
      'คลอง ร.1 ระบายได้ราว 1,200–1,300 ลบ.ม./วิ คลองอู่ตะเภาในเมืองราว 400–500 ลบ.ม./วิ',
      'สถานี X.90 ขาดข้อมูลช่วงยอดน้ำ (25–27 พ.ย.) เติมจากสถานีต้นน้ำ X.173A',
      'ทะเลสาบสงขลา (ปากรอ) สูงสุด 2.57 ม.รทก. 26 พ.ย.',
    ],
    sources: [
      'ThaiWater/HII (RID gauges X.90, X.173A, X.174, X.44; TMD Hat Yai Airport)',
      'ThaiWater/HII lake gauges SLA005 Pak Ro, ONE038 Songkhla; ONE037 U-Taphao bridge, SLA007 Bang Klam',
      'Open-Meteo ERA5 (hourly rain shape, wind)',
    ],
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
