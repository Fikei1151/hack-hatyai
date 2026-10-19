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
