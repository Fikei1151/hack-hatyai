// Real-world forcing: turn hourly observations / forecasts into scenario phases, and fetch them live.
//   ThaiWater (HII) public API — RID river gauges and TMD rain gauges (CORS-enabled, no key)
//   Open-Meteo — ERA5 reanalysis, weather forecast, GloFAS river discharge (no key)
import { intensityClass, makePhase } from './scenario';
import type { Phase, Scenario } from './types';

export interface HourlyForcing {
  start: string; // ISO with offset
  rainMmHr: number[];
  inflowM3s: number[];
  lakeM: number[];
  windKmh?: number[];
  windDir?: number[];
}

export interface EventRecord extends HourlyForcing {
  id: string;
  name: string;
  nameEn: string;
  hours: number;
  observed: {
    x44LevelM?: (number | null)[];
    x44Thresholds?: { normal: number; critical: number; rightBank: number; record2010: number };
    x90Q?: (number | null)[];
    x174Q?: (number | null)[];
  };
  facts: string[];
  sources: string[];
}

const TW = 'https://api-v3.thaiwater.net/api/v1/thaiwater30/public';
const HAT_YAI = { lat: 7.0086, lon: 100.4747 };
const GLOFAS_CELL = { lat: 6.975, lon: 100.425 };
export const STATIONS = { x44: 2591, x90: 2589, x174: 2590, rainAirport: 3749 } as const;

const thaiDate = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });

const rainClass = (r: number) => (r < 1 ? 0 : r < 5 ? 1 : r < 12 ? 2 : r < 25 ? 3 : 4);

/**
 * Segment an hourly series into phases of similar rain intensity.
 * Rain is the phase mean (totals preserved); inflow and lake level are the values at the phase end,
 * which the forcing interpolates linearly — so the hydrograph is reproduced piecewise-linearly.
 */
export function phasesFromHourly(f: HourlyForcing, opts: { minHours?: number; maxHours?: number } = {}): Phase[] {
  const minH = opts.minHours ?? 4;
  const maxH = opts.maxHours ?? 12;
  const n = f.rainMmHr.length;
  type Seg = { a: number; b: number };
  let segs: Seg[] = [];
  for (let i = 0; i < n; i++) {
    const c = rainClass(f.rainMmHr[i]);
    const last = segs[segs.length - 1];
    if (last && rainClass(mean(f.rainMmHr, last.a, last.b)) === c) last.b = i + 1;
    else segs.push({ a: i, b: i + 1 });
  }
  // merge short segments into the neighbour with the most similar intensity
  let changed = true;
  while (changed && segs.length > 1) {
    changed = false;
    for (let k = 0; k < segs.length; k++) {
      const s = segs[k];
      if (s.b - s.a >= minH) continue;
      const m = mean(f.rainMmHr, s.a, s.b);
      const left = segs[k - 1];
      const right = segs[k + 1];
      const dl = left ? Math.abs(mean(f.rainMmHr, left.a, left.b) - m) : Infinity;
      const dr = right ? Math.abs(mean(f.rainMmHr, right.a, right.b) - m) : Infinity;
      if (dl <= dr && left) left.b = s.b;
      else if (right) right.a = s.a;
      else continue;
      segs.splice(k, 1);
      changed = true;
      break;
    }
  }
  // split long ones so the hydrograph keeps its shape
  segs = segs.flatMap((s) => {
    const len = s.b - s.a;
    if (len <= maxH) return [s];
    const parts = Math.ceil(len / maxH);
    return Array.from({ length: parts }, (_, p) => ({ a: s.a + Math.round((p * len) / parts), b: s.a + Math.round(((p + 1) * len) / parts) }));
  });

  const t0 = Date.parse(f.start);
  return segs.map((s) => {
    const rain = Math.round(mean(f.rainMmHr, s.a, s.b) * 10) / 10;
    const cls = intensityClass(rain);
    const heavy = rain >= 10;
    const when = thaiDate.format(new Date(t0 + s.a * 3600_000));
    let wx = 0;
    let wy = 0;
    let ws = 0;
    for (let i = s.a; i < s.b; i++) {
      const d = ((f.windDir?.[i] ?? 45) * Math.PI) / 180;
      wx += Math.sin(d);
      wy += Math.cos(d);
      ws += f.windKmh?.[i] ?? 15;
    }
    return makePhase({
      name: `${when} · ${cls.label}`,
      color: cls.color,
      duration_hours: s.b - s.a,
      ramp_hours: 0.25,
      rain_mm_hr: rain,
      rain_pattern: heavy ? 'storm_cells' : 'uniform',
      rain_variability: heavy ? 0.55 : 0.35,
      storm_cells: heavy ? Math.min(10, 3 + Math.round(rain / 6)) : 0,
      wind_dir_deg: Math.round(((Math.atan2(wx, wy) * 180) / Math.PI + 360) % 360),
      // convective cells are steered by winds aloft, roughly 1.5–2× the surface wind
      wind_speed_kmh: Math.round(Math.min(45, Math.max(10, (ws / (s.b - s.a)) * 1.7))),
      upstream_inflow_m3s: Math.round(f.inflowM3s[s.b - 1] ?? 40),
      lake_level_m: Math.round((f.lakeM[s.b - 1] ?? 0.9) * 100) / 100,
      drainage_mm_hr: 30,
      infiltration_mm_hr: 4,
    });
  });
}

