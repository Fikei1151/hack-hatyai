import type { ReactNode } from 'react';
import { num, rainLook } from '../../ui/format';
import { CALL_KINDS } from '../rules';
import { useGame } from '../store';
import { riverWord, roundClock, useGameState } from './shared';

function Overlay({ children, onClose }: { children: ReactNode; onClose?: () => void }) {
  return (
    <div className="pointer-events-auto absolute inset-0 z-30 grid place-items-center overflow-y-auto bg-[#0b2340]/30 p-3 backdrop-blur-[2px]" onClick={(e) => e.target === e.currentTarget && onClose?.()}>
      {children}
    </div>
  );
}

const TONE_BG = { bad: '#fff0ee', good: '#eaf8ea', info: '#f1f5fa' } as const;

export function EventModal() {
  const { state } = useGameState();
  const g = useGame.getState();
  if (!state || !state.card || !state.forecast) return null;
  const f = state.forecast;
  const c = state.card;
  const look = f.known ? rainLook(f.mid) : { emoji: '📵', text: 'ไม่มีสัญญาณ' };
  const river = riverWord(f.riverMid);
  const next = f.nextMid !== null ? rainLook(f.nextMid) : null;
  const nextRiver = f.nextRiver !== null ? riverWord(f.nextRiver) : null;
  const fresh = state.calls.filter((x) => x.calledRound === state.round);
  return (
    <Overlay>
      <div className="glass w-[min(780px,96vw)] rounded-3xl p-4 sm:p-5" role="dialog" aria-modal="true" aria-labelledby="ev-title">
        <div className="text-center text-[12px] text-ink-3">
          รอบ {state.round}/{state.cfg.rounds} · {roundClock(state)} – {roundClock(state, 1)}
        </div>
        <h2 id="ev-title" className="text-center font-cute text-[20px] font-bold">
          🃏 เฟส 1 · เหตุการณ์ประจำรอบ
        </h2>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div className="gm-pop rounded-2xl border border-line bg-gradient-to-b from-[#eef7ff] to-white p-3">
            <div className="text-[12px] font-semibold text-ink-3">📡 พยากรณ์รอบนี้</div>
            <div className="mt-1 flex items-center gap-3">
              <span className="text-[46px] leading-none">{look.emoji}</span>
              <div>
                {f.known ? (
                  <>
                    <div className="font-cute text-[18px] leading-tight font-bold">{look.text}</div>
                    <div className="tabular text-[13px] text-ink-2">
                      ~{num(f.mid)} มม./ชม. {f.exact ? '(แม่นยำจากวิทยุ)' : `(อาจ ${num(f.lo)}–${num(f.hi)})`}
                    </div>
                  </>
                ) : (
                  <div className="font-cute text-[16px] font-bold">ไฟดับ ไม่รู้พยากรณ์!</div>
                )}
              </div>
            </div>
            <div className="mt-2 text-[12.5px] leading-relaxed text-ink-2">
              🌊 น้ำเหนือ {river.emoji} {river.text} (~{num(f.riverMid)} ม³/วิ)
              {next && nextRiver && (
                <>
                  <br />
                  🔮 รอบหน้าอาจเป็น {next.emoji} {next.text} · น้ำเหนือ {nextRiver.text}
                </>
              )}
            </div>
            <p className="mt-1.5 text-[11px] leading-snug text-ink-3">พยากรณ์ไม่แม่นเสมอไป — ยิ่งระดับยากยิ่งคลาดเคลื่อนมาก</p>
          </div>

          <div className="gm-card-flip rounded-2xl border border-line p-3 text-center" style={{ background: TONE_BG[c.def.tone] }}>
            <div className="text-[12px] font-semibold text-ink-3">{c.def.tone === 'bad' ? '😬 ข่าวร้าย' : c.def.tone === 'good' ? '🍀 ข่าวดี' : '🙂 ข่าวทั่วไป'}</div>
            <div className="mt-1 text-[52px] leading-none">{c.def.emoji}</div>
            <div className="mt-1 font-cute text-[17px] leading-tight font-bold">{c.def.title}</div>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{c.def.text}</p>
            {c.notes.length > 0 && <p className="mt-1.5 text-[12.5px] font-semibold text-ink">{c.notes.join(' · ')}</p>}
          </div>
        </div>

        <div className="mt-3 rounded-2xl bg-card p-3">
          <div className="text-[12px] font-semibold text-ink-3">📞 สายขอความช่วยเหลือใหม่ {fresh.length} สาย</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {fresh.length === 0 && <span className="text-[12.5px] text-ink-2">ยังไม่มีสายใหม่ — ใช้เวลาจัดการสายที่ค้างอยู่</span>}
            {fresh.map((x) => (
              <span key={x.id} className="rounded-full bg-white px-2.5 py-1 text-[12px] font-semibold shadow-sm">
                {CALL_KINDS[x.kind].emoji} {x.name} · {x.people} คน{x.depth >= 0.1 ? ` · น้ำ ${x.depth.toFixed(1)} ม.` : ''}
              </span>
            ))}
          </div>
        </div>
        <div className="mt-4 flex justify-center">
          <button type="button" className="btn btn-primary h-12 rounded-2xl px-8 font-cute text-[16px] font-bold" onClick={g.beginActions} autoFocus>
            เริ่มวางแผน ▶
          </button>
        </div>
      </div>
    </Overlay>
  );
}

