import { useMemo, useState } from 'react';
import { compareRain, DRAIN_CAPACITY, PATTERNS, RIVER_STATES, type RainLabOptions, type RiverState } from '../sim/rainlab';
import { useApp } from '../store';
import { bodyLevel, floodVerdict, LEVEL_INK, num, rainLook } from './format';

const HOURS = [1, 2, 3, 6, 12];
const QUICK = [
  { v: 10, label: 'ฝนปรอย ๆ' },
  { v: 30, label: 'ฝนหนัก' },
  { v: 45, label: 'หนักสุดปี 68' },
  { v: 80, label: 'พายุ' },
];
const DEFAULTS: RainLabOptions = { intensity: 45, hours: 3, pattern: 'uniform', river: 'normal', drainsBlocked: false };

export function RainLabPanel() {
  const scenario = useApp((s) => s.scenario);
  const events = useApp((s) => s.events);
  const playing = useApp((s) => s.playing);
  const finished = useApp((s) => s.finished);
  const peaks = useApp((s) => s.peaks);
  const simTime = useApp((s) => s.stats?.simTime ?? 0);
  const history = useApp((s) => s.labHistory);
  const ready = useApp((s) => s.engineReady);
  const lab = scenario.settings.rain_lab;
  const [o, setO] = useState<RainLabOptions>(() => (lab ? { ...DEFAULTS, ...(lab as Partial<RainLabOptions>) } : DEFAULTS));
  const set = (p: Partial<RainLabOptions>) => setO((v) => ({ ...v, ...p }));

  const look = rainLook(o.intensity);
  const total = o.intensity * o.hours;
  const drains = o.drainsBlocked ? 10 : DRAIN_CAPACITY;
  // the wettest 24 hours of the Nov 2025 flood, from the same rain record the 2025 replay uses
  const wettestDay = useMemo(() => {
    const r = events.find((e) => e.id === '2025-11')?.rainMmHr;
    if (!r) return 0;
    let best = 0;
    for (let i = 0; i + 24 <= r.length; i++) best = Math.max(best, r.slice(i, i + 24).reduce((s, v) => s + v, 0));
    return best;
  }, [events]);
  const running = Boolean(lab) && (playing || (simTime > 0 && !finished));
  const v = floodVerdict(peaks.buildings, peaks.area);

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="font-cute text-[17px] font-bold">🌧️ ห้องทดลองฝน</h2>
        <p className="text-[12.5px] leading-relaxed text-ink-2">ถ้าฝนตกใส่หาดใหญ่ชั่วโมงละเท่านี้ น้ำจะท่วมตรงไหน? เลือกแล้วกดให้ฝนตกได้เลย</p>
      </div>

      <div className="flex items-center gap-2 rounded-2xl border border-line bg-gradient-to-b from-[#e6f1fd] to-white p-2">
        <RainCloud intensity={o.intensity} drains={drains} />
        <div className="min-w-0">
          <div className="font-cute text-[30px] leading-none font-bold tabular">
            {o.intensity}
            <span className="ml-1 text-[13px] font-semibold text-ink-2">มม./ชม.</span>
          </div>
          <div className="mt-1 text-[13px] font-semibold">
            {look.emoji} {look.text}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="lab-intensity" className="text-[12px] font-semibold text-ink-2">
          ฝนตกชั่วโมงละ (มม./ชม.)
        </label>
        <input id="lab-intensity" type="range" min={5} max={150} step={5} value={o.intensity} onChange={(e) => set({ intensity: Number(e.target.value) })} className="w-full accent-[#2a78d6]" />
        <div className="flex flex-wrap gap-1.5">
          {QUICK.map((q) => (
            <button key={q.v} type="button" className="chip" aria-pressed={o.intensity === q.v} onClick={() => set({ intensity: q.v })}>
              {rainLook(q.v).emoji} {q.label} <span className="tabular text-ink-3">{q.v}</span>
            </button>
          ))}
        </div>
        <p className="text-[12px] leading-relaxed text-ink-2">{compareRain(o.intensity)}</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="text-[12px] font-semibold text-ink-2">ตกนานกี่ชั่วโมง</div>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="ระยะเวลาฝนตก">
          {HOURS.map((h) => (
            <button key={h} type="button" role="radio" className="chip tabular" aria-checked={o.hours === h} onClick={() => set({ hours: h })}>
              {h} ชม.
            </button>
          ))}
        </div>
        <p className="text-[12px] leading-relaxed text-ink-2">
          รวมฝน <b className="tabular text-ink">{num(total)} มม.</b>
          {wettestDay > 0 &&
            (total >= wettestDay
              ? ` — มากกว่าฝน 24 ชม. ที่หนักที่สุดช่วงน้ำท่วมใหญ่ปี 68 (${num(wettestDay)} มม.)`
              : ` — ${num((total / wettestDay) * 100)}% ของฝน 24 ชม. ที่หนักที่สุดช่วงน้ำท่วมใหญ่ปี 68 (${num(wettestDay)} มม.)`)}
        </p>
      </div>

      <DrainGauge intensity={o.intensity} drains={drains} blocked={o.drainsBlocked} />

      <div className="flex flex-col gap-1.5">
        <div className="text-[12px] font-semibold text-ink-2">น้ำในคลองตอนฝนเริ่มตก</div>
        <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="สภาพน้ำในคลอง">
          {(Object.keys(RIVER_STATES) as RiverState[]).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={o.river === k}
              onClick={() => set({ river: k })}
              className={`flex flex-col items-center rounded-xl border-[1.5px] px-1 py-1.5 text-[11.5px] font-semibold ${o.river === k ? 'border-[#7fb2ef] bg-accent-soft text-[#1d4f8f]' : 'border-[#dde4ee] bg-white text-ink-2 hover:border-[#b9d3f3]'}`}
            >
              <span className="text-[20px] leading-tight">{RIVER_STATES[k].emoji}</span>
              {RIVER_STATES[k].label}
            </button>
          ))}
        </div>
        <p className="text-[11.5px] leading-relaxed text-ink-3">{RIVER_STATES[o.river].hint}</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="text-[12px] font-semibold text-ink-2">ฝนตกแบบไหน</div>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="รูปแบบฝน">
          {(Object.keys(PATTERNS) as RainLabOptions['pattern'][]).map((k) => (
            <button key={k} type="button" role="radio" className="chip" aria-checked={o.pattern === k} onClick={() => set({ pattern: k })}>
              {PATTERNS[k].emoji} {PATTERNS[k].label}
            </button>
          ))}
        </div>
        <label className="mt-1 flex cursor-pointer items-center gap-2 text-[12.5px] text-ink-2">
          <input type="checkbox" checked={o.drainsBlocked} onChange={(e) => set({ drainsBlocked: e.target.checked })} className="h-4 w-4 accent-[#2a78d6]" />
          🍂 ท่อระบายน้ำอุดตัน (ขยะ ใบไม้) เหลือรับได้ ~10 มม./ชม.
        </label>
      </div>

      <button type="button" className="btn btn-primary h-12 justify-center rounded-2xl text-[15px] font-cute font-bold" disabled={!ready} onClick={() => useApp.getState().runRainLab(o)}>
        {running ? '🔁 เริ่มตกใหม่ด้วยค่านี้' : '🌧️ ให้ฝนตกเลย!'}
      </button>

      {lab && (running || finished) && (
        <div className="rounded-2xl border border-line bg-white p-3" aria-live="polite">
          <div className="flex items-center justify-between gap-2">
            <div className="font-cute text-[14px] font-bold">{finished ? '📋 ผลการทดลอง' : '⏳ ฝนกำลังตก…'}</div>
            <div className="text-[11px] text-ink-3">
              {lab.intensity} มม./ชม. × {lab.hours} ชม.
            </div>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <span className="text-[30px] leading-none">{v.emoji}</span>
            <span className="text-[13.5px] font-semibold" style={{ color: LEVEL_INK[v.level] }}>
              {v.text}
            </span>
          </div>
          <div className="mt-2 grid grid-cols-3 gap-1.5">
            <Mini emoji="🗺️" label="พื้นที่น้ำท่วม" value={num(peaks.area, 1)} unit="ตร.กม." />
            <Mini emoji="🏠" label="บ้านน้ำเข้า" value={num(peaks.buildings)} unit="หลัง" />
            <Mini emoji={bodyLevel(peaks.depth).emoji} label="ลึกสุด" value={num(peaks.depth, 1)} unit="ม." />
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-3">
            ค่าสูงสุดตลอดการทดลอง · จุดลึกสุดน้ำถึง{bodyLevel(peaks.depth).text}
            {lab.river !== 'normal' && ' · รวมน้ำที่ล้นจากคลอง'}
          </p>
        </div>
      )}

      {history.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-[12px] font-semibold text-ink-2">🧾 การทดลองที่ผ่านมา (กดเพื่อใช้ค่านั้น)</div>
          <ul className="flex flex-col gap-1">
            {history.map((h) => {
              const hv = floodVerdict(h.buildings, h.areaKm2);
              return (
                <li key={h.id}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-xl bg-card px-2.5 py-1.5 text-left text-[12px] hover:bg-hover"
                    onClick={() => setO({ intensity: h.intensity, hours: h.hours, pattern: h.pattern as RainLabOptions['pattern'], river: h.river as RiverState, drainsBlocked: h.drainsBlocked })}
                  >
                    <span className="text-[18px]">{hv.emoji}</span>
                    <span className="min-w-0 flex-1">
                      <span className="font-semibold">
                        {h.intensity} มม./ชม. × {h.hours} ชม.
                      </span>
                      <span className="text-ink-3">
                        {' '}
                        · {RIVER_STATES[h.river as RiverState]?.label ?? h.river}
                        {h.drainsBlocked ? ' · ท่ออุดตัน' : ''}
                      </span>
                      <span className="block tabular text-ink-2">
                        ท่วม {num(h.areaKm2, 1)} ตร.กม. · บ้าน {num(h.buildings)} หลัง · ลึกสุด {num(h.maxDepth, 1)} ม.
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function Mini({ emoji, label, value, unit }: { emoji: string; label: string; value: string; unit: string }) {
  return (
    <div className="rounded-xl bg-card px-2 py-1.5">
      <div className="truncate text-[10.5px] text-ink-3">
        {emoji} {label}
      </div>
      <div className="font-cute text-[16px] leading-tight font-bold tabular">
        {value} <span className="text-[10.5px] font-semibold text-ink-3">{unit}</span>
      </div>
    </div>
  );
}

/** How much of the rain the storm drains swallow, and how much is left over to pond on the streets. */
function DrainGauge({ intensity, drains, blocked }: { intensity: number; drains: number; blocked: boolean }) {
  const max = Math.max(60, intensity * 1.08, drains * 1.6);
  const pct = (x: number) => `${(x / max) * 100}%`;
  const excess = Math.max(0, intensity - drains);
  return (
    <div className="rounded-2xl border border-line bg-white p-2.5">
      <div className="mb-1.5 text-[12px] font-semibold text-ink-2">🚰 ท่อระบายน้ำรับไหวไหม?</div>
      <div className="relative h-4" role="img" aria-label={`ฝน ${intensity} มม./ชม. ท่อรับได้ ${drains} มม./ชม. ${excess ? `เกิน ${excess} มม./ชม.` : 'รับไหว'}`}>
        <div className="absolute inset-0 rounded-full bg-slate-200/80" />
        <div className="absolute inset-y-0 left-0 rounded-l-full bg-accent" style={{ width: pct(Math.min(intensity, drains)), borderTopRightRadius: excess ? 0 : 4, borderBottomRightRadius: excess ? 0 : 4 }} />
        {excess > 0 && <div className="absolute inset-y-0 rounded-r-[4px] bg-accent-2" style={{ left: `calc(${pct(drains)} + 2px)`, width: `calc(${pct(excess)} - 2px)` }} />}
        <div className="absolute -top-1 -bottom-1 w-[2px] rounded bg-ink" style={{ left: pct(drains) }} />
      </div>
      <div className="mt-1 flex justify-between gap-2 text-[11px] leading-snug">
        <span className="text-ink-2">
          <span className="mr-1 inline-block h-2 w-2 rounded-full bg-accent align-middle" />
          ท่อรับได้ ~{drains} มม./ชม.{blocked ? ' (อุดตัน)' : ''}
        </span>
        {excess > 0 ? (
          <span className="text-right text-ink-2">
            <span className="mr-1 inline-block h-2 w-2 rounded-full bg-accent-2 align-middle" />
            เกิน {excess} มม./ชม. → ขังบนถนน
          </span>
        ) : (
          <span className="text-good-ink">✅ ท่อรับไหว</span>
        )}
      </div>
    </div>
  );
}

/** A little cloud whose mood and downpour follow the rain intensity. */
function RainCloud({ intensity, drains }: { intensity: number; drains: number }) {
  const drops = Math.round(Math.min(24, 3 + intensity / 5));
  const dur = Math.max(0.42, 1.05 - intensity / 160);
  const storm = intensity >= 60;
  const fill = storm ? '#9aa8bc' : intensity >= 35 ? '#c6d2e0' : '#ffffff';
  const puddle = Math.min(46, Math.max(0, intensity - drains) * 0.9);
  return (
    <svg width="132" height="118" viewBox="0 0 132 118" aria-hidden="true" className="flex-none">
      {Array.from({ length: drops }, (_, i) => {
        const x = 22 + ((i * 41) % 88);
        return (
          <line
            key={i}
            className="raindrop"
            x1={x}
            x2={x - 3}
            y1={54}
            y2={64}
            stroke="#4b9be8"
            strokeWidth="2.4"
            strokeLinecap="round"
            style={{ animationDuration: `${dur}s`, animationDelay: `-${((i * 0.37) % 1) * dur}s` }}
          />
        );
      })}
      {storm && <path className="flash" d="M74 52 l-11 20 h9 l-6 17 l17 -24 h-9 l7 -13 z" fill="#ffd34d" stroke="#e8a900" strokeWidth="1" strokeLinejoin="round" />}
      <ellipse cx="66" cy="112" rx={8 + puddle} ry={puddle ? 4 : 2} fill={puddle ? '#7fb8f0' : '#cfe3c4'} opacity="0.8" />
      <g className="bob">
        <g fill={storm ? '#7d8ba0' : '#cfdced'} stroke={storm ? '#7d8ba0' : '#cfdced'} strokeWidth="4">
          <CloudShape />
        </g>
        <g fill={fill}>
          <CloudShape />
        </g>
        <circle cx="58" cy="38" r="2.4" fill="#2d3436" />
        <circle cx="80" cy="38" r="2.4" fill="#2d3436" />
        <circle cx="52" cy="44" r="3" fill="#ff9aa2" opacity="0.6" />
        <circle cx="86" cy="44" r="3" fill="#ff9aa2" opacity="0.6" />
        {intensity < 20 ? (
          <path d="M64 43 Q69 48 74 43" stroke="#2d3436" strokeWidth="1.8" fill="none" strokeLinecap="round" />
        ) : storm ? (
          <path d="M63 47 Q69 42 75 47" stroke="#2d3436" strokeWidth="1.8" fill="none" strokeLinecap="round" />
        ) : (
          <ellipse cx="69" cy="45.5" rx="2.6" ry="2.2" fill="#2d3436" />
        )}
        {storm && (
          <>
            <path d="M53 32 l8 3" stroke="#2d3436" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M85 32 l-8 3" stroke="#2d3436" strokeWidth="1.8" strokeLinecap="round" />
          </>
        )}
      </g>
    </svg>
  );
}

const CloudShape = () => (
  <>
    <circle cx="44" cy="36" r="17" />
    <circle cx="70" cy="27" r="22" />
    <circle cx="94" cy="38" r="15" />
    <rect x="27" y="34" width="82" height="20" rx="10" />
  </>
);