function mean(a: number[], i0: number, i1: number) {
  let s = 0;
  for (let i = i0; i < i1; i++) s += a[i] ?? 0;
  return s / Math.max(1, i1 - i0);
}

export function scenarioFromEvent(e: EventRecord): Scenario {
  return {
    slug: `event-${e.id}`,
    name: e.name,
    description: `ย้อนเหตุการณ์จริงจากข้อมูลตรวจวัด: ${e.facts.join(' · ')}. แหล่งข้อมูล: ${e.sources.join('; ')}`,
    source: 'historical',
    seed: Number(e.id.replace(/\D/g, '')) || 2025,
    start_time: new Date(Date.parse(e.start)).toISOString(),
    settings: { rain_bias: 1, initial_inflow_m3s: e.inflowM3s[0], initial_lake_m: e.lakeM[0], event_id: e.id },
    phases: phasesFromHourly(e),
  };
}

let eventsCache: Promise<EventRecord[]> | null = null;
export function loadEvents(base: string): Promise<EventRecord[]> {
  eventsCache ??= fetch(`${base}/events.json`)
    .then((r) => (r.ok ? r.json() : { events: [] }))
    .then((d) => d.events as EventRecord[])
    .catch(() => []);
  return eventsCache;
}

// ─────────────────────────────────────────────────────────── live APIs