export function ResolveModal() {
  const { state } = useGameState();
  const rep = useGame((s) => s.resolve);
  const g = useGame.getState();
  if (!state || !rep) return null;
  const cur = state.history[state.history.length - 1];
  if (!cur) return null;
  const prev = state.history[state.history.length - 2];
  const pct = cur.roadKm ? (cur.roadKmBlocked / cur.roadKm) * 100 : 0;
  const prevPct = prev && prev.roadKm ? (prev.roadKmBlocked / prev.roadKm) * 100 : 0;
  const delta = (a: number, b: number, d = 0) => (a - b >= 0.05 ? ` ▲ +${(a - b).toFixed(d)}` : b - a >= 0.05 ? ` ▼ ${(a - b).toFixed(d)}` : '');
  const open = state.calls.filter((c) => c.status === 'waiting' || c.status === 'aboard').length;
  return (
    <Overlay>
      <div className="glass w-[min(700px,96vw)] rounded-3xl p-4 sm:p-5" role="dialog" aria-modal="true" aria-labelledby="rs-title">
        <h2 id="rs-title" className="text-center font-cute text-[20px] font-bold">
          🌊 น้ำมาแล้ว! สรุปรอบ {state.round}
        </h2>
        <p className="text-center text-[12px] text-ink-3">ผลจากแบบจำลองน้ำจริงตลอด {state.cfg.roundHours} ชั่วโมงที่ผ่านมา</p>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <Tile emoji="🗺️" label="น้ำท่วมทั้งเมือง" value={`${num(cur.floodedKm2, 1)}`} unit="ตร.กม." note={prev ? delta(cur.floodedKm2, prev.floodedKm2, 1) : ''} />
          <Tile emoji="🚧" label="ถนนย่านนี้ที่รถผ่านไม่ได้" value={`${num(pct)}`} unit="%" note={prev ? delta(pct, prevPct) : ''} bad={pct > 40} />
          <Tile emoji="📞" label="สายที่ยังค้าง" value={`${open}`} unit="สาย" note="" bad={open > 4} />
        </div>
        <div className="mt-3 flex flex-col gap-1.5 text-[13px]">
          {rep.newlyLost.map((c) => (
            <Line key={c.id} tone="bad" emoji="💔" text={`${c.name} (${c.people} คน) ติดค้างในน้ำลึก ${c.depth.toFixed(1)} ม. — ช่วยไม่ทัน`} />
          ))}
          {rep.worse.map((c) => (
            <Line key={c.id} tone="bad" emoji="😟" text={`${c.name}: น้ำที่บ้านสูง ${c.depth.toFixed(1)} ม. ผู้ประสบภัยเริ่มแย่ลง`} />
          ))}
          {rep.closed.map((s) => (
            <Line key={s.id} tone="bad" emoji="🚫" text={`${s.name} น้ำท่วมถึง ปิดรับผู้อพยพ`} />
          ))}
          {rep.reopened.map((s) => (
            <Line key={s.id} tone="good" emoji="🟢" text={`${s.name} น้ำลดแล้ว เปิดรับอีกครั้ง`} />
          ))}
          {rep.stalled.map((t) => (
            <Line key={t.id} tone="bad" emoji="🚙" text={`${t.name} จอดในน้ำลึก รถดับ — รอบหน้าเสียแต้มเดิน 3`} />
          ))}
          {!rep.newlyLost.length && !rep.worse.length && !rep.closed.length && !rep.stalled.length && <Line tone="good" emoji="😌" text="รอบนี้ไม่มีเรื่องเลวร้ายเพิ่ม" />}
        </div>
        {state.tip && (
          <div className="mt-3 rounded-2xl bg-[#fff8e1] p-3 text-[12.5px] leading-relaxed text-ink-2">
            <b className="text-warning-ink">💡 เกร็ดน้ำท่วม:</b> {state.tip}
          </div>
        )}
        <div className="mt-4 flex justify-center">
          <button type="button" className="btn btn-primary h-12 rounded-2xl px-8 font-cute text-[16px] font-bold" onClick={g.nextRound} autoFocus>
            รอบต่อไป ▶
          </button>
        </div>
      </div>
    </Overlay>
  );
}

