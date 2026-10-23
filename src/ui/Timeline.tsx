import { useRef, useState } from 'react';
import { HOUR, phaseStarts, totalHours } from '../sim/scenario';
import { getEngine, SPEEDS, useApp } from '../store';
import { floodVerdict, hoursLabel, num, simClock, thaiShort } from './format';
import { IconGlobe, IconPause, IconPlay, IconReset } from './icons';

export function Timeline() {
  const scenario = useApp((s) => s.scenario);
  const playing = useApp((s) => s.playing);
  const finished = useApp((s) => s.finished);
  const speed = useApp((s) => s.speed);
  const simTime = useApp((s) => s.stats?.simTime ?? 0);
  const selected = useApp((s) => s.selectedPhase);
  const days = useApp((s) => s.days);
  const viewingDay = useApp((s) => s.viewingDay);
  const ffActive = useApp((s) => s.ffActive);
  const a = useApp.getState();
  const track = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);

  const total = totalHours(scenario) * HOUR;
  const starts = phaseStarts(scenario);
  const hoverPhase = hover ? starts.findLastIndex((s) => s <= hover.t) : -1;
  const multiDay = total > 20 * HOUR;

  return (
    <div className="glass pointer-events-auto flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl px-3 py-2.5">
      <button
        type="button"
        className="btn btn-primary h-10 w-10 flex-none rounded-full p-0"
        onClick={() => (playing ? a.pause() : a.play())}
        aria-label={playing ? 'หยุดชั่วคราว' : finished ? 'เริ่มใหม่' : 'เริ่มจำลอง'}
        title={playing ? 'หยุดชั่วคราว (Space)' : 'เริ่มจำลอง (Space)'}
      >
        {playing ? <IconPause size={18} /> : <IconPlay size={18} />}
      </button>
      <button type="button" className="btn h-9 w-9 flex-none rounded-full p-0" onClick={() => a.resetSim()} aria-label="รีเซ็ตกลับจุดเริ่มต้น" title="รีเซ็ต">
        <IconReset />
      </button>
      {multiDay && (
        <button
          type="button"
          className="btn h-9 flex-none rounded-full px-3 text-[12.5px] font-semibold"
          onClick={() => a.nextDay()}
          disabled={finished || ffActive || simTime >= total - 1}
          title="จำลองเร็วที่สุดไปจนถึงเที่ยงคืน แล้วหยุดให้ดู"
        >
          {ffActive ? <span className="spin">⏳</span> : '⏩'} {ffActive ? 'กำลังเร่ง…' : 'วันถัดไป'}
        </button>
      )}
      <div className="flex flex-none flex-col gap-0.5">
        <span className="text-[10px] text-ink-3">ความเร็วจำลอง</span>
        <div className="flex rounded-lg border border-line bg-card p-0.5" role="radiogroup" aria-label="ความเร็วการจำลอง">
          {SPEEDS.map((sp) => (
            <button
              key={sp.value}
              type="button"
              role="radio"
              aria-checked={speed === sp.value}
              title={sp.hint}
              onClick={() => a.setSpeed(sp.value)}
              className={`min-w-[38px] rounded-md px-2 py-1 text-[12.5px] font-semibold tabular ${speed === sp.value ? 'bg-accent text-white' : 'text-ink-2 hover:bg-hover'}`}
            >
              {sp.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex min-w-[260px] flex-1 flex-col gap-1 max-md:order-last max-md:basis-full">
        <div className="flex items-baseline justify-between text-[11px] text-ink-3">
          <span className="tabular">{thaiShort(simClock(scenario.start_time, 0))}</span>
          <span className="tabular text-ink-2">
            ผ่านไป {hoursLabel(simTime)} / {hoursLabel(total)}
          </span>
          <span className="tabular">{thaiShort(simClock(scenario.start_time, total))}</span>
        </div>
        <div
          ref={track}
          className="relative h-7 cursor-pointer"
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const x = e.clientX - r.left;
            setHover({ x, t: (x / r.width) * total });
          }}
          onPointerLeave={() => setHover(null)}
          onClick={() => {
            if (hoverPhase >= 0) {
              a.setPanel('scenario');
              a.selectPhase(hoverPhase);
            }
          }}
          role="list"
          aria-label="เฟสของเหตุการณ์"
        >
          <div className="absolute inset-0 flex gap-[2px] overflow-hidden rounded-lg">
            {scenario.phases.map((p, i) => {
              const w = (p.duration_hours * HOUR) / total;
              return (
                <div
                  key={p.id}
                  role="listitem"
                  className={`relative h-full min-w-[3px] overflow-hidden ${selected === i ? 'ring-2 ring-white/80 ring-inset' : ''}`}
                  style={{ flexGrow: w, flexBasis: 0, background: p.color, opacity: starts[i] + p.duration_hours * HOUR <= simTime ? 0.55 : 0.92 }}
                  title={p.name}
                >
                  {w > 0.07 && <span className="absolute inset-0 truncate px-1.5 text-[11px] leading-7 font-medium text-[#0b1a2e]/85">{p.name}</span>}
                </div>
              );
            })}
          </div>
          <div className="pointer-events-none absolute -top-1 -bottom-1 w-[2px] rounded-full bg-white shadow-[0_0_0_2px_rgba(0,0,0,0.45)]" style={{ left: `${Math.min(100, (simTime / Math.max(total, 1)) * 100)}%` }} />
          {hover && hoverPhase >= 0 && (
            <div
              className="pointer-events-none absolute bottom-9 z-20 w-max max-w-[260px] rounded-lg border border-line bg-panel-solid px-2 py-1 text-[11.5px] shadow-lg"
              style={{ left: Math.max(0, Math.min(hover.x - 60, (track.current?.clientWidth ?? 300) - 200)) }}
            >
              <div className="font-medium text-ink">
                เฟส {hoverPhase + 1}: {scenario.phases[hoverPhase].name}
              </div>
              <div className="tabular text-ink-2">
                {thaiShort(simClock(scenario.start_time, hover.t))} · ฝน {scenario.phases[hoverPhase].rain_mm_hr} มม./ชม. · น้ำเข้า {scenario.phases[hoverPhase].upstream_inflow_m3s} ม³/วิ
              </div>
            </div>
          )}
        </div>
      </div>

      <button type="button" className="btn flex-none" onClick={() => getEngine()?.overview()} title="มุมมองภาพรวมทั้งเมือง">
        <IconGlobe /> ภาพรวม
      </button>

      {days.length > 0 && (
        <div className="scroll-thin flex basis-full items-center gap-1.5 overflow-x-auto pb-0.5" role="group" aria-label="ย้อนดูน้ำรายวัน">
          <span className="flex-none text-[11.5px] font-semibold text-ink-2">📸 ย้อนดูรายวัน</span>
          {days.map((d) => {
            const v = floodVerdict(d.buildings, d.floodedKm2);
            return (
              <button
                key={d.key}
                type="button"
                className="chip flex-none tabular"
                aria-pressed={viewingDay === d.key}
                onClick={() => a.viewDay(viewingDay === d.key ? null : d.key)}
                title={`${v.text} · บ้านน้ำเข้า ${num(d.buildings)} หลัง · ลึกสุด ${num(d.maxDepth, 1)} ม.`}
              >
                {v.emoji} {DAY_FMT.format(new Date(`${d.key}T12:00:00+07:00`))} · {num(d.floodedKm2, 1)} ตร.กม.
              </button>
            );
          })}
          {viewingDay && (
            <button type="button" className="chip flex-none" onClick={() => a.viewDay(null)}>
              ▶ กลับเวลาปัจจุบัน
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const DAY_FMT = new Intl.DateTimeFormat('th-TH', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Bangkok' });

/** Shown over the map while a recorded day is on screen instead of the live simulation. */
export function DayViewBanner() {
  const viewingDay = useApp((s) => s.viewingDay);
  const day = useApp((s) => s.days.find((d) => d.key === s.viewingDay));
  const start = useApp((s) => s.scenario.start_time);
  if (!viewingDay || !day) return null;
  const v = floodVerdict(day.buildings, day.floodedKm2);
  return (
    <div className="glass pointer-events-auto flex max-w-[min(560px,100%)] flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-2xl px-3.5 py-2 text-[12.5px]" role="status">
      <span className="font-cute text-[14px] font-bold">📸 ภาพน้ำ ณ {thaiShort(simClock(start, day.t))}</span>
      <span className="text-ink-2">
        {v.emoji} ท่วม {num(day.floodedKm2, 1)} ตร.กม. · บ้านน้ำเข้า {num(day.buildings)} หลัง · ลึกสุด {num(day.maxDepth, 1)} ม.
      </span>
      <button type="button" className="btn btn-primary px-2.5 py-1 text-[12px]" onClick={() => useApp.getState().viewDay(null)}>
        ▶ กลับไปเวลาปัจจุบัน
      </button>
    </div>
  );
}
