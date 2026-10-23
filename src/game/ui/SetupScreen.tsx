import { useApp } from '../../store';
import { randomSeed } from '../../sim/rng';
import { num } from '../../ui/format';
import { ROLE_LIST, ROLES, TEAM_COLORS, TEAM_NAMES, type RoleId } from '../roles';
import { useGame } from '../store';
import { DIFFICULTY, type Difficulty } from '../storm';

const ROUNDS = [6, 8, 10];

/** how long the flood model takes per round on this device, from a short GPU benchmark */
function DeviceSpeed({ ms }: { ms: number | null }) {
  if (ms === null) return <p className="mt-1 text-[11.5px] text-ink-3">⏱ กำลังวัดความเร็วเครื่องนี้…</p>;
  // a 4 h round is ~9,000 solver steps; the solver gets about half of each frame next to the 3D drawing,
  // and the animation never runs faster than ~6 s per round
  const secs = Math.max(6, Math.round((9000 * ms) / 500));
  const verdict = secs < 12 ? '🚀 ลื่นมาก' : secs < 30 ? '🙂 สบาย' : secs < 75 ? '🐢 ค่อนข้างช้า — แนะนำ 6 รอบและกด ⏩ ข้าม' : '🥵 ช้ามาก — เครื่องนี้อาจไม่เหมาะกับเกม';
  return (
    <p className="mt-1 text-[11.5px] leading-snug text-ink-2" title={`ทดสอบ GPU: ${ms.toFixed(2)} มิลลิวินาทีต่อสเต็ป`}>
      ⏱ เครื่องนี้คำนวณน้ำราว <b className="tabular">{secs}</b> วินาทีต่อรอบ · {verdict}
    </p>
  );
}

