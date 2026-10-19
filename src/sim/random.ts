import { intensityClass, makePhase } from './scenario';
import { createRng, type Rng } from './rng';
import type { Phase, PhaseEvent, Scenario } from './types';

export interface BankPoint {
  x: number;
  y: number;
  canal: string;
}

/**
 * Points just outside the banks of the main canals inside the city, where an overtopping or
 * breach would spill water onto the floodplain.
 */
export function bankPoints(waterways: { name: string; pts: [number, number][] }[], cityRadius = 4200): BankPoint[] {
  const out: BankPoint[] = [];
  for (const w of waterways) {
    if (!/อู่ตะเภา|อุ่ตะเภา|ร\.1|คลองหวะ/.test(w.name)) continue;
    const offset = /ร\.1/.test(w.name) ? 70 : 50;
    for (let k = 1; k < w.pts.length; k += 6) {
      const [ax, ay] = w.pts[k - 1];
      const [bx, by] = w.pts[k];
      const len = Math.hypot(bx - ax, by - ay) || 1;
      if (Math.hypot(bx, by) > cityRadius) continue;
      const side = k % 12 < 6 ? 1 : -1;
      out.push({ x: bx + (-(by - ay) / len) * offset * side, y: by + ((bx - ax) / len) * offset * side, canal: w.name });
    }
  }
  return out;
}

/** Event magnitudes as a function of return period (years), loosely fitted to Hat Yai records:
 *  2000 ≈ 970 m³/s, 2010 ≈ 1,620 m³/s (~50 yr), 2025 ≈ 3,100 m³/s and 370 mm/day (~300 yr). */
function magnitude(T: number) {
  return {
    peakInflow: 330 * T ** 0.43,
    peakDailyRain: 115 * T ** 0.21,
  };
}

const RETURN_PERIODS = [
  { T: 2, w: 0.22, label: 'รอบ 2 ปี' },
  { T: 5, w: 0.22, label: 'รอบ 5 ปี' },
  { T: 10, w: 0.18, label: 'รอบ 10 ปี' },
  { T: 25, w: 0.14, label: 'รอบ 25 ปี' },
  { T: 50, w: 0.11, label: 'รอบ 50 ปี' },
  { T: 100, w: 0.08, label: 'รอบ 100 ปี' },
  { T: 300, w: 0.05, label: 'รอบ 300 ปี' },
];

function pickT(r: Rng) {
  let x = r.next();
  for (const rp of RETURN_PERIODS) {
    if ((x -= rp.w) <= 0) return rp;
  }
  return RETURN_PERIODS[0];
}

/**
 * Random but physically shaped flood event: a build-up, one or two storm peaks whose intensity
 * follows a return-period draw, a lagged river flood wave, then recession — plus chance events.
 */
