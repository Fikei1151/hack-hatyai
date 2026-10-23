// Ensemble outlook for Hat Yai: how likely is flooding on each of the next 10 days?
//   Rain  — Open-Meteo ensemble API: ECMWF IFS 0.25° (51 members) + NCEP GEFS 0.25° (31 members), hourly
//   River — GloFAS v4 ensemble (51 members) via the Open-Meteo flood API, scaled to today's RID gauges
// A day's chance of flooding is the share of forecast members that cross a flood threshold.
import { fetchLiveStatus, phasesFromHourly } from './realdata';
import type { Scenario } from './types';

const HAT_YAI = { lat: 7.0086, lon: 100.4747 };
const GLOFAS_CELL = { lat: 6.975, lon: 100.425 };
const DAYS = 10;

/** Flood thresholds, tied to what the city's drains and canals can take (see README calibration). */
export const THRESHOLDS = {
  /** an hour of rain beyond the ~30 mm/hr storm drains floods streets */
  pluvialHourly: 35,
  /** a very wet day floods low streets even without a cloudburst */
  pluvialDaily: 80,
  /** total river inflow at which U-Taphao overtops into the city (2025 replay: city flooding from ~750 m³/s) */
  riverCity: 800,
  /** major river flood (2010 peak 1,620 m³/s; 2025 ~3,300 m³/s) */
  riverMajor: 1500,
};

export type RiskLevel = 'low' | 'watch' | 'high' | 'severe';

export const RISK: Record<RiskLevel, { label: string; emoji: string; status: 'good' | 'warning' | 'serious' | 'critical' }> = {
  low: { label: 'ต่ำ', emoji: '😊', status: 'good' },
  watch: { label: 'เฝ้าระวัง', emoji: '🤔', status: 'warning' },
  high: { label: 'สูง', emoji: '😟', status: 'serious' },
  severe: { label: 'สูงมาก', emoji: '😱', status: 'critical' },
};

export interface DayOutlook {
  /** YYYY-MM-DD, Asia/Bangkok */
  date: string;
  rainMean: number;
  rainP10: number;
  rainP50: number;
  rainP90: number;
  maxHourlyMean: number;
  /** probability of a daily total ≥ 35 mm (TMD "heavy rain") */
  pHeavyRain: number;
  /** probability of street flooding from rain alone */
  pPluvial: number;
  riverMedian: number | null;
  riverP90: number | null;
  /** probability that river inflow tops the city banks */
  pRiver: number | null;
  pMajor: number | null;
  /** combined chance of flooding in the city */
  pFlood: number;
  level: RiskLevel;
  hourlyMean: number[];
  /** index of the rain member whose daily total sits at the 90th percentile */
  p90Member: number;
}

export interface Outlook {
  fetchedAt: string;
  days: DayOutlook[];
  /** hourly rain per member, local time from day 0 00:00 */
  rainMembers: number[][];
  /** daily river discharge per member (bias-corrected), m³/s */
  riverMembers: number[][];
  riverBias: number | null;
  observedInflow: number | null;
  sources: string[];
}

