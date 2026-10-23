import { makePhase } from '../sim/scenario';
import { createRng } from '../sim/rng';
import type { RainPattern, Scenario } from '../sim/types';

export type Difficulty = 'easy' | 'normal' | 'hard';

export interface DifficultyInfo {
  id: Difficulty;
  label: string;
  emoji: string;
  blurb: string;
  /** return period of the storm's peak, years (sets rain and river size, as in the random flood generator) */
  T: number;
  /** river inflow when the game starts, m³/s */
  q0: number;
  startCalls: number;
  callsPerRound: number;
  /** relative error of the forecast shown to players */
  forecastSigma: number;
  /** share of event cards that are bad news */
  badShare: number;
}

export const DIFFICULTY: Record<Difficulty, DifficultyInfo> = {
  easy: { id: 'easy', label: 'ฝนมรสุม', emoji: '🌦️', blurb: 'ฝนหนักบางช่วง น้ำท่วมขังตามที่ลุ่ม (รอบ ~5 ปี)', T: 5, q0: 60, startCalls: 3, callsPerRound: 1.3, forecastSigma: 0.15, badShare: 0.3 },
  normal: { id: 'normal', label: 'พายุหนัก', emoji: '⛈️', blurb: 'น้ำล้นคลองเข้าหลายย่าน ถนนสายรองจมหลายสาย (รอบ ~25 ปี)', T: 25, q0: 80, startCalls: 4, callsPerRound: 1.8, forecastSigma: 0.25, badShare: 0.4 },
  hard: { id: 'hard', label: 'มหาอุทกภัย', emoji: '🌊', blurb: 'ระดับน้ำท่วมใหญ่ปี 53–68 ถนนสายหลักจมเป็นแนว (รอบ ~100 ปี)', T: 100, q0: 120, startCalls: 5, callsPerRound: 2.3, forecastSigma: 0.35, badShare: 0.5 },
};

export interface StormRound {
  rain: number;
  inflow: number;
  lake: number;
  pattern: RainPattern;
  cells: number;
  windDir: number;
  windSpeed: number;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

/** A random storm shaped like the real ones: calm first round, one or two peaks, a slow river. */
export function generateStorm(seed: number, difficulty: Difficulty, rounds: number, roundHours: number, startIso: string): { rounds: StormRound[]; scenario: Scenario } {
  const rng = createRng(seed * 7919 + 17);
  const d = DIFFICULTY[difficulty];
  const peakDaily = 115 * d.T ** 0.21; // mm/day, as in the random flood generator (Hat Yai records)
  const peakInflow = 330 * d.T ** 0.43; // m³/s
  const rainPeak = (peakDaily * 0.65) / roundHours; // mm/h in the worst round
  const peakRound = rng.int(Math.max(2, Math.round(rounds * 0.35)), Math.max(3, Math.round(rounds * 0.65)));
  const width = rng.range(0.9, 1.5);
  const env = (k: number) => Math.exp(-0.5 * ((k - peakRound) / width) ** 2);

  const out: StormRound[] = [];
  let store = 0;
  for (let k = 1; k <= rounds; k++) {
    let rain = 2 + rng.range(0, 3) + (rainPeak - 3) * env(k) * rng.range(0.8, 1.15);
    if (k >= 2 && rng.chance(0.12)) rain *= 1.35;
    if (k === 1) rain = Math.min(rain, rng.range(1, 6));
    rain = r1(Math.min(rain, rainPeak * 1.5));
    // the river is a slow reservoir of the rain that fell upstream
    store = 0.65 * store + 0.35 * (rain / rainPeak);
    const inflow = Math.round(d.q0 + (peakInflow - d.q0) * Math.min(1.1, store * 1.4));
    const lake = r1(1.0 + (difficulty === 'hard' ? 0.5 : difficulty === 'normal' ? 0.3 : 0.15) * env(k - 0.5)) ;
    const pattern: RainPattern = rng.pick<RainPattern>(['storm_cells', 'storm_cells', 'storm_cells', 'uniform', 'uniform', 'orographic']);
    out.push({ rain, inflow, lake, pattern, cells: pattern === 'storm_cells' ? rng.int(3, 6) : 0, windDir: rng.int(20, 340), windSpeed: rng.int(8, 26) });
  }

  const phases = out.map((s, i) =>
    makePhase({
      name: `รอบ ${i + 1}`,
      duration_hours: roundHours,
      ramp_hours: Math.min(1, roundHours / 4),
      rain_mm_hr: s.rain,
      rain_pattern: s.pattern,
      storm_cells: s.cells,
      rain_variability: 0.45,
      wind_dir_deg: s.windDir,
      wind_speed_kmh: s.windSpeed,
      upstream_inflow_m3s: s.inflow,
      lake_level_m: s.lake,
    }),
  );
  // a dry tail so the game's last flood phase never reaches the end of the scenario
  const last = out[out.length - 1];
  phases.push(makePhase({ name: 'ฝนซา', duration_hours: 1, ramp_hours: 0.5, rain_mm_hr: 0, upstream_inflow_m3s: last.inflow, lake_level_m: last.lake }));

  const scenario: Scenario = {
    name: `🎲 เกมกู้ภัยน้ำท่วม · ฉาก #${seed}`,
    description: `พายุแบบสุ่มระดับ${d.label} ${rounds} รอบ รอบละ ${roundHours} ชม.`,
    source: 'random',
    seed,
    start_time: startIso,
    settings: { initial_inflow_m3s: d.q0, initial_lake_m: 1.0 },
    phases,
  };
  return { rounds: out, scenario };
}

/** Scenario start: 06:00 Bangkok time today, so the game opens at sunrise. */
export function gameStartIso(now = new Date()): string {
  const day = new Date(now.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
  return new Date(`${day}T06:00:00+07:00`).toISOString();
}
