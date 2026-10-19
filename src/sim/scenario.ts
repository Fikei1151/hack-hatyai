import type { Forcing, Phase, Scenario } from './types';

export const HOUR = 3600;

export function newId(): string {
  return crypto.randomUUID();
}

/** Rain intensity classes used for phase colours and labels (mm/hr, hourly). */
export const INTENSITY_CLASSES = [
  { max: 0.5, label: 'ฝนหยุด', color: '#64748b' },
  { max: 5, label: 'ฝนเล็กน้อย', color: '#7dd3fc' },
  { max: 15, label: 'ฝนปานกลาง', color: '#38bdf8' },
  { max: 35, label: 'ฝนหนัก', color: '#2563eb' },
  { max: 60, label: 'ฝนหนักมาก', color: '#7c3aed' },
  { max: Infinity, label: 'พายุฝนรุนแรง', color: '#db2777' },
] as const;

export function intensityClass(mmHr: number) {
  return INTENSITY_CLASSES.find((c) => mmHr < c.max) ?? INTENSITY_CLASSES[INTENSITY_CLASSES.length - 1];
}

export function makePhase(overrides: Partial<Phase> = {}): Phase {
  const rain = overrides.rain_mm_hr ?? 10;
  return {
    id: newId(),
    name: intensityClass(rain).label,
    color: intensityClass(rain).color,
    duration_hours: 6,
    ramp_hours: 0.5,
    rain_mm_hr: rain,
    rain_pattern: 'uniform',
    rain_variability: 0.35,
    storm_cells: 0,
    wind_dir_deg: 45,
    wind_speed_kmh: 15,
    upstream_inflow_m3s: 40,
    lake_level_m: 1.0,
    drainage_mm_hr: 30,
    infiltration_mm_hr: 6,
    events: [],
    notes: '',
    ...overrides,
  };
}

export function totalHours(s: Scenario): number {
  return s.phases.reduce((sum, p) => sum + p.duration_hours, 0);
}

export function phaseStarts(s: Scenario): number[] {
  const out: number[] = [];
  let t = 0;
  for (const p of s.phases) {
    out.push(t);
    t += p.duration_hours * HOUR;
  }
  return out;
}

const smooth = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, w: number) => a + (b - a) * w;

export function phaseIndexAt(s: Scenario, t: number): number {
  let acc = 0;
  for (let i = 0; i < s.phases.length; i++) {
    acc += s.phases[i].duration_hours * HOUR;
    if (t < acc) return i;
  }
  return Math.max(0, s.phases.length - 1);
}

/** Forcing at simulation time t (seconds), with parameters blended across phase boundaries. */
export function sampleForcing(s: Scenario, t: number): Forcing {
  const starts = phaseStarts(s);
  const i = phaseIndexAt(s, t);
  const cur = s.phases[i];
  const prev = i > 0 ? s.phases[i - 1] : cur;
  const phaseT = t - (starts[i] ?? 0);
  const w = cur.ramp_hours > 0 ? smooth(phaseT / (cur.ramp_hours * HOUR)) : 1;
  const bias = s.settings.rain_bias ?? 1;
  const ended = t >= totalHours(s) * HOUR;

  let drainageFactor = 1;
  let lakeExtra = 0;
  const surges: Forcing['surges'] = [];
  for (const ev of cur.events) {
    const e0 = ev.at_hours * HOUR;
    const e1 = e0 + Math.max(0.1, ev.duration_hours) * HOUR;
    if (phaseT < e0 || phaseT > e1) continue;
    const u = (phaseT - e0) / (e1 - e0);
    // breach hydrograph: fast rise (first 25 %), slow recession
    const shape = u < 0.25 ? u / 0.25 : 1 - (u - 0.25) / 0.75;
    if (ev.type === 'surge' && ev.x !== undefined && ev.y !== undefined) surges.push({ x: ev.x, y: ev.y, m3s: ev.magnitude * shape, label: ev.label });
    if (ev.type === 'drain_block') drainageFactor *= 1 - Math.min(1, ev.magnitude) * Math.min(1, u * 6, (1 - u) * 6);
    if (ev.type === 'lake_surge') lakeExtra += ev.magnitude * Math.sin(Math.PI * u);
  }

  const rain = ended ? 0 : lerp(prev.rain_mm_hr, cur.rain_mm_hr, w) * bias;
  // river/lake values are reached at the phase end → piecewise-linear hydrograph
  const u = Math.min(1, Math.max(0, phaseT / (cur.duration_hours * HOUR)));
  const inflow0 = i > 0 ? prev.upstream_inflow_m3s : (s.settings.initial_inflow_m3s ?? cur.upstream_inflow_m3s);
  const lake0 = i > 0 ? prev.lake_level_m : (s.settings.initial_lake_m ?? cur.lake_level_m);
  return {
    phaseIndex: i,
    phaseT,
    rainMmHr: rain,
    pattern: w < 0.5 ? prev.rain_pattern : cur.rain_pattern,
    variability: lerp(prev.rain_variability, cur.rain_variability, w),
    stormCells: Math.round(lerp(prev.storm_cells, cur.storm_cells, w)),
    windDirDeg: lerpAngle(prev.wind_dir_deg, cur.wind_dir_deg, w),
    windSpeedKmh: lerp(prev.wind_speed_kmh, cur.wind_speed_kmh, w),
    inflowM3s: lerp(inflow0, cur.upstream_inflow_m3s, u),
    lakeLevelM: lerp(lake0, cur.lake_level_m, u) + lakeExtra,
    drainageMmHr: lerp(prev.drainage_mm_hr, cur.drainage_mm_hr, w) * drainageFactor,
    infiltrationMmHr: lerp(prev.infiltration_mm_hr, cur.infiltration_mm_hr, w),
    surges,
  };
}

function lerpAngle(a: number, b: number, w: number) {
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return (a + d * w + 360) % 360;
}

export function cloneScenario(s: Scenario): Scenario {
  return JSON.parse(JSON.stringify(s));
}

export function formatDuration(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)} นาที`;
  const d = Math.floor(hours / 24);
  const h = Math.round((hours - d * 24) * 10) / 10;
  return d > 0 ? `${d} วัน ${h > 0 ? `${h} ชม.` : ''}`.trim() : `${h} ชม.`;
}

export const WIND_NAMES = ['เหนือ', 'ตะวันออกเฉียงเหนือ', 'ตะวันออก', 'ตะวันออกเฉียงใต้', 'ใต้', 'ตะวันตกเฉียงใต้', 'ตะวันตก', 'ตะวันตกเฉียงเหนือ'];
export const windName = (deg: number) => WIND_NAMES[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

export const PATTERN_LABELS: Record<Phase['rain_pattern'], string> = {
  uniform: 'ทั่วพื้นที่ (แปรปรวน)',
  storm_cells: 'กลุ่มเมฆฝนเคลื่อนที่',
  orographic: 'ฝนภูเขา (ตกหนักฝั่งเขา)',
  squall_line: 'แนวพายุฝนฟ้าคะนอง',
};