function Tile({ emoji, label, value, unit, note, bad }: { emoji: string; label: string; value: string; unit: string; note: string; bad?: boolean }) {
  return (
    <div className={`rounded-2xl px-2.5 py-2 ${bad ? 'bg-[#fff0ee]' : 'bg-card'}`}>
      <div className="text-[11px] leading-tight text-ink-3">
        {emoji} {label}
      </div>
      <div className="font-cute text-[22px] leading-tight font-bold tabular">
        {value} <span className="text-[12px] font-semibold text-ink-3">{unit}</span>
      </div>
      {note && <div className={`text-[11px] font-semibold ${note.includes('▲') ? 'text-critical-ink' : 'text-good-ink'}`}>{note}</div>}
    </div>
  );
}

function Line({ emoji, text, tone }: { emoji: string; text: string; tone: 'good' | 'bad' }) {
  return (
    <div className={`flex gap-2 rounded-xl px-2.5 py-1.5 ${tone === 'bad' ? 'bg-[#fff0ee] text-critical-ink' : 'bg-[#eaf8ea] text-good-ink'}`}>
      <span>{emoji}</span>
      <span>{text}</span>
    </div>
  );
}

const HELP = [
  { e: '🎯', t: 'เป้าหมาย', d: 'รับสายขอความช่วยเหลือ พาครอบครัวไปส่งที่ศูนย์พักพิง (ผู้ป่วยติดเตียงไปโรงพยาบาล) ให้ได้มากที่สุดก่อนน้ำจะสูงจนช่วยไม่ทัน' },
  { e: '🔁', t: 'ทุกรอบมี 4 เฟส', d: '🃏 เปิดการ์ดเหตุการณ์ + พยากรณ์ฝน + สายใหม่ → 🧭 แต่ละทีมเดินทาง → 🌊 น้ำมาจริงตามแบบจำลอง → 📋 สรุปว่าถนนไหนจม ใครแย่ลง' },
  { e: '🧭', t: 'เดินทาง', d: 'แตะบนแผนที่เพื่อดูเส้นทาง (จุดสีทีม) แตะอีกครั้งหรือกด "ไปเลย" เพื่อออกเดินทาง ทุกทีมมีแต้มเดินจำกัดต่อรอบ จุดจาง ๆ คือส่วนที่ยังไปไม่ถึงในรอบนี้' },
  { e: '🚙', t: 'รถกับเรือ', d: 'รถลุยน้ำได้ลึกไม่เกิน ~50 ซม. (30–50 ซม. เสี่ยงรถดับ 🎲) น้ำลึกกว่านั้นต้องใช้เรือ (ต้องลึกอย่างน้อย ~35 ซม.) สลับรถ↔เรือเสียแต้มเพิ่ม เกมคำนวณให้อัตโนมัติ' },
  { e: '🙋', t: 'รับและส่ง', d: 'ถึงบ้านที่ขอความช่วยเหลือ → รับขึ้นรถเอง (เสีย 1 แต้ม) ถึงศูนย์พักพิง/โรงพยาบาล → ส่งลงเอง ได้คะแนนตามจำนวนคน ศูนย์เต็มหรือน้ำท่วมถึงจะรับไม่ได้' },
  { e: '⚠️', t: 'ระวัง', d: 'จอดรถไว้ตรงที่น้ำกำลังจะท่วมสูงเกิน ~50 ซม. รถจะดับและเสียแต้มเดินรอบหน้า — จอดที่สูงไว้ก่อนปล่อยน้ำ · ผู้ประสบภัยในบ้านที่น้ำสูงจะทรุดลงทุกรอบ (❤️ → 💔)' },
  { e: '🌧️', t: 'ฝนจริง น้ำจริง', d: 'น้ำในเกมคำนวณด้วยแบบจำลองน้ำท่วมหาดใหญ่ตัวเดียวกับโหมดจำลอง บนถนนและอาคารจริงจาก OpenStreetMap — พายุสุ่มใหม่ทุกฉาก ใช้ "รหัสฉาก" เดิมเพื่อเล่นฉากเดิมซ้ำ' },
  { e: '🛟', t: 'ความจริงอันตรายกว่าเกม', d: 'น้ำเชี่ยวแค่ 15 ซม. ทำให้คนล้มได้ และ 30 ซม. ทำให้รถลอยได้ — ในชีวิตจริงอย่าลุยน้ำลึกที่ไม่รู้ระดับ' },
];

