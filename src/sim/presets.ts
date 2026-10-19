import type { BankPoint } from './random';
import { makePhase } from './scenario';
import type { Scenario } from './types';

/** Synthetic design scenarios. Observed-event replays are built from events.json (see realdata.ts). */
export function syntheticPresets(banks: BankPoint[]): Scenario[] {
  // breach on the Ban Hat Yai Nai (left/west) bank near gauge X.44, where RID reports first overtopping
  const breach = banks
    .filter((b) => /อู่ตะเภา|อุ่ตะเภา/.test(b.canal))
    .sort((a, b) => Math.hypot(a.x + 1600, a.y + 860) - Math.hypot(b.x + 1600, b.y + 860))[0] ?? { x: -1600, y: -860 };
  return [
    {
      slug: 'flash-storm',
      name: 'ฝนตกหนักเฉียบพลันกลางเมือง 2 ชั่วโมง',
      description:
        'พายุฝนฟ้าคะนองนิ่งอยู่เหนือตัวเมือง ฝน 80–90 มม./ชม. เกินขีดความสามารถท่อระบายน้ำ — น้ำท่วมขังจุดต่ำ อุโมงค์ และถนนสายหลัก แม้น้ำในคลองยังไม่ล้นตลิ่ง',
      source: 'preset',
      seed: 11,
      start_time: '2026-11-12T14:00:00+07:00',
      settings: { initial_inflow_m3s: 45, initial_lake_m: 0.8 },
      phases: [
        makePhase({ name: 'เมฆฝนก่อตัว', duration_hours: 1, rain_mm_hr: 12, rain_pattern: 'storm_cells', storm_cells: 3, rain_variability: 0.6, wind_speed_kmh: 12, upstream_inflow_m3s: 50, lake_level_m: 0.8 }),
        makePhase({ name: 'พายุฝนกระหน่ำ', duration_hours: 2, rain_mm_hr: 85, rain_pattern: 'storm_cells', storm_cells: 4, rain_variability: 0.7, wind_speed_kmh: 8, upstream_inflow_m3s: 90, lake_level_m: 0.8, color: '#db2777' }),
        makePhase({ name: 'ฝนซา', duration_hours: 2, rain_mm_hr: 6, rain_pattern: 'uniform', upstream_inflow_m3s: 160, lake_level_m: 0.8 }),
        makePhase({ name: 'น้ำระบาย', duration_hours: 7, rain_mm_hr: 0, upstream_inflow_m3s: 70, lake_level_m: 0.8, color: '#10b981' }),
      ],
    },
    {
      slug: 'monsoon-3day',
      name: 'มรสุมตะวันออกเฉียงเหนือ 3 วัน + น้ำเหนือหลาก',
      description:
        'ร่องมรสุมพาดผ่านภาคใต้ตอนล่าง ฝนตกต่อเนื่องหลายวัน น้ำจากต้นน้ำคลองอู่ตะเภาไหลหลากเข้าเมือง ทะเลสาบสงขลาหนุนสูง — รูปแบบเดียวกับเหตุการณ์ใหญ่ในอดีต',
      source: 'preset',
      seed: 23,
      start_time: '2026-11-20T06:00:00+07:00',
      settings: { initial_inflow_m3s: 60, initial_lake_m: 0.85 },
      phases: [
        makePhase({ name: 'ฝนเริ่มตก', duration_hours: 12, rain_mm_hr: 5, rain_pattern: 'uniform', upstream_inflow_m3s: 180, lake_level_m: 0.85 }),
        makePhase({ name: 'ฝนหนักต่อเนื่อง', duration_hours: 18, rain_mm_hr: 16, rain_pattern: 'orographic', rain_variability: 0.4, upstream_inflow_m3s: 650, lake_level_m: 0.95 }),
        makePhase({ name: 'พายุฝนรุนแรง', duration_hours: 12, rain_mm_hr: 38, rain_pattern: 'storm_cells', storm_cells: 7, rain_variability: 0.6, wind_speed_kmh: 25, upstream_inflow_m3s: 1500, lake_level_m: 1.05 }),
        makePhase({ name: 'น้ำเหนือหลากสูงสุด', duration_hours: 12, rain_mm_hr: 10, rain_pattern: 'uniform', upstream_inflow_m3s: 2100, lake_level_m: 1.15 }),
        makePhase({ name: 'ฝนซา น้ำเริ่มลด', duration_hours: 18, rain_mm_hr: 2, upstream_inflow_m3s: 900, lake_level_m: 1.1 }),
        makePhase({ name: 'ระบายน้ำ ฟื้นฟู', duration_hours: 24, rain_mm_hr: 0, upstream_inflow_m3s: 160, lake_level_m: 0.95, color: '#10b981' }),
      ],
    },
    {
      slug: 'levee-breach',
      name: 'น้ำล้นคันคลองอู่ตะเภา + ท่อระบายน้ำอุดตัน (สมมติ)',
      description:
        'น้ำเหนือสูงเกินความจุคลอง ร.1 ตลิ่งคลองอู่ตะเภาฝั่งบ้านหาดใหญ่ในเกิดจุดน้ำล้นทะลัก และขยะอุดตันท่อระบายน้ำในเขตเมือง — ทดสอบผลกระทบของเหตุการณ์ซ้อน',
      source: 'preset',
      seed: 31,
      start_time: '2026-11-24T00:00:00+07:00',
      settings: { initial_inflow_m3s: 300, initial_lake_m: 1.0 },
      phases: [
        makePhase({ name: 'ฝนหนัก', duration_hours: 8, rain_mm_hr: 20, rain_pattern: 'storm_cells', storm_cells: 6, upstream_inflow_m3s: 1100, lake_level_m: 1.05 }),
        makePhase({
          name: 'คันคลองแตก',
          duration_hours: 10,
          rain_mm_hr: 25,
          rain_pattern: 'storm_cells',
          storm_cells: 6,
          upstream_inflow_m3s: 1900,
          lake_level_m: 1.15,
          color: '#db2777',
          events: [
            { type: 'surge', at_hours: 2, duration_hours: 7, magnitude: 260, x: Math.round(breach.x), y: Math.round(breach.y), label: 'ตลิ่งคลองอู่ตะเภาฝั่งหาดใหญ่ใน' },
            { type: 'drain_block', at_hours: 0, duration_hours: 10, magnitude: 0.7, label: 'ท่อระบายน้ำอุดตัน' },
          ],
        }),
        makePhase({ name: 'น้ำทรงตัว', duration_hours: 12, rain_mm_hr: 4, upstream_inflow_m3s: 1300, lake_level_m: 1.15 }),
        makePhase({ name: 'น้ำลด', duration_hours: 24, rain_mm_hr: 0, upstream_inflow_m3s: 250, lake_level_m: 1.0, color: '#10b981' }),
      ],
    },
  ];
}
