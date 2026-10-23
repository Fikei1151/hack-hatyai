const dtf = new Intl.DateTimeFormat('th-TH', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Asia/Bangkok',
});
const shortDtf = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });

export const thaiDateTime = (d: Date) => dtf.format(d);
export const thaiShort = (d: Date) => shortDtf.format(d);

export const num = (v: number, digits = 0) =>
  Number.isFinite(v) ? v.toLocaleString('th-TH', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '–';

export function simClock(startIso: string, simTime: number) {
  return new Date(Date.parse(startIso) + simTime * 1000);
}

export function hoursLabel(sec: number) {
  const h = sec / 3600;
  if (h < 48) return `${num(h, h < 10 ? 1 : 0)} ชม.`;
  return `${num(h / 24, 1)} วัน`;
}

export type Level = 'good' | 'warning' | 'serious' | 'critical';

export function depthLevel(d: number): Level {
  return d >= 1 ? 'critical' : d >= 0.5 ? 'serious' : d >= 0.1 ? 'warning' : 'good';
}

export const LEVEL_TEXT: Record<Level, string> = {
  good: 'ปกติ',
  warning: 'เฝ้าระวัง',
  serious: 'อันตราย',
  critical: 'วิกฤต',
};

export const LEVEL_COLOR: Record<Level, string> = {
  good: 'var(--color-good)',
  warning: 'var(--color-warning)',
  serious: 'var(--color-serious)',
  critical: 'var(--color-critical)',
};

/** Status colours deep enough to read as text on the light panels (icons keep LEVEL_COLOR). */
export const LEVEL_INK: Record<Level, string> = {
  good: 'var(--color-good-ink)',
  warning: 'var(--color-warning-ink)',
  serious: 'var(--color-serious-ink)',
  critical: 'var(--color-critical-ink)',
};

/** Water depth told the way people say it: up to the ankle, knee, waist… */
export function bodyLevel(d: number): { emoji: string; text: string } {
  if (d < 0.05) return { emoji: '✅', text: 'แห้ง' };
  if (d < 0.2) return { emoji: '🦶', text: 'ตาตุ่ม' };
  if (d < 0.5) return { emoji: '🦵', text: 'หัวเข่า' };
  if (d < 0.9) return { emoji: '🧍', text: 'เอว' };
  if (d < 1.4) return { emoji: '🏊', text: 'หน้าอก' };
  if (d < 2.2) return { emoji: '🆘', text: 'มิดหัว' };
  return { emoji: '🏠', text: 'ถึงชั้น 2' };
}

/** Rain intensity (mm/hr) as a friendly weather icon and name. */
export function rainLook(mmHr: number): { emoji: string; text: string } {
  if (mmHr < 0.2) return { emoji: '⛅', text: 'ไม่มีฝน' };
  if (mmHr < 5) return { emoji: '🌦️', text: 'ฝนปรอย ๆ' };
  if (mmHr < 15) return { emoji: '🌧️', text: 'ฝนปานกลาง' };
  if (mmHr < 35) return { emoji: '⛈️', text: 'ฝนหนัก' };
  if (mmHr < 70) return { emoji: '🌊', text: 'ฝนหนักมาก' };
  return { emoji: '🌀', text: 'พายุฝนกระหน่ำ' };
}

/** A day's rain total (mm) in the Thai Meteorological Department's classes. */
export function rainDayLook(mm: number): { emoji: string; text: string } {
  if (mm < 1) return { emoji: '⛅', text: 'ไม่มีฝน' };
  if (mm < 10) return { emoji: '🌦️', text: 'ฝนเล็กน้อย' };
  if (mm < 35) return { emoji: '🌧️', text: 'ฝนปานกลาง' };
  if (mm < 90) return { emoji: '⛈️', text: 'ฝนหนัก' };
  return { emoji: '🌊', text: 'ฝนหนักมาก' };
}

/** One-line verdict on a run, from the number of flooded homes and the flooded area. */
export function floodVerdict(buildings: number, areaKm2: number): { emoji: string; text: string; level: Level } {
  if (buildings >= 5000 || areaKm2 >= 25) return { emoji: '😱', text: 'น้ำท่วมใหญ่ บ้านน้ำเข้าหลายพันหลัง', level: 'critical' };
  if (buildings >= 500 || areaKm2 >= 6) return { emoji: '😟', text: 'น้ำเข้าบ้านหลายชุมชน', level: 'serious' };
  if (buildings >= 20 || areaKm2 >= 1) return { emoji: '🤔', text: 'ถนนและบ้านในที่ลุ่มมีน้ำขังบางจุด', level: 'warning' };
  return { emoji: '😊', text: 'เมืองรับไหว มีน้ำขังแค่แอ่งเล็ก ๆ', level: 'good' };
}