export function HelpModal() {
  const g = useGame.getState();
  return (
    <Overlay onClose={() => g.setModal(null)}>
      <div className="glass w-[min(720px,96vw)] rounded-3xl p-4 sm:p-5" role="dialog" aria-modal="true" aria-labelledby="hp-title">
        <h2 id="hp-title" className="text-center font-cute text-[20px] font-bold">
          ❓ วิธีเล่น
        </h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {HELP.map((h) => (
            <div key={h.t} className="rounded-2xl bg-card p-2.5">
              <div className="font-cute text-[14px] font-bold">
                {h.e} {h.t}
              </div>
              <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-2">{h.d}</p>
            </div>
          ))}
        </div>
        <p className="mt-2 text-center text-[11.5px] text-ink-3">ทางลัด: Enter = ไปเลย · Esc = ยกเลิก · H = แนะนำ · E = จบเทิร์น</p>
        <div className="mt-3 flex justify-center">
          <button type="button" className="btn btn-primary rounded-2xl px-8 py-2 font-cute font-bold" onClick={() => g.setModal(g.screen === 'play' && g.state?.phase === 'event' ? 'event' : null)} autoFocus>
            เข้าใจแล้ว
          </button>
        </div>
      </div>
    </Overlay>
  );
}

export function QuitModal() {
  const g = useGame.getState();
  return (
    <Overlay onClose={() => g.setModal(null)}>
      <div className="glass w-[min(420px,94vw)] rounded-3xl p-5 text-center" role="alertdialog" aria-modal="true" aria-labelledby="qt-title">
        <div className="text-[40px]">🤔</div>
        <h2 id="qt-title" className="font-cute text-[18px] font-bold">
          ออกจากเกมนี้?
        </h2>
        <p className="mt-1 text-[13px] text-ink-2">ความคืบหน้าของเกมนี้จะหายไป (ฉากพายุยังอยู่ในโหมดจำลองให้ดูย้อนหลังได้)</p>
        <div className="mt-4 flex justify-center gap-2">
          <button type="button" className="btn rounded-xl px-5 py-2" onClick={() => g.setModal(g.state?.phase === 'event' ? 'event' : g.state?.phase === 'resolve' ? 'resolve' : null)} autoFocus>
            เล่นต่อ
          </button>
          <button type="button" className="btn btn-primary rounded-xl px-5 py-2" onClick={g.close}>
            ออก
          </button>
        </div>
      </div>
    </Overlay>
  );
}