export function randomScenario(seed: number, banks: BankPoint[]): Scenario {
  const r = createRng(seed);
  const rp = pickT(r);
  const mag = magnitude(rp.T * r.range(0.8, 1.25));
  const monsoon = r.chance(0.8);
  const windDir = monsoon ? r.range(20, 80) : r.range(200, 260);
  const twoPeaks = r.chance(0.45);
  const baseInflow = r.range(30, 90);
  const phases: Phase[] = [];
  const add = (p: Partial<Phase>) => phases.push(makePhase({ wind_dir_deg: Math.round(windDir), ...p }));

  // design storm: the peak day carries ~45–60 % of the event's daily maximum in its heaviest hours
  const peakRain = (mag.peakDailyRain / 24) * r.range(2.2, 3.6);
  add({
    name: 'เมฆฝนก่อตัว',
    duration_hours: r.int(3, 9),
    rain_mm_hr: round(r.range(1, 6)),
    rain_pattern: 'uniform',
    rain_variability: 0.4,
    upstream_inflow_m3s: Math.round(baseInflow * r.range(1.2, 2)),
    lake_level_m: round(r.range(0.75, 0.95)),
  });
  add({
    name: 'ฝนหนักต่อเนื่อง',
    duration_hours: r.int(6, 16),
    rain_mm_hr: round(peakRain * r.range(0.25, 0.45)),
    rain_pattern: r.pick(['orographic', 'uniform', 'storm_cells'] as const),
    storm_cells: r.int(3, 6),
    rain_variability: round(r.range(0.3, 0.6)),
    wind_speed_kmh: Math.round(r.range(12, 30)),
    upstream_inflow_m3s: Math.round(mag.peakInflow * r.range(0.3, 0.5)),
    lake_level_m: round(r.range(0.85, 1.05)),
  });
  const peak = (label: string, share: number) =>
    add({
      name: label,
      duration_hours: r.int(3, 8),
      rain_mm_hr: round(peakRain * share),
      rain_pattern: r.chance(0.7) ? 'storm_cells' : 'squall_line',
      storm_cells: r.int(4, 10),
      rain_variability: round(r.range(0.5, 0.8)),
      wind_speed_kmh: Math.round(r.range(15, 40)),
      upstream_inflow_m3s: Math.round(mag.peakInflow * r.range(0.6, 0.8)),
      lake_level_m: round(r.range(0.95, 1.15)),
    });
  peak('พายุฝนรุนแรง', 1);
  if (twoPeaks) {
    add({ name: 'ฝนเว้นช่วง', duration_hours: r.int(4, 10), rain_mm_hr: round(r.range(2, 8)), upstream_inflow_m3s: Math.round(mag.peakInflow * r.range(0.75, 0.9)) });
    peak('พายุลูกที่สอง', r.range(0.6, 0.95));
  }
  add({
    name: 'น้ำเหนือหลากสูงสุด',
    duration_hours: r.int(6, 14),
    rain_mm_hr: round(r.range(2, 10)),
    upstream_inflow_m3s: Math.round(mag.peakInflow),
    lake_level_m: round(r.range(1.0, 1.25)),
  });
  add({ name: 'น้ำเริ่มลด', duration_hours: r.int(10, 20), rain_mm_hr: round(r.range(0, 2)), upstream_inflow_m3s: Math.round(mag.peakInflow * r.range(0.3, 0.45)), lake_level_m: round(r.range(0.95, 1.1)) });
  add({ name: 'ฟื้นฟู', duration_hours: r.int(12, 24), rain_mm_hr: 0, upstream_inflow_m3s: Math.round(baseInflow * 1.5), lake_level_m: 0.9, color: '#10b981' });

  for (const p of phases) if (p.color !== '#10b981') p.color = intensityClass(p.rain_mm_hr).color;

  // chance events, more likely in bigger floods
  const big = Math.min(1, Math.log10(rp.T) / 2.5);
  const peakIdx = phases.findIndex((p) => p.name === 'พายุฝนรุนแรง');
  const events: string[] = [];
  if (banks.length && r.chance(0.15 + 0.6 * big)) {
    const b = r.pick(banks);
    const target = phases[Math.min(phases.length - 2, peakIdx + 1 + r.int(0, 1))];
    const ev: PhaseEvent = {
      type: 'surge',
      at_hours: round(r.range(0, target.duration_hours * 0.5)),
      duration_hours: round(r.range(3, 9)),
      magnitude: Math.round(r.range(80, 220) * (0.5 + big)),
      x: Math.round(b.x),
      y: Math.round(b.y),
      label: `น้ำล้นตลิ่ง${b.canal}`,
    };
    target.events.push(ev);
    events.push(ev.label!);
  }
  if (r.chance(0.45)) {
    const target = phases[peakIdx];
    target.events.push({ type: 'drain_block', at_hours: 0, duration_hours: target.duration_hours, magnitude: round(r.range(0.3, 0.8)), label: 'ท่อระบายน้ำอุดตัน' });
    events.push('ท่อระบายน้ำอุดตัน');
  }
  if (r.chance(0.25 + 0.3 * big)) {
    const target = phases[phases.length - 3];
    target.events.push({ type: 'lake_surge', at_hours: 0, duration_hours: target.duration_hours, magnitude: round(r.range(0.2, 0.5)), label: 'ทะเลสาบหนุนสูง' });
    events.push('ทะเลสาบหนุนสูง');
  }

  const totalRain = phases.reduce((s, p) => s + p.rain_mm_hr * p.duration_hours, 0);
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), 10, r.int(5, 28), r.pick([23, 5, 11, 17]), 0, 0));
  return {
    name: `สุ่ม #${seed % 10000} · ${rp.label}`,
    description: `ฝนรวม ~${Math.round(totalRain)} มม., น้ำไหลเข้าสูงสุด ~${Math.round(mag.peakInflow).toLocaleString('th-TH')} ลบ.ม./วิ, ลม${monsoon ? 'มรสุมตะวันออกเฉียงเหนือ' : 'ตะวันตกเฉียงใต้'}${events.length ? `, เหตุการณ์สุ่ม: ${events.join(', ')}` : ''}`,
    source: 'random',
    seed,
    start_time: start.toISOString(),
    settings: { initial_inflow_m3s: Math.round(baseInflow), initial_lake_m: phases[0].lake_level_m },
    phases,
  };
}

const round = (v: number) => Math.round(v * 10) / 10;