async function json<T>(url: string): Promise<T> {
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

function quantile(sorted: number[], q: number) {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

export function riskLevel(p: number): RiskLevel {
  return p >= 0.6 ? 'severe' : p >= 0.3 ? 'high' : p >= 0.1 ? 'watch' : 'low';
}

export async function fetchOutlook(): Promise<Outlook> {
  const ens = await json<{ hourly: Record<string, (number | null)[]> & { time: string[] } }>(
    `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${HAT_YAI.lat}&longitude=${HAT_YAI.lon}&hourly=precipitation&models=ecmwf_ifs025,gfs025&forecast_days=${DAYS}&timezone=Asia%2FBangkok`,
  );
  const times = ens.hourly.time;
  const firstDay = times[0].slice(0, 10);
  const rainMembers: number[][] = [];
  for (const [k, v] of Object.entries(ens.hourly)) {
    if (k === 'time' || !k.startsWith('precipitation')) continue;
    const arr = v as (number | null)[];
    const missing = arr.filter((x) => x === null).length;
    if (missing > arr.length * 0.25) continue;
    rainMembers.push(arr.map((x) => x ?? 0));
  }
  if (!rainMembers.length) throw new Error('ไม่มีข้อมูลพยากรณ์ฝน');

  let riverMembers: number[][] = [];
  let riverBias: number | null = null;
  let observedInflow: number | null = null;
  try {
    const fl = await json<{ daily: Record<string, (number | null)[]> & { time: string[] } }>(
      `https://flood-api.open-meteo.com/v1/flood?latitude=${GLOFAS_CELL.lat}&longitude=${GLOFAS_CELL.lon}&daily=river_discharge&forecast_days=${DAYS}&ensemble=true`,
    );
    const raw = Object.entries(fl.daily)
      .filter(([k]) => k.startsWith('river_discharge'))
      .map(([, v]) => (v as (number | null)[]).map((x) => x ?? 0));
    try {
      const live = await fetchLiveStatus();
      const q = live.gauges.filter((g) => g.code === 'X.90' || g.code === 'X.174').reduce((s, g) => s + (g.discharge ?? 0), 0);
      if (q > 0) observedInflow = q;
    } catch {
      /* gauges offline: use GloFAS as is */
    }
    const control = fl.daily.river_discharge?.[0] ?? null;
    riverBias = observedInflow && control ? Math.min(4, Math.max(0.25, observedInflow / control)) : null;
    riverMembers = raw.map((m) => m.map((q) => q * (riverBias ?? 1)));
  } catch {
    riverMembers = [];
  }

  const days: DayOutlook[] = [];
  for (let d = 0; d < DAYS; d++) {
    const date = addDays(firstDay, d);
    const idx = times.map((t, i) => [t, i] as const).filter(([t]) => t.startsWith(date)).map(([, i]) => i);
    if (idx.length < 20) continue;
    const daily = rainMembers.map((m) => idx.reduce((s, i) => s + m[i], 0));
    const maxH = rainMembers.map((m) => Math.max(...idx.map((i) => m[i])));
    const sortedDaily = [...daily].sort((a, b) => a - b);
    const n = rainMembers.length;
    const pPluvial = rainMembers.reduce((s, _, k) => s + (maxH[k] >= THRESHOLDS.pluvialHourly || daily[k] >= THRESHOLDS.pluvialDaily ? 1 : 0), 0) / n;
    const hourlyMean = idx.map((i) => rainMembers.reduce((s, m) => s + m[i], 0) / n);
    const p90 = quantile(sortedDaily, 0.9);
    let p90Member = 0;
    daily.forEach((v, k) => {
      if (Math.abs(v - p90) < Math.abs(daily[p90Member] - p90)) p90Member = k;
    });

    let riverMedian: number | null = null;
    let riverP90: number | null = null;
    let pRiver: number | null = null;
    let pMajor: number | null = null;
    if (riverMembers.length && riverMembers[0].length > d) {
      const q = riverMembers.map((m) => m[d]).sort((a, b) => a - b);
      riverMedian = quantile(q, 0.5);
      riverP90 = quantile(q, 0.9);
      pRiver = q.filter((v) => v >= THRESHOLDS.riverCity).length / q.length;
      pMajor = q.filter((v) => v >= THRESHOLDS.riverMajor).length / q.length;
    }
    // rain and river ensembles are separate model systems: combine as independent chances
    const pFlood = 1 - (1 - pPluvial) * (1 - (pRiver ?? 0));
    days.push({
      date,
      rainMean: daily.reduce((s, v) => s + v, 0) / n,
      rainP10: quantile(sortedDaily, 0.1),
      rainP50: quantile(sortedDaily, 0.5),
      rainP90: p90,
      maxHourlyMean: Math.max(...hourlyMean),
      pHeavyRain: daily.filter((v) => v >= 35).length / n,
      pPluvial,
      riverMedian,
      riverP90,
      pRiver,
      pMajor,
      pFlood,
      level: riskLevel(pFlood),
      hourlyMean,
      p90Member,
    });
  }
  return {
    fetchedAt: new Date().toISOString(),
    days,
    rainMembers,
    riverMembers,
    riverBias,
    observedInflow,
    sources: [
      `ฝน: Open-Meteo Ensemble (ECMWF IFS + NCEP GEFS) ${rainMembers.length} ชุด`,
      riverMembers.length ? `น้ำท่า: GloFAS ${riverMembers.length} ชุด${riverBias ? ` ปรับเทียบกับสถานี X.90+X.174 (${Math.round(observedInflow ?? 0)} ลบ.ม./วิ)` : ''}` : 'น้ำท่า: ไม่มีข้อมูล GloFAS',
    ],
  };
}

function addDays(ymd: string, d: number) {
  const t = Date.parse(`${ymd}T12:00:00Z`) + d * 86400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Scenario for one forecast day: the ensemble-mean storm, or the member at the wet 90th percentile. */
export function dayScenario(o: Outlook, dayIndex: number, variant: 'mean' | 'p90'): Scenario {
  const day = o.days[dayIndex];
  const startH = dayIndex * 24;
  const rain = variant === 'mean' ? day.hourlyMean : o.rainMembers[day.p90Member].slice(startH, startH + 24);
  const qNow = (variant === 'mean' ? day.riverMedian : day.riverP90) ?? 60;
  const next = o.days[dayIndex + 1];
  const qNext = (variant === 'mean' ? next?.riverMedian : next?.riverP90) ?? qNow;
  const inflow = rain.map((_, h) => qNow + ((qNext - qNow) * h) / 24);
  const start = `${day.date}T00:00:00+07:00`;
  const total = rain.reduce((s, v) => s + v, 0);
  return {
    name: `📅 ${thaiDay(day.date)} · ${variant === 'mean' ? 'ค่าเฉลี่ยพยากรณ์' : 'กรณีฝนหนัก (P90)'}`,
    description: `ฝนรวม ~${Math.round(total)} มม. น้ำเหนือ ~${Math.round(qNow)} ลบ.ม./วิ · โอกาสน้ำท่วม ${Math.round(day.pFlood * 100)}% (${o.sources.join(' · ')})`,
    source: 'forecast',
    seed: Math.floor(Math.random() * 1e6),
    start_time: new Date(start).toISOString(),
    settings: { initial_inflow_m3s: Math.round(inflow[0]), initial_lake_m: 0.9, forecast: { day: day.date, variant, fetchedAt: o.fetchedAt } },
    phases: phasesFromHourly({ start: new Date(start).toISOString(), rainMmHr: rain, inflowM3s: inflow, lakeM: rain.map(() => 0.9) }, { minHours: 2, maxHours: 6 }),
  };
}

/** The whole outlook as one continuous scenario (ensemble-mean rain, median river). */
export function outlookScenario(o: Outlook): Scenario {
  const first = o.days[0];
  const hours = o.days.length * 24;
  const rain = Array.from({ length: hours }, (_, h) => o.rainMembers.reduce((s, m) => s + (m[h] ?? 0), 0) / o.rainMembers.length);
  const inflow = Array.from({ length: hours }, (_, h) => {
    const d = Math.min(o.days.length - 1, Math.floor(h / 24));
    const a = o.days[d].riverMedian ?? 60;
    const b = o.days[Math.min(o.days.length - 1, d + 1)].riverMedian ?? a;
    return a + ((b - a) * (h % 24)) / 24;
  });
  const start = new Date(`${first.date}T00:00:00+07:00`).toISOString();
  return {
    name: `📅 พยากรณ์ ${o.days.length} วัน (${thaiDay(first.date)} →)`,
    description: `ฝนเฉลี่ยจากพยากรณ์ ${o.rainMembers.length} ชุด และน้ำเหนือค่ามัธยฐาน · ${o.sources.join(' · ')}`,
    source: 'forecast',
    seed: Math.floor(Math.random() * 1e6),
    start_time: start,
    settings: { initial_inflow_m3s: Math.round(inflow[0]), initial_lake_m: 0.9, forecast: { variant: 'mean', fetchedAt: o.fetchedAt } },
    phases: phasesFromHourly({ start, rainMmHr: rain, inflowM3s: inflow, lakeM: rain.map(() => 0.9) }, { minHours: 3, maxHours: 12 }),
  };
}

const dayFmt = new Intl.DateTimeFormat('th-TH', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Bangkok' });
export const thaiDay = (ymd: string) => dayFmt.format(new Date(`${ymd}T12:00:00+07:00`));