export function SetupScreen() {
  const form = useGame((s) => s.form);
  const busy = useGame((s) => s.busy);
  const best = useGame((s) => s.best);
  const bench = useGame((s) => s.bench);
  const ready = useApp((s) => s.engineReady);
  const g = useGame.getState();

  const setTeams = (n: number) => {
    const teams = Array.from({ length: n }, (_, i) => form.teams[i] ?? { name: TEAM_NAMES[i], role: (['rescue', 'boat', 'medic', 'scout'] as RoleId[])[i] });
    g.setForm({ teams });
  };
  const patchTeam = (i: number, p: Partial<{ name: string; role: RoleId }>) => g.setForm({ teams: form.teams.map((t, k) => (k === i ? { ...t, ...p } : t)) });
  const minutes = [Math.round(form.rounds * (0.6 + 0.7 * form.teams.length)), Math.round(form.rounds * (1 + 1.1 * form.teams.length))];

  return (
    <div className="pointer-events-auto absolute inset-0 z-20 overflow-y-auto bg-gradient-to-b from-[#cfe6fb]/80 to-[#f4f9ff]/85 p-3 backdrop-blur-[3px]">
      <div className="glass mx-auto my-2 w-[min(920px,100%)] rounded-3xl p-4 sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="font-cute text-[26px] leading-tight font-bold">
              🎲 เกมกู้ภัยน้ำท่วม<span className="text-accent">หาดใหญ่</span>
            </h1>
            <p className="mt-1 max-w-[560px] text-[13px] leading-relaxed text-ink-2">
              เกมกระดานบนแผนที่เมืองจริง — พายุสุ่มทุกฉาก น้ำท่วมคำนวณด้วยแบบจำลองจริง ตัดถนนทีละสาย คุณต้องพาทีมกู้ภัยไปรับครอบครัวที่ขอความช่วยเหลือ แล้วไปส่งที่ศูนย์พักพิงให้ทัน
            </p>
          </div>
          <button type="button" className="btn flex-none rounded-xl px-3" onClick={g.close} aria-label="กลับโหมดจำลอง">
            ✕ กลับ
          </button>
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-[1.25fr_1fr]">
          <div className="flex flex-col gap-4">
            <section>
              <h2 className="font-cute text-[15px] font-bold">👥 ทีมกู้ภัย (เล่นสลับกันบนเครื่องเดียว)</h2>
              <div className="mt-1.5 flex gap-1.5" role="radiogroup" aria-label="จำนวนทีม">
                {[1, 2, 3, 4].map((n) => (
                  <button key={n} type="button" role="radio" aria-checked={form.teams.length === n} className="chip" onClick={() => setTeams(n)}>
                    {n} ทีม
                  </button>
                ))}
              </div>
              <div className="mt-2 flex flex-col gap-2">
                {form.teams.map((t, i) => (
                  <div key={i} className="rounded-2xl border border-line bg-white p-2">
                    <div className="flex items-center gap-2">
                      <span className="grid h-8 w-8 flex-none place-items-center rounded-full border-4 bg-white text-[17px]" style={{ borderColor: TEAM_COLORS[i] }}>
                        {ROLES[t.role].emoji}
                      </span>
                      <input className="field h-8 min-w-0 flex-1" value={t.name} maxLength={14} onChange={(e) => patchTeam(i, { name: e.target.value || TEAM_NAMES[i] })} aria-label={`ชื่อทีม ${i + 1}`} />
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1" role="radiogroup" aria-label={`บทบาททีม ${i + 1}`}>
                      {ROLE_LIST.map((r) => (
                        <button key={r.id} type="button" role="radio" aria-checked={t.role === r.id} className="chip" onClick={() => patchTeam(i, { role: r.id })} title={r.blurb}>
                          {r.emoji} {r.name}
                        </button>
                      ))}
                    </div>
                    <p className="mt-1 text-[11.5px] text-ink-3">{ROLES[t.role].blurb}</p>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <div className="flex flex-col gap-4">
            <section>
              <h2 className="font-cute text-[15px] font-bold">⛈️ ความยากของพายุ</h2>
              <div className="mt-1.5 flex flex-col gap-1.5" role="radiogroup" aria-label="ความยาก">
                {(Object.keys(DIFFICULTY) as Difficulty[]).map((d) => {
                  const info = DIFFICULTY[d];
                  return (
                    <button
                      key={d}
                      type="button"
                      role="radio"
                      aria-checked={form.difficulty === d}
                      onClick={() => g.setForm({ difficulty: d })}
                      className={`flex items-start gap-2 rounded-2xl border-[1.5px] px-3 py-2 text-left ${form.difficulty === d ? 'border-[#7fb2ef] bg-accent-soft' : 'border-[#dde4ee] bg-white hover:border-[#b9d3f3]'}`}
                    >
                      <span className="text-[24px] leading-none">{info.emoji}</span>
                      <span>
                        <span className="block font-cute text-[14px] font-bold">{info.label}</span>
                        <span className="block text-[11.5px] leading-snug text-ink-2">{info.blurb}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>

            <section>
              <h2 className="font-cute text-[15px] font-bold">🔁 จำนวนรอบ</h2>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="จำนวนรอบ">
                {ROUNDS.map((r) => (
                  <button key={r} type="button" role="radio" aria-checked={form.rounds === r} className="chip" onClick={() => g.setForm({ rounds: r })}>
                    {r} รอบ
                  </button>
                ))}
                <span className="text-[11.5px] text-ink-3">
                  รอบละ 4 ชม. ในเกม · เล่นราว {minutes[0]}–{minutes[1]} นาที
                </span>
              </div>
              <DeviceSpeed ms={bench} />
            </section>

            <section>
              <h2 className="font-cute text-[15px] font-bold">🔢 รหัสฉาก</h2>
              <div className="mt-1.5 flex items-center gap-2">
                <input className="field h-9 w-32 tabular" inputMode="numeric" value={form.seed} onChange={(e) => g.setForm({ seed: Math.max(0, Math.floor(Number(e.target.value.replace(/\D/g, '')) || 0)) % 2147483647 })} aria-label="รหัสฉาก" />
                <button type="button" className="btn px-3" onClick={() => g.setForm({ seed: randomSeed() % 100000 })} title="สุ่มฉากใหม่">
                  🎲 สุ่ม
                </button>
              </div>
              <p className="mt-1 text-[11.5px] leading-snug text-ink-3">รหัสเดียวกัน = ย่าน พายุ และการ์ดเหมือนเดิม — ชวนเพื่อนเล่นฉากเดียวกันแล้วเทียบคะแนนได้</p>
            </section>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <button type="button" className="btn btn-primary h-12 rounded-2xl px-10 font-cute text-[17px] font-bold shadow-lg" onClick={() => void g.start()} disabled={!ready || busy === 'loading'}>
            {busy === 'loading' ? '⏳ กำลังสร้างฉาก…' : ready ? '▶ เริ่มเกม' : '⏳ กำลังเตรียมแบบจำลองน้ำ…'}
          </button>
          <button type="button" className="btn h-12 rounded-2xl px-5" onClick={() => g.setModal('help')}>
            ❓ วิธีเล่น
          </button>
        </div>

        {best.length > 0 && (
          <section className="mt-5">
            <h2 className="font-cute text-[15px] font-bold">🏆 คะแนนสูงสุด</h2>
            <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2">
              {best.slice(0, 6).map((r, i) => (
                <div key={r.id} className="flex items-center gap-2 rounded-xl bg-card px-2.5 py-1.5 text-[12px]">
                  <span className="w-5 text-center font-bold text-ink-3">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {DIFFICULTY[r.difficulty].emoji} #{r.seed} · {r.teams.map((t) => t.name).join(', ')} · ช่วย {r.people_saved}/{r.people_total}
                  </span>
                  <span className="flex-none">{'⭐'.repeat(r.stars) || '–'}</span>
                  <b className="tabular flex-none">{num(r.points)}</b>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