async function json<T>(url: string): Promise<T> {
  const r = await fetch(url, { signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

export interface GaugeNow {
  code: string;
  name: string;
  time: string;
  levelMsl: number | null;
  discharge: number | null;
  minBank: number | null;
  situation: number | null;
}

export interface LiveStatus {
  fetchedAt: string;
  gauges: GaugeNow[];
  rain24h: { station: string; mm: number; time: string }[];
}

interface TwWaterLevel {
  waterlevel_datetime: string;
  waterlevel_msl: string | null;
  discharge: string | null;
  situation_level: number | null;
  station: { id: number; tele_station_oldcode: string; tele_station_name: { th: string }; min_bank: number | null };
}

/** Current RID gauge readings around Hat Yai and 24-hour rain at nearby stations. */
export async function fetchLiveStatus(): Promise<LiveStatus> {
  const wl = await json<{ waterlevel_data: { data: TwWaterLevel[] } }>(`${TW}/waterlevel_load`);
  const want = new Set<number>([STATIONS.x44, STATIONS.x90, STATIONS.x174]);
  const gauges = wl.waterlevel_data.data
    .filter((r) => want.has(r.station.id))
    .map((r) => ({
      code: r.station.tele_station_oldcode,
      name: r.station.tele_station_name.th,
      time: r.waterlevel_datetime,
      levelMsl: r.waterlevel_msl === null ? null : Number(r.waterlevel_msl),
      discharge: r.discharge === null ? null : Number(r.discharge),
      minBank: r.station.min_bank,
      situation: r.situation_level,
    }));
  let rain24h: LiveStatus['rain24h'] = [];
  try {
    const rr = await json<{ data: { rain_24h: number; rainfall_datetime: string; station: { tele_station_name: { th: string }; tele_station_lat: number; tele_station_long: number } }[] }>(
      `${TW}/rain_24h`,
    );
    rain24h = rr.data
      .filter((r) => Math.hypot(r.station.tele_station_lat - HAT_YAI.lat, r.station.tele_station_long - HAT_YAI.lon) < 0.12)
      .map((r) => ({ station: r.station.tele_station_name.th, mm: Number(r.rain_24h) || 0, time: r.rainfall_datetime }))
      .sort((a, b) => b.mm - a.mm)
      .slice(0, 5);
  } catch {
    /* rain list is optional */
  }
  return { fetchedAt: new Date().toISOString(), gauges, rain24h };
}

/** 7-day forecast scenario: Open-Meteo hourly rain + GloFAS discharge anchored to today's gauges. */
export async function fetchForecastForcing(): Promise<HourlyForcing & { note: string }> {
  const fc = await json<{ hourly: { time: string[]; precipitation: number[]; wind_speed_10m: number[]; wind_direction_10m: number[] } }>(
    `https://api.open-meteo.com/v1/forecast?latitude=${HAT_YAI.lat}&longitude=${HAT_YAI.lon}&hourly=precipitation,wind_speed_10m,wind_direction_10m&forecast_days=7&timezone=GMT`,
  );
  const fl = await json<{ daily: { time: string[]; river_discharge: number[] } }>(
    `https://flood-api.open-meteo.com/v1/flood?latitude=${GLOFAS_CELL.lat}&longitude=${GLOFAS_CELL.lon}&daily=river_discharge&forecast_days=9`,
  );
  let observedNow: number | null = null;
  try {
    const live = await fetchLiveStatus();
    const q = live.gauges.filter((g) => g.code === 'X.90' || g.code === 'X.174').reduce((s, g) => s + (g.discharge ?? 0), 0);
    if (q > 0) observedNow = q;
  } catch {
    /* fall back to raw GloFAS */
  }
  // hourly timestamps are period-end; start at the next full hour
  const start = new Date(Date.parse(fc.hourly.time[0] + ':00Z') - 3600_000);
  const n = fc.hourly.time.length;
  const day0 = Date.parse(fl.daily.time[0] + 'T12:00:00Z');
  const glofasAt = (t: number) => {
    const x = (t - day0) / 86400_000;
    const i = Math.max(0, Math.min(fl.daily.time.length - 2, Math.floor(x)));
    const w = Math.min(1, Math.max(0, x - i));
    return (fl.daily.river_discharge[i] ?? 0) * (1 - w) + (fl.daily.river_discharge[i + 1] ?? 0) * w;
  };
  const g0 = glofasAt(start.getTime()) || 1;
  // GloFAS gets the shape; today's observed gauges set the level (bias ratio, bounded)
  const ratio = observedNow ? Math.min(4, Math.max(0.25, observedNow / g0)) : 1;
  const inflow = Array.from({ length: n }, (_, i) => Math.max(5, glofasAt(start.getTime() + i * 3600_000) * ratio));
  return {
    start: start.toISOString(),
    rainMmHr: fc.hourly.precipitation.map((v) => v ?? 0),
    inflowM3s: inflow,
    lakeM: inflow.map(() => 0.9),
    windKmh: fc.hourly.wind_speed_10m,
    windDir: fc.hourly.wind_direction_10m,
    note: observedNow
      ? `น้ำไหลเข้าปรับเทียบกับสถานี X.90 + X.174 ปัจจุบัน (${Math.round(observedNow)} ลบ.ม./วิ)`
      : 'น้ำไหลเข้าจากแบบจำลอง GloFAS (ไม่ได้ปรับเทียบ)',
  };
}

/** Replay any past period: TMD/ThaiWater gauges where available, ERA5 + GloFAS otherwise. */
export async function fetchHistoricalForcing(startDate: string, days: number): Promise<HourlyForcing & { note: string }> {
  const start = new Date(`${startDate}T00:00:00+07:00`);
  const end = new Date(start.getTime() + days * 86400_000);
  const ymd = (d: Date) => new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
  const n = days * 24;
  const hourIdx = (t: number) => Math.round((t - start.getTime()) / 3600_000);

  const era = await json<{ hourly: { time: string[]; precipitation: number[]; wind_speed_10m: number[]; wind_direction_10m: number[] } }>(
    `https://archive-api.open-meteo.com/v1/archive?latitude=${HAT_YAI.lat}&longitude=${HAT_YAI.lon}&start_date=${ymd(new Date(start.getTime() - 86400_000))}&end_date=${ymd(end)}&hourly=precipitation,wind_speed_10m,wind_direction_10m&timezone=GMT`,
  );
  const rain = new Array(n).fill(0);
  const windKmh = new Array(n).fill(15);
  const windDir = new Array(n).fill(45);
  era.hourly.time.forEach((t, k) => {
    const i = hourIdx(Date.parse(t + ':00Z') - 3600_000);
    if (i < 0 || i >= n) return;
    rain[i] = era.hourly.precipitation[k] ?? 0;
    windKmh[i] = era.hourly.wind_speed_10m[k] ?? 15;
    windDir[i] = era.hourly.wind_direction_10m[k] ?? 45;
  });

  const notes: string[] = [];
  // bias-correct daily totals with the TMD Hat Yai Airport gauge when ThaiWater has it
  try {
    const months = new Set<string>();
    for (let d = new Date(start); d < end; d = new Date(d.getTime() + 86400_000)) months.add(ymd(d).slice(0, 7));
    let corrected = 0;
    for (const m of months) {
      const [y, mo] = m.split('-').map(Number);
      const r = await json<{ data: { rainfall_datetime: string; rainfall_value: number }[] }>(
        `${TW}/rain_monthly_graph?station_type=rainfall_24h&station_id=${STATIONS.rainAirport}&year=${y}&month=${mo}`,
      );
      for (const row of r.data ?? []) {
        const t0 = Date.parse(`${row.rainfall_datetime}T07:00:00+07:00`);
        const idx: number[] = [];
        for (let h = 0; h < 24; h++) {
          const i = hourIdx(t0 + h * 3600_000);
          if (i >= 0 && i < n) idx.push(i);
        }
        if (idx.length < 12) continue;
        const s = idx.reduce((a, i) => a + rain[i], 0);
        const total = Number(row.rainfall_value) || 0;
        for (const i of idx) rain[i] = s > 0.5 ? (rain[i] * total) / s : total / idx.length;
        corrected++;
      }
    }
    if (corrected) notes.push(`ฝนปรับเทียบกับสถานีสนามบินหาดใหญ่ ${corrected} วัน`);
  } catch {
    notes.push('ไม่มีข้อมูลสถานีฝน ใช้ ERA5 โดยตรง');
  }

  let inflow: number[] | null = null;
  try {
    const sd = ymd(new Date(start.getTime() - 86400_000));
    const ed = ymd(end);
    const series = await Promise.all(
      [STATIONS.x90, STATIONS.x174].map((id) =>
        json<{ data: { graph_data: { datetime: string; discharge: number | null }[] } }>(
          `${TW}/waterlevel_graph?station_type=tele_waterlevel&station_id=${id}&start_date=${sd}&end_date=${ed}`,
        ),
      ),
    );
    const sum = new Array(n).fill(0);
    let ok = true;
    for (const s of series) {
      const pts = (s.data?.graph_data ?? [])
        .filter((r) => r.discharge !== null)
        .map((r) => [Date.parse(r.datetime.replace(' ', 'T') + ':00+07:00'), Number(r.discharge)] as [number, number]);
      if (pts.length < n * 0.3) {
        ok = false;
        break;
      }
      for (let i = 0; i < n; i++) sum[i] += interp(pts, start.getTime() + i * 3600_000);
    }
    if (ok) {
      inflow = sum;
      notes.push('น้ำไหลเข้าจากสถานีวัดน้ำ X.90 + X.174 (กรมชลประทาน)');
    }
  } catch {
    /* fall through to GloFAS */
  }
  if (!inflow) {
    const fl = await json<{ daily: { time: string[]; river_discharge: number[] } }>(
      `https://flood-api.open-meteo.com/v1/flood?latitude=${GLOFAS_CELL.lat}&longitude=${GLOFAS_CELL.lon}&start_date=${ymd(new Date(start.getTime() - 86400_000))}&end_date=${ymd(end)}&daily=river_discharge`,
    );
    const pts = fl.daily.time.map((d, i) => [Date.parse(`${d}T12:00:00+07:00`), fl.daily.river_discharge[i] ?? 0] as [number, number]);
    inflow = Array.from({ length: n }, (_, i) => interp(pts, start.getTime() + i * 3600_000));
    notes.push('น้ำไหลเข้าจาก GloFAS (ไม่มีข้อมูลสถานี)');
  }
  return { start: start.toISOString(), rainMmHr: rain, inflowM3s: inflow, lakeM: inflow.map(() => 0.9), windKmh, windDir, note: notes.join(' · ') };
}

function interp(pts: [number, number][], t: number) {
  if (!pts.length) return 0;
  if (t <= pts[0][0]) return pts[0][1];
  if (t >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  let i = 1;
  while (pts[i][0] < t) i++;
  const [t0, v0] = pts[i - 1];
  const [t1, v1] = pts[i];
  return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
}
