import { num } from '../../ui/format';
import { ROLES } from '../roles';
import { CALL_KINDS, savedPeople, stars, type GameState } from '../rules';
import { useGame } from '../store';
import { DIFFICULTY } from '../storm';
import { useGameState } from './shared';

export function ResultScreen() {
  const { state } = useGameState();
  const g = useGame.getState();
  if (!state) return null;
  const saved = savedPeople(state);
  const total = state.stats.people;
  const n = stars(state);
  const calls = state.calls;
  const safe = calls.filter((c) => c.status === 'safe').length;
  const msg = [
    'ยากจริง ๆ — ลองระดับที่ง่ายกว่า หรือเล่นฉากเดิมอีกรอบโดยวางแผนเส้นทางใหม่',
    'ช่วยได้บางส่วน — ลองส่งทีมไปรอใกล้ที่ลุ่มก่อนน้ำมา',
    'ทำได้ดีมาก! ชุมชนปลอดภัยเกือบทั้งหมด',
    'ยอดเยี่ยม! ชุมชนปลอดภัยเพราะทีมของคุณ',
  ][n];
  const maxTeam = Math.max(1, ...state.teams.map((t) => t.rescued));
  return (
    <div className="pointer-events-auto absolute inset-0 z-30 overflow-y-auto bg-[#0b2340]/35 p-3 backdrop-blur-[2px]">
      <div className="glass gm-pop mx-auto my-2 w-[min(860px,100%)] rounded-3xl p-4 sm:p-6" role="dialog" aria-modal="true" aria-labelledby="rz-title">
        <div className="text-center">
          <div className="text-[44px] leading-none tracking-wider" aria-label={`${n} ดาว`}>
            {[0, 1, 2].map((i) => (
              <span key={i} style={{ opacity: i < n ? 1 : 0.22, filter: i < n ? undefined : 'grayscale(1)' }}>
                ⭐
              </span>
            ))}
          </div>
          <h1 id="rz-title" className="mt-1 font-cute text-[24px] font-bold">
            จบเกม! ช่วยได้ {saved} จาก {total} คน
          </h1>
          <p className="mt-0.5 text-[13px] text-ink-2">{msg}</p>
          <p className="mt-0.5 text-[11.5px] text-ink-3">
            {DIFFICULTY[state.cfg.difficulty].emoji} {DIFFICULTY[state.cfg.difficulty].label} · {state.center.name} · ฉาก #{state.cfg.seed}
          </p>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat emoji="🏅" label="คะแนนรวม" value={num(state.stats.points)} />
          <Stat emoji="📞" label="สายที่ช่วยทัน" value={`${safe}/${calls.length}`} />
          <Stat emoji="💔" label="ช่วยไม่ทัน" value={`${state.stats.lostPeople} คน`} bad={state.stats.lostPeople > 0} />
          <Stat emoji="🎲" label="รถดับ/ทอยพลาด" value={`${state.stats.stalls} ครั้ง`} />
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <section className="rounded-2xl bg-card p-3">
            <h2 className="font-cute text-[14px] font-bold">👥 ผลงานแต่ละทีม</h2>
            <div className="mt-2 flex flex-col gap-2">
              {state.teams.map((t) => (
                <div key={t.id} className="flex items-center gap-2">
                  <span className="grid h-7 w-7 flex-none place-items-center rounded-full border-[3px] bg-white text-[14px]" style={{ borderColor: t.color }}>
                    {ROLES[t.role].emoji}
                  </span>
                  <span className="w-20 flex-none truncate text-[12px] font-semibold">{t.name}</span>
                  <span className="h-3 flex-1 overflow-hidden rounded-full bg-slate-200">
                    <span className="block h-full rounded-full" style={{ width: `${(t.rescued / maxTeam) * 100}%`, background: t.color }} />
                  </span>
                  <span className="tabular w-14 flex-none text-right text-[12px] font-bold">{t.rescued} คน</span>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-2xl bg-card p-3">
            <h2 className="font-cute text-[14px] font-bold">🌊 น้ำท่วมแต่ละรอบ</h2>
            <MiniBars state={state} />
          </section>
        </div>

        <section className="mt-3 rounded-2xl bg-card p-3">
          <h2 className="font-cute text-[14px] font-bold">📋 สายทั้งหมด</h2>
          <div className="mt-1.5 grid gap-1 sm:grid-cols-2">
            {calls.map((c) => (
              <div key={c.id} className={`flex items-center gap-2 rounded-xl px-2 py-1 text-[12px] ${c.status === 'safe' ? 'bg-[#eaf8ea]' : 'bg-[#fff0ee]'}`}>
                <span>{c.status === 'safe' ? '✅' : '💔'}</span>
                <span className="min-w-0 flex-1 truncate">
                  {CALL_KINDS[c.kind].emoji} {c.name} · {c.people} คน{c.at ? ` → ${c.at}` : c.status === 'lost' ? (c.maxDepth >= 0.05 ? ` · น้ำสูงสุด ${c.maxDepth.toFixed(1)} ม.` : ' · ไปไม่ทัน') : ''}
                </span>
                {c.points > 0 && <b className="tabular text-good-ink">+{c.points}</b>}
              </div>
            ))}
          </div>
        </section>

        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <button type="button" className="btn btn-primary h-11 rounded-2xl px-6 font-cute font-bold" onClick={() => void g.start(state.cfg.seed)}>
            🔁 เล่นฉากเดิมอีกครั้ง
          </button>
          <button type="button" className="btn h-11 rounded-2xl px-5" onClick={() => void g.start((Math.random() * 100000) | 0)}>
            🎲 ฉากใหม่
          </button>
          <button type="button" className="btn h-11 rounded-2xl px-5" onClick={() => useGame.setState({ screen: 'setup' })}>
            ⚙️ ตั้งค่าใหม่
          </button>
          <button type="button" className="btn h-11 rounded-2xl px-5" onClick={g.close}>
            🏠 กลับโหมดจำลอง
          </button>
        </div>
      </div>
    </div>
  );
}

function Stat({ emoji, label, value, bad }: { emoji: string; label: string; value: string; bad?: boolean }) {
  return (
    <div className={`rounded-2xl px-3 py-2 ${bad ? 'bg-[#fff0ee]' : 'bg-card'}`}>
      <div className="text-[11px] text-ink-3">
        {emoji} {label}
      </div>
      <div className="font-cute text-[20px] leading-tight font-bold tabular">{value}</div>
    </div>
  );
}

/** two small bar charts (never one dual-axis chart): flooded area and share of district roads cut */
function MiniBars({ state }: { state: GameState }) {
  const h = state.history;
  const maxA = Math.max(1, ...h.map((x) => x.floodedKm2));
  return (
    <div className="mt-2 flex flex-col gap-3">
      <Bars label="พื้นที่น้ำท่วม (ตร.กม.)" color="#2a78d6" values={h.map((x) => x.floodedKm2)} max={maxA} fmt={(v) => num(v)} />
      <Bars label="ถนนในย่านที่รถผ่านไม่ได้ (%)" color="#eb6834" values={h.map((x) => (x.roadKm ? (x.roadKmBlocked / x.roadKm) * 100 : 0))} max={100} fmt={(v) => `${num(v)}`} />
    </div>
  );
}

function Bars({ label, color, values, max, fmt }: { label: string; color: string; values: number[]; max: number; fmt: (v: number) => string }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-semibold text-ink-3">{label}</div>
      <div className="flex h-[68px] items-end gap-1.5 border-b border-base">
        {values.map((v, i) => (
          <div key={i} className="flex min-w-0 flex-1 flex-col items-center justify-end" title={`รอบ ${i + 1}: ${fmt(v)}`}>
            <span className="tabular text-[9.5px] font-semibold text-ink-2">{fmt(v)}</span>
            <div className="w-full max-w-[26px] rounded-t-[4px]" style={{ height: `${Math.max(2, (v / max) * 48)}px`, background: color }} />
          </div>
        ))}
      </div>
      <div className="mt-0.5 flex gap-1.5">
        {values.map((_, i) => (
          <span key={i} className="min-w-0 flex-1 text-center text-[9.5px] text-ink-3">
            {i + 1}
          </span>
        ))}
      </div>
    </div>
  );
}
