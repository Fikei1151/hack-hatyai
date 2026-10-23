import { useEffect, useState } from 'react';
import { RISK, THRESHOLDS, thaiDay, type DayOutlook, type Outlook } from '../sim/forecast';
import { useApp } from '../store';
import { LEVEL_COLOR, LEVEL_INK, num, rainDayLook } from './format';
import { StatusIcon } from './StatsPanel';

const todayBkk = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const pct = (p: number) => `${Math.round(p * 100)}%`;

function dayTag(date: string) {
  const t = todayBkk();
  if (date === t) return 'วันนี้';
  const tomorrow = new Date(Date.parse(`${t}T12:00:00Z`) + 86400_000).toISOString().slice(0, 10);
  return date === tomorrow ? 'พรุ่งนี้' : '';
}

export function ForecastPanel() {
  const outlook = useApp((s) => s.outlook);
  const loading = useApp((s) => s.outlookLoading);
  const error = useApp((s) => s.outlookError);
  const ready = useApp((s) => s.engineReady);
  const active = useApp((s) => s.scenario.settings.forecast);

  useEffect(() => {
    const st = useApp.getState();
    if (!st.outlook && !st.outlookLoading) void st.loadOutlook();
  }, []);

  const a = useApp.getState();
  const worst = outlook?.days.reduce<DayOutlook | null>((w, d) => (!w || d.pFlood > w.pFlood ? d : w), null);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="font-cute text-[17px] font-bold">📅 พยากรณ์ & โอกาสน้ำท่วม</h2>
          <p className="text-[12.5px] leading-relaxed text-ink-2">10 วันข้างหน้า จากพยากรณ์อากาศหลายสิบชุด แล้วกดจำลองดูทีละวันได้</p>
        </div>
        <button type="button" className="btn btn-ghost flex-none px-2 py-1 text-[12px]" disabled={loading} onClick={() => void a.loadOutlook(true)} title="ดึงพยากรณ์ล่าสุด">
          <span className={loading ? 'spin' : ''}>🔄</span>
        </button>
      </div>

      {loading && !outlook && (
        <div className="flex flex-col items-center gap-2 rounded-2xl bg-card p-5 text-center text-[12.5px] text-ink-2">
          <span className="bob text-[34px]">🛰️</span>
          กำลังถามพยากรณ์อากาศ 82 ชุด และแบบจำลองแม่น้ำ GloFAS…
        </div>
      )}
      {error && (
        <div className="rounded-xl border border-critical/40 bg-critical/10 p-2.5 text-[12.5px] text-critical-ink">
          ดึงพยากรณ์ไม่สำเร็จ: {error}
          <button type="button" className="btn ml-2 px-2 py-0.5 text-[12px]" onClick={() => void a.loadOutlook(true)}>
            ลองใหม่
          </button>
        </div>
      )}

      {outlook && worst && (
        <>
          <Headline worst={worst} />
          <ChanceChart outlook={outlook} />
          <ul className="flex flex-col gap-1.5">
            {outlook.days.map((d, i) => (
              <DayCard
                key={d.date}
                d={d}
                active={active?.day === d.date ? active.variant : null}
                disabled={!ready}
                onMean={() => a.simulateDay(i, 'mean')}
                onWet={() => a.simulateDay(i, 'p90')}
              />
            ))}
          </ul>
          <button type="button" className="btn btn-primary h-11 justify-center rounded-2xl font-cute text-[14px] font-bold" disabled={!ready} onClick={() => a.simulateOutlook()}>
            ▶ จำลองต่อเนื่องทั้ง {outlook.days.length} วัน
          </button>
          <p className="-mt-1 text-center text-[11.5px] text-ink-3">ระหว่างจำลอง กด ⏩ ข้ามไปวันถัดไป ที่แถบเวลา แล้วกดชิปวันที่เพื่อย้อนดูน้ำทีละวัน</p>
          <Method outlook={outlook} />
        </>
      )}
    </div>
  );
}

function Headline({ worst }: { worst: DayOutlook }) {
  const r = RISK[worst.level];
  const text =
    worst.level === 'low'
      ? '10 วันข้างหน้าโอกาสน้ำท่วมต่ำ สบายใจได้'
      : `${dayTag(worst.date) || thaiDay(worst.date)} มีโอกาสน้ำท่วม ${pct(worst.pFlood)} — ${worst.level === 'watch' ? 'เฝ้าระวังไว้' : 'เตรียมพร้อมรับมือ'}`;
  return (
    <div className="flex items-center gap-2.5 rounded-2xl border-[1.5px] bg-white p-2.5" style={{ borderColor: LEVEL_COLOR[r.status] }}>
      <span className="text-[30px] leading-none">{r.emoji}</span>
      <span className="text-[13px] font-semibold leading-snug" style={{ color: LEVEL_INK[r.status] }}>
        {text}
      </span>
    </div>
  );
}

