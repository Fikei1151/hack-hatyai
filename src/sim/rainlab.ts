import { makePhase } from './scenario';
import type { RainPattern, Scenario } from './types';

export type RiverState = 'normal' | 'full' | 'flood';

export interface RainLabOptions {
  /** rain intensity, mm/hr (domain average) */
  intensity: number;
  hours: number;
  pattern: Extract<RainPattern, 'uniform' | 'storm_cells' | 'orographic'>;
  river: RiverState;
  drainsBlocked: boolean;
}

export const RIVER_STATES: Record<RiverState, { inflow: number; label: string; emoji: string; hint: string; fillHours: number }> = {
  normal: { inflow: 60, label: 'คลองปกติ', emoji: '🙂', hint: 'น้ำเหนือน้อย คลองยังรับน้ำฝนได้', fillHours: 0 },
  full: { inflow: 600, label: 'คลองเต็มตลิ่ง', emoji: '😬', hint: 'น้ำเหนือ ~600 ลบ.ม./วิ ไหลมาเติมคลองก่อนฝนตก ท่อระบายน้ำเริ่มระบายไม่ออก', fillHours: 6 },
  flood: { inflow: 1500, label: 'น้ำเหนือหลาก', emoji: '😱', hint: 'น้ำเหนือ ~1,500 ลบ.ม./วิ แบบช่วงน้ำท่วมใหญ่ ล้นตลิ่งเข้าเมืองก่อนฝนจะตกด้วยซ้ำ', fillHours: 9 },
};

export const PATTERNS: Record<RainLabOptions['pattern'], { label: string; emoji: string }> = {
  storm_cells: { label: 'เมฆฝนเคลื่อนผ่าน', emoji: '⛈️' },
  uniform: { label: 'ตกทั่วทั้งเมือง', emoji: '🌧️' },
  orographic: { label: 'ตกหนักฝั่งเขา', emoji: '⛰️' },
};

/** Storm-drain capacity of the city (mm/hr) — the yardstick for "will the streets flood?" */
export const DRAIN_CAPACITY = 30;

export function compareRain(mmHr: number): string {
  if (mmHr <= 10) return 'ฝนตกธรรมดาช่วงหน้าฝน ท่อระบายน้ำรับไหวสบาย ๆ';
  if (mmHr <= 30) return 'ฝนหนักแบบที่เจอบ่อยหน้ามรสุม ท่อระบายน้ำเริ่มทำงานหนัก';
  if (mmHr <= 50) return 'ฝนหนักมาก ใกล้ช่วงที่หนักที่สุดของน้ำท่วมใหญ่ปี 68 (~45 มม./ชม.)';
  if (mmHr <= 90) return 'พายุฝนรุนแรง หนักกว่าช่วงหนักสุดของปี 68 — ฝนแบบนี้ 1–2 ชม. ถนนก็ท่วมได้';
  return 'ฝนระดับหายากมาก (สถิติโลกเขตร้อน) ระบบระบายน้ำไหนก็รับไม่ไหว';
}

/**
 * A short what-if storm: the river rises first (the sim always starts from dry-weather flow, so a
 * "full" river has to arrive before the rain does), clouds build, the rain itself, then six hours of
 * drying out. The rain starts at 13:00 today so it plays out in daylight.
 */
export function rainLabScenario(o: RainLabOptions, now = new Date()): Scenario {
  const river = RIVER_STATES[o.river];
  const drains = o.drainsBlocked ? 10 : DRAIN_CAPACITY;
  const lake = o.river === 'flood' ? 1.2 : 0.9;
  const day = new Date(now.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
  const start = new Date(Date.parse(`${day}T13:00:00+07:00`) - (river.fillHours + 0.5) * 3600_000);
  const rainy = { rain_pattern: o.pattern, storm_cells: o.pattern === 'storm_cells' ? 5 : 0, rain_variability: 0.45, wind_dir_deg: 45, wind_speed_kmh: 12 };
  return {
    name: `🧪 ฝน ${o.intensity} มม./ชม. นาน ${o.hours} ชม. · ${river.label}`,
    description: `ทดลองว่าถ้าฝนตกเฉลี่ย ${o.intensity} มม./ชม. นาน ${o.hours} ชม. (รวม ${o.intensity * o.hours} มม.) ขณะที่${river.label}${o.drainsBlocked ? ' และท่อระบายน้ำอุดตัน' : ''} น้ำในเมืองจะเป็นอย่างไร`,
    source: 'custom',
    seed: Math.floor(Math.random() * 1e6),
    start_time: start.toISOString(),
    settings: {
      initial_inflow_m3s: river.inflow,
      initial_lake_m: lake,
      rain_lab: { intensity: o.intensity, hours: o.hours, pattern: o.pattern, river: o.river, drainsBlocked: o.drainsBlocked },
    },
    phases: [
      ...(river.fillHours
        ? [makePhase({ name: '🌊 น้ำเหนือไหลมาเติมคลอง', color: '#67c5f0', duration_hours: river.fillHours, ramp_hours: 2, rain_mm_hr: 0, upstream_inflow_m3s: river.inflow, lake_level_m: lake, drainage_mm_hr: drains })]
        : []),
      makePhase({ name: '☁️ เมฆฝนก่อตัว', color: '#9ec5f4', duration_hours: 0.5, ramp_hours: 0.25, rain_mm_hr: Math.round(o.intensity * 0.15), ...rainy, upstream_inflow_m3s: river.inflow, lake_level_m: lake, drainage_mm_hr: drains }),
      makePhase({
        name: `🌧️ ฝน ${o.intensity} มม./ชม.`,
        color: o.intensity >= 60 ? '#db2777' : o.intensity >= 35 ? '#7c3aed' : '#2563eb',
        duration_hours: o.hours,
        ramp_hours: 0.25,
        rain_mm_hr: o.intensity,
        ...rainy,
        upstream_inflow_m3s: Math.round(river.inflow * 1.15),
        lake_level_m: lake,
        drainage_mm_hr: drains,
      }),
      makePhase({ name: '🌤️ ฝนหยุด น้ำค่อย ๆ ลด', color: '#10b981', duration_hours: 6, ramp_hours: 0.25, rain_mm_hr: 0, upstream_inflow_m3s: river.inflow, lake_level_m: lake, drainage_mm_hr: drains }),
    ],
  };
}