// ───────────────────────────────────────────── little overlays

export function FloodOverlay() {
  const busy = useGame((s) => s.busy);
  const pct = useGame((s) => s.floodPct);
  const { state } = useGameState();
  const g = useGame.getState();
  if (busy !== 'flood' || !state) return null;
  return (
    <div className="glass pointer-events-auto absolute top-20 left-1/2 z-20 w-[min(440px,92vw)] -translate-x-1/2 rounded-2xl px-4 py-3 gm-pop" role="status" aria-live="polite">
      <div className="flex items-center justify-between gap-2">
        <div className="font-cute text-[15px] font-bold">🌊 น้ำกำลังมา… รอบ {state.round}</div>
        <button type="button" className="btn px-2.5 py-1 text-[12px]" onClick={g.skipFlood}>
          ⏩ ข้าม
        </button>
      </div>
      <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-slate-200/80">
        <div className="gm-wave-bar h-full rounded-full transition-[width]" style={{ width: `${Math.round(pct * 100)}%` }} />
      </div>
      <div className="mt-1 text-[11.5px] text-ink-3">คำนวณน้ำท่วมจริง {state.cfg.roundHours} ชั่วโมง · {Math.round(pct * 100)}%</div>
    </div>
  );
}

export function DiceOverlay() {
  const dice = useGame((s) => s.dice);
  if (!dice) return null;
  const FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
  return (
    <div className="pointer-events-none absolute inset-0 z-30 grid place-items-center">
      <div className="glass gm-pop rounded-3xl px-6 py-4 text-center" role="status" aria-live="assertive">
        <div className="text-[12px] font-semibold text-ink-3">🎲 {dice.team} ลุยน้ำลึก — ทอยลูกเต๋า</div>
        <div className="mt-1 flex flex-wrap items-center justify-center gap-4">
          {dice.rolls.map((r, i) => (
            <div key={i} className="flex flex-col items-center">
              <span className="gm-dice text-[64px] leading-none" style={{ color: r.failed ? '#d03b3b' : '#2f9e44' }}>
                {FACES[r.face - 1]}
              </span>
              <span className={`text-[13px] font-bold ${r.failed ? 'text-critical-ink' : 'text-good-ink'}`}>{r.failed ? '💥 รถดับ!' : '✅ ผ่าน'}</span>
              <span className="text-[11px] text-ink-3">เสี่ยง {Math.round(r.risk * 100)}%</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useGame((s) => s.toasts);
  return (
    <div className="pointer-events-none absolute top-[76px] left-1/2 z-20 flex w-[min(520px,92vw)] -translate-x-1/2 flex-col items-center gap-1.5" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`gm-pop glass rounded-2xl px-3.5 py-2 text-[13px] font-semibold ${t.tone === 'bad' ? 'text-critical-ink' : t.tone === 'good' ? 'text-good-ink' : 'text-ink'}`}>
          {t.emoji} {t.text}
        </div>
      ))}
    </div>
  );
}

export function HoverTip() {
  const hover = useGame((s) => s.hover);
  const preview = useGame((s) => s.preview);
  const pinned = useGame((s) => s.pinned);
  const busy = useGame((s) => s.busy);
  if (!hover || pinned !== null || busy) return null;
  const text = !preview ? '🚫 ไปไม่ได้' : preview.route.steps.length ? `🧭 ${preview.full.mp.toFixed(1)} แต้ม${preview.full.risk > 0.01 ? ` · 🎲 ${Math.round(preview.full.risk * 100)}%` : ''}${preview.partial ? ' (ไกลเกินรอบนี้)' : ''}` : '⛽ แต้มไม่พอ';
  return (
    <div className="glass pointer-events-none fixed z-20 rounded-xl px-2.5 py-1 text-[12px] font-semibold" style={{ left: hover.x + 14, top: hover.y + 14 }}>
      {text}
    </div>
  );
}