/** Flood chance per day: one bar per day in its risk colour, with the risk emoji under it. */
function ChanceChart({ outlook }: { outlook: Outlook }) {
  const [hover, setHover] = useState<number | null>(null);
  const days = outlook.days;
  const H = 96;
  const h = hover !== null ? days[hover] : null;
  return (
    <div className="rounded-2xl border border-line bg-white p-2.5">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[12px] font-semibold text-ink-2">โอกาสน้ำท่วมรายวัน</span>
        <span className="text-[10.5px] text-ink-3">ชี้แท่งเพื่อดูรายละเอียด</span>
      </div>
      <div className="relative flex gap-1.5 pl-7">
        <div className="pointer-events-none absolute inset-y-0 left-0 right-0" style={{ height: H }}>
          {[1, 0.5, 0].map((g) => (
            <div key={g} className="absolute left-0 right-0 flex items-center" style={{ top: (1 - g) * H - 6 }}>
              <span className="w-7 pr-1 text-right text-[9.5px] text-ink-3 tabular">{g * 100}%</span>
              <div className="h-px flex-1 bg-grid" />
            </div>
          ))}
        </div>
        {days.map((d, i) => {
          const r = RISK[d.level];
          const bh = Math.max(3, d.pFlood * H);
          return (
            <button
              key={d.date}
              type="button"
              className="relative flex min-w-0 flex-1 flex-col items-center rounded-md hover:bg-hover"
              onPointerEnter={() => setHover(i)}
              onPointerLeave={() => setHover(null)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              aria-label={`${thaiDay(d.date)} โอกาสน้ำท่วม ${pct(d.pFlood)} ระดับ${r.label}`}
            >
              <div className="relative w-full" style={{ height: H }}>
                {d.pFlood >= 0.1 && (
                  <span className="absolute left-1/2 -translate-x-1/2 text-[9.5px] font-semibold text-ink-2 tabular" style={{ bottom: bh + 1 }}>
                    {Math.round(d.pFlood * 100)}
                  </span>
                )}
                <div className="absolute bottom-0 left-1/2 w-[62%] max-w-[18px] -translate-x-1/2 rounded-t-[4px]" style={{ height: bh, background: LEVEL_COLOR[r.status] }} />
              </div>
              <span className="mt-0.5 text-[13px] leading-none">{r.emoji}</span>
              <span className="text-[9.5px] leading-tight text-ink-3 tabular">{Number(d.date.slice(8))}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-1.5 min-h-[34px] rounded-lg bg-card px-2 py-1 text-[11px] leading-snug text-ink-2">
        {h ? (
          <>
            <b className="text-ink">{thaiDay(h.date)}</b> · โอกาสท่วม <b className="text-ink">{pct(h.pFlood)}</b> (จากฝน {pct(h.pPluvial)}
            {h.pRiver !== null ? ` · จากแม่น้ำ ${pct(h.pRiver)}` : ''}) · ฝน ~{num(h.rainMean)} มม. (อาจ {num(h.rainP10)}–{num(h.rainP90)}) · หนักสุด ~{num(h.maxHourlyMean, 1)} มม./ชม.
          </>
        ) : (
          <span className="flex flex-wrap gap-x-2.5 gap-y-0.5">
            {(['low', 'watch', 'high', 'severe'] as const).map((k) => (
              <span key={k} className="inline-flex items-center gap-1" style={{ color: LEVEL_INK[RISK[k].status] }}>
                <StatusIcon level={RISK[k].status} /> {RISK[k].emoji} {RISK[k].label} {k === 'low' ? '<10%' : k === 'watch' ? '10–30%' : k === 'high' ? '30–60%' : '≥60%'}
              </span>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}

function DayCard({ d, active, disabled, onMean, onWet }: { d: DayOutlook; active: 'mean' | 'p90' | null; disabled: boolean; onMean: () => void; onWet: () => void }) {
  const r = RISK[d.level];
  const look = rainDayLook(d.rainMean);
  const tag = dayTag(d.date);
  return (
    <li className={`rounded-2xl border p-2.5 ${active ? 'border-[#7fb2ef] bg-accent-soft/60' : 'border-line bg-white'}`}>
      <div className="flex items-start gap-2">
        <span className="text-[26px] leading-none" title={look.text}>
          {look.emoji}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="font-cute text-[14px] font-bold">{thaiDay(d.date)}</span>
            {tag && <span className="rounded-full bg-accent-soft px-1.5 text-[10.5px] font-semibold text-[#1d4f8f]">{tag}</span>}
          </div>
          <div className="text-[11.5px] leading-snug text-ink-2">
            {look.text} ~{num(d.rainMean)} มม. <span className="text-ink-3">(อาจ {num(d.rainP10)}–{num(d.rainP90)})</span>
          </div>
          <div className="text-[11.5px] leading-snug text-ink-2">{d.riverMedian !== null ? `🌊 น้ำเหนือ ~${num(d.riverMedian)} ม³/วิ` : '🌊 ไม่มีข้อมูลน้ำเหนือ'}</div>
        </div>
        <div className="flex flex-none flex-col items-end">
          <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-bold" style={{ color: LEVEL_INK[r.status], background: `color-mix(in srgb, ${LEVEL_COLOR[r.status]} 16%, white)` }}>
            <StatusIcon level={r.status} /> {pct(d.pFlood)}
          </span>
          <span className="mt-0.5 text-[10.5px] text-ink-3">
            {r.emoji} โอกาสท่วม{r.label}
          </span>
        </div>
      </div>
      <div className="mt-2 flex gap-1.5">
        <button type="button" className="btn flex-1 justify-center py-1 text-[12px]" disabled={disabled} onClick={onMean} aria-pressed={active === 'mean'}>
          ▶ จำลองวันนี้
        </button>
        <button type="button" className="btn flex-1 justify-center py-1 text-[12px]" disabled={disabled} onClick={onWet} aria-pressed={active === 'p90'} title="ใช้ชุดพยากรณ์ที่ฝนหนักระดับ 1 ใน 10">
          ⛈️ กรณีฝนหนัก
        </button>
      </div>
    </li>
  );
}

function Method({ outlook }: { outlook: Outlook }) {
  const fetched = new Date(outlook.fetchedAt).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' });
  return (
    <details className="rounded-2xl bg-card p-2.5 text-[11.5px] leading-relaxed text-ink-2">
      <summary className="cursor-pointer font-semibold text-ink">🤓 โอกาสน้ำท่วมคิดอย่างไร?</summary>
      <ul className="mt-1.5 list-disc space-y-1 pl-4">
        <li>ใช้พยากรณ์ฝนรายชั่วโมง {outlook.rainMembers.length} ชุด (ECMWF + NCEP GEFS) แต่ละชุดคือ "อนาคตที่เป็นไปได้" แบบหนึ่ง</li>
        <li>
          นับเป็นน้ำท่วมจากฝน ถ้าฝนชั่วโมงใดเกิน {THRESHOLDS.pluvialHourly} มม. หรือทั้งวันเกิน {THRESHOLDS.pluvialDaily} มม. (ท่อระบายน้ำรับได้ ~30 มม./ชม.)
        </li>
        <li>นับเป็นน้ำท่วมจากแม่น้ำ ถ้าน้ำเหนือ (GloFAS) เกิน {num(THRESHOLDS.riverCity)} ม³/วิ ซึ่งเป็นระดับที่น้ำเริ่มล้นเข้าเมืองในแบบจำลองปี 68</li>
        <li>โอกาสรวม = 1 − (1 − โอกาสจากฝน) × (1 − โอกาสจากแม่น้ำ)</li>
        <li>"กรณีฝนหนัก" = ชุดพยากรณ์ที่ฝนทั้งวันอยู่ที่เปอร์เซ็นไทล์ 90 (หนักกว่าชุดอื่น 9 ใน 10)</li>
      </ul>
      <div className="mt-1.5 text-ink-3">
        {outlook.sources.join(' · ')} · ดึงเมื่อ {fetched}
      </div>
      <div className="mt-1 font-semibold text-warning-ink">⚠️ เป็นการประมาณเพื่อการเรียนรู้ ไม่ใช่ประกาศเตือนภัยทางการ — ติดตามกรมอุตุนิยมวิทยาและ ปภ.</div>
    </details>
  );
}
