import { useState } from 'react';
import { getEngine } from '../../store';
import { num, rainLook } from '../../ui/format';
import { ROLES } from '../roles';
import { CALL_KINDS, callById, canAct, seatsLeft, treeFor, type Call, type GameState, type Team } from '../rules';
import { useGame } from '../store';
import { Hearts, riverWord, roundClock, useGameState } from './shared';

const PHASES = [
  { k: 'event', e: '🃏', t: 'เหตุการณ์' },
  { k: 'action', e: '🧭', t: 'เดินทาง' },
  { k: 'flood', e: '🌊', t: 'น้ำมา' },
  { k: 'resolve', e: '📋', t: 'สรุป' },
] as const;

export function Hud() {
  const { state } = useGameState();
  const [drawer, setDrawer] = useState<'teams' | 'calls' | null>(null);
  if (!state) return null;
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col gap-3 p-3">
      <TopBar onDrawer={(d) => setDrawer((cur) => (cur === d ? null : d))} drawer={drawer} />
      <div className="relative flex min-h-0 flex-1 justify-between gap-3">
        <LeftPanel open={drawer === 'teams'} />
        <RightPanel open={drawer === 'calls'} />
      </div>
      <Dock />
    </div>
  );
}

function TopBar({ onDrawer, drawer }: { onDrawer: (d: 'teams' | 'calls') => void; drawer: string | null }) {
  const { state } = useGameState();
  const watch = useGame((s) => s.watch);
  const light = useGame((s) => s.realLight);
  const cut = useGame((s) => s.showCut);
  if (!state) return null;
  const g = useGame.getState();
  const phaseKey = state.phase === 'over' ? 'resolve' : state.phase;
  return (
    <header className="pointer-events-none flex flex-wrap items-start justify-between gap-2">
      <div className="glass pointer-events-auto flex min-w-0 items-center gap-3 rounded-2xl px-3 py-2">
        <span className="text-[26px] leading-none" aria-hidden="true">
          🎲
        </span>
        <div className="min-w-0 leading-tight">
          <div className="font-cute text-[15px] font-bold">
            รอบ {state.round}/{state.cfg.rounds}
          </div>
          <div className="max-w-[230px] truncate text-[11px] text-ink-3">
            {state.center.name} · {roundClock(state)}
          </div>
        </div>
        <RoundPips state={state} />
      </div>

      <div className="glass pointer-events-auto flex items-center gap-1 rounded-2xl p-1.5 max-md:order-last max-md:w-full max-md:justify-center" role="list" aria-label="เฟสของรอบ">
        {PHASES.map((p, i) => {
          const cur = p.k === phaseKey;
          return (
            <div key={p.k} role="listitem" className="flex items-center gap-1">
              {i > 0 && <span className="text-ink-3">›</span>}
              <span className={`flex items-center gap-1 rounded-xl px-2.5 py-1 text-[12.5px] ${cur ? 'bg-accent text-white font-bold shadow' : 'text-ink-3'}`} aria-current={cur ? 'step' : undefined} title={p.t}>
                <span aria-hidden="true">{p.e}</span>
                <span className={cur ? '' : 'max-xl:hidden'}>{p.t}</span>
              </span>
            </div>
          );
        })}
      </div>

      <div className="pointer-events-auto flex items-center gap-1.5">
        <button type="button" className="btn glass rounded-xl px-2.5 md:hidden" onClick={() => onDrawer('teams')} aria-pressed={drawer === 'teams'}>
          👥
        </button>
        <button type="button" className="btn glass rounded-xl px-2.5 md:hidden" onClick={() => onDrawer('calls')} aria-pressed={drawer === 'calls'}>
          📞
        </button>
        <button type="button" className="btn glass rounded-xl px-2.5" onClick={g.toggleCut} title={cut ? 'ซ่อนจุดแดงบอกถนนที่รถผ่านไม่ได้' : 'แสดงจุดแดงบอกถนนที่รถผ่านไม่ได้'} aria-pressed={cut}>
          🚧
        </button>
        <button type="button" className="btn glass rounded-xl px-2.5" onClick={g.toggleLight} title={light ? 'กำลังใช้แสงตามเวลาจริง (กลางคืนจะมืด)' : 'แสงกลางวันตลอด (อ่านแผนที่ง่าย)'} aria-pressed={light}>
          {light ? '🌙' : '☀️'}
        </button>
        <button type="button" className="btn glass rounded-xl px-2.5" onClick={g.toggleWatch} title={watch ? 'ดูน้ำไหลทีละช่วง (กดเพื่อเปลี่ยนเป็นข้ามเร็ว)' : 'ข้ามไปผลเลย (กดเพื่อกลับไปดูน้ำไหล)'} aria-pressed={watch}>
          {watch ? '🐢' : '⏩'}
        </button>
        <button type="button" className="btn glass rounded-xl px-2.5" onClick={() => g.setModal('help')} aria-label="วิธีเล่น" title="วิธีเล่น">
          ❓
        </button>
        <button type="button" className="btn glass rounded-xl px-2.5" onClick={() => g.setModal('quit')} aria-label="ออกจากเกม" title="ออกจากเกม">
          ✕
        </button>
      </div>
    </header>
  );
}

function RoundPips({ state }: { state: GameState }) {
  return (
    <div className="flex items-center gap-1 max-xl:hidden" role="list" aria-label="สภาพอากาศแต่ละรอบ">
      {Array.from({ length: state.cfg.rounds }, (_, i) => {
        const k = i + 1;
        const cur = k === state.round;
        const done = k < state.round || (cur && (state.phase === 'resolve' || state.phase === 'over'));
        const rain = state.history[i]?.rain;
        const face = done && rain !== undefined ? rainLook(rain).emoji : cur ? (state.forecast?.known ? rainLook(state.forecast.mid).emoji : '📵') : '·';
        return (
          <span
            key={k}
            role="listitem"
            title={`รอบ ${k}${done && rain !== undefined ? ` · ฝนจริง ~${num(rain)} มม./ชม.` : cur ? ' · รอบนี้' : ''}`}
            className={`grid h-7 w-7 place-items-center rounded-full text-[14px] ${cur ? 'bg-accent-soft ring-2 ring-accent' : done ? 'bg-card' : 'text-ink-3'}`}
          >
            {face}
          </span>
        );
      })}
    </div>
  );
}

// ───────────────────────────────────────────── left: weather + teams

function LeftPanel({ open }: { open: boolean }) {
  const { state } = useGameState();
  if (!state) return null;
  return (
    <aside className={`glass pointer-events-auto flex w-[318px] flex-none flex-col gap-2.5 overflow-y-auto rounded-2xl p-2.5 scroll-thin max-lg:w-[280px] max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-20 max-md:w-[min(340px,92vw)] ${open ? '' : 'max-md:hidden'}`}>
      <ForecastCard state={state} />
      {state.teams.map((t) => (
        <TeamCard key={t.id} team={t} active={state.phase === 'action' && state.active === t.id} />
      ))}
      <details className="rounded-2xl bg-card px-3 py-2 text-[11.5px] leading-relaxed text-ink-2">
        <summary className="cursor-pointer font-semibold text-ink">🗺️ สัญลักษณ์บนแผนที่</summary>
        <ul className="mt-1.5 space-y-0.5">
          <li>
            <Dot c="#e8590c" /> จุดสีทีม = ที่ที่รถของทีมไปถึงได้ในรอบนี้ · เส้นประ = เส้นทางที่วางไว้ (จางคือส่วนที่ยังไม่ถึง)
          </li>
          <li>
            <Dot c="#0aa5c9" /> จุดฟ้า = ต้องใช้เรือ (น้ำลึก) · <Dot c="#f08c00" /> จุดส้ม = ลุยน้ำเสี่ยงรถดับ 🎲
          </li>
          <li>
            <Dot c="#e03131" /> จุดแดง = ถนนที่ทีมนี้ผ่านไม่ได้ (น้ำลึกเกิน หรือถูกปิด 🚧)
          </li>
          <li>👨‍👩‍👧 สายขอความช่วยเหลือ (❤️ = ความทรุดโทรม) · ⛺ศูนย์พักพิง · 🏥โรงพยาบาล (ผู้ป่วยเท่านั้น)</li>
        </ul>
      </details>
    </aside>
  );
}

function Dot({ c }: { c: string }) {
  return <span className="mr-0.5 inline-block h-2.5 w-2.5 rounded-full align-middle ring-2 ring-white" style={{ background: c }} />;
}

function ForecastCard({ state }: { state: GameState }) {
  const f = state.forecast;
  const card = state.card;
  const g = useGame.getState();
  if (!f || !card) return null;
  const look = f.known ? rainLook(f.mid) : { emoji: '📵', text: 'ไม่มีสัญญาณ' };
  const river = riverWord(f.riverMid);
  const next = f.nextMid !== null ? rainLook(f.nextMid) : null;
  return (
    <div className="rounded-2xl border border-line bg-gradient-to-b from-[#eef7ff] to-white p-2.5">
      <div className="flex items-center gap-2.5">
        <span className="text-[34px] leading-none" aria-hidden="true">
          {look.emoji}
        </span>
        <div className="min-w-0">
          <div className="text-[10.5px] text-ink-3">📡 พยากรณ์รอบนี้ · {roundClock(state)} – {roundClock(state, 1)}</div>
          {f.known ? (
            <>
              <div className="font-cute text-[15px] leading-tight font-bold">
                {look.text} ~{num(f.mid)} มม./ชม.
              </div>
              <div className="text-[11px] text-ink-2">
                {f.exact ? 'แม่นยำ (วิทยุ) · ' : `อาจ ${num(f.lo)}–${num(f.hi)} · `}น้ำเหนือ {river.emoji} {river.text}
                {next && ` · รอบหน้า ${next.emoji}`}
              </div>
            </>
          ) : (
            <div className="font-cute text-[14px] font-bold">ไฟดับ ไม่รู้พยากรณ์รอบนี้</div>
          )}
        </div>
      </div>
      <button
        type="button"
        className="mt-2 flex w-full items-start gap-2 rounded-xl px-2 py-1.5 text-left text-[12px] leading-snug hover:brightness-95"
        style={{ background: card.def.tone === 'bad' ? '#fff0ee' : card.def.tone === 'good' ? '#eaf8ea' : '#f1f5fa' }}
        onClick={() => g.setModal('event')}
        title="ดูการ์ดอีกครั้ง"
      >
        <span className="text-[18px] leading-none">{card.def.emoji}</span>
        <span>
          <b>{card.def.title}</b>
          <span className="text-ink-2"> {card.notes.join(' · ') || card.def.text}</span>
        </span>
      </button>
    </div>
  );
}

function TeamCard({ team, active }: { team: Team; active: boolean }) {
  const { state, world } = useGameState();
  const g = useGame.getState();
  const busy = useGame((s) => s.busy);
  if (!state || !world) return null;
  const role = ROLES[team.role];
  const aboard = team.load.map((id) => callById(state, id)!).filter(Boolean);
  const seats = seatsLeft(state, team);
  const cap = role.capacity + team.capBonus;
  const pct = Math.min(100, (team.mp / Math.max(team.maxMp, team.mp, 1)) * 100);
  return (
    <div className="rounded-2xl border-[1.5px] p-2.5" style={{ borderColor: active ? team.color : 'transparent', background: active ? '#fff' : 'var(--color-card)', boxShadow: active ? '0 3px 12px rgb(0 0 0 / .12)' : undefined }}>
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          className="grid h-10 w-10 flex-none place-items-center rounded-full border-4 bg-white text-[21px]"
          style={{ borderColor: team.color }}
          onClick={() => getEngine()?.flyTo(world.graph.x[team.node], world.graph.y[team.node], 1800)}
          title="ดูทีมนี้บนแผนที่"
        >
          {role.emoji}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-cute text-[14px] font-bold">{team.name}</span>
            {active && <span className="rounded-full bg-accent px-1.5 text-[10px] font-bold text-white">กำลังเล่น</span>}
            {team.stalled && <span title="รถดับ เสียแต้มเดินรอบหน้า">💥</span>}
          </div>
          <div className="text-[11px] text-ink-3">
            {role.name} · {team.mode === 1 ? '🚤 เรือ' : '🚙 รถ'} · ว่าง {seats}/{cap} ที่นั่ง
          </div>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-200/80" role="img" aria-label={`แต้มเดินเหลือ ${team.mp.toFixed(1)}`}>
          <div className="h-full rounded-full transition-[width]" style={{ width: `${pct}%`, background: team.color }} />
        </div>
        <span className="tabular text-[11.5px] font-semibold text-ink-2">{team.mp.toFixed(1)} แต้ม</span>
      </div>
      {aboard.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {aboard.map((c) => (
            <span key={c.id} className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-[#1d4f8f]" title={c.name}>
              {CALL_KINDS[c.kind].emoji} {c.name} · {c.people}
            </span>
          ))}
        </div>
      )}
      {active && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {canAct(state, team) && (
            <button type="button" className="btn btn-primary px-2.5 py-1 text-[12px]" onClick={g.actHere} disabled={!!busy}>
              🙋 รับ/ส่งที่จุดนี้
            </button>
          )}
          <button type="button" className="btn px-2.5 py-1 text-[12px]" onClick={g.askHint} disabled={!!busy} title="ให้ผู้ช่วยเสนอเป้าหมายที่คุ้มที่สุด (H)">
            💡 แนะนำ
          </button>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────────────────────── right: calls, shelters, log

function RightPanel({ open }: { open: boolean }) {
  const { state } = useGameState();
  const [tab, setTab] = useState<'calls' | 'shelters' | 'log'>('calls');
  if (!state) return null;
  const waiting = state.calls.filter((c) => c.status === 'waiting').length;
  return (
    <aside className={`glass pointer-events-auto flex w-[300px] flex-none flex-col overflow-hidden rounded-2xl max-lg:w-[270px] max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:z-20 max-md:w-[min(340px,92vw)] ${open ? '' : 'max-md:hidden'}`}>
      <div className="flex gap-1 border-b border-line p-1.5" role="tablist">
        {(
          [
            ['calls', `📞 สายเข้า ${waiting}`],
            ['shelters', '⛺ ศูนย์พักพิง'],
            ['log', '📜 บันทึก'],
          ] as const
        ).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={`flex-1 rounded-lg px-1 py-1.5 text-[12px] ${tab === k ? 'bg-accent-soft font-bold text-[#1d4f8f]' : 'text-ink-2 hover:bg-hover'}`} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-2">
        {tab === 'calls' && <Calls state={state} />}
        {tab === 'shelters' && <Shelters state={state} />}
        {tab === 'log' && <Log state={state} />}
      </div>
    </aside>
  );
}

function Calls({ state }: { state: GameState }) {
  const { world } = useGameState();
  const g = useGame.getState();
  if (!world) return null;
  const action = state.phase === 'action';
  const tree = action ? treeFor(state, world, state.teams[state.active]) : null;
  const cost = (c: Call) => (tree ? Math.min(tree.mp[c.node * 2], tree.mp[c.node * 2 + 1]) : Infinity);
  const waiting = state.calls.filter((c) => c.status === 'waiting').sort((a, b) => b.distress - a.distress || a.id - b.id);
  const aboard = state.calls.filter((c) => c.status === 'aboard');
  const done = state.calls.filter((c) => c.status === 'safe' || c.status === 'lost');
  return (
    <div className="flex flex-col gap-1.5">
      {waiting.length === 0 && <p className="rounded-xl bg-card p-3 text-center text-[12.5px] text-ink-2">😌 ตอนนี้ไม่มีสายค้าง — รอสายใหม่ในรอบหน้า</p>}
      {waiting.map((c) => {
        const mp = cost(c);
        return (
          <button
            key={c.id}
            type="button"
            className="flex items-center gap-2 rounded-xl border border-line bg-white px-2 py-1.5 text-left hover:bg-hover"
            onClick={() => {
              g.clickNode(c.node);
              getEngine()?.flyTo(c.x, c.y, 1500);
            }}
          >
            <span className="text-[24px] leading-none">{CALL_KINDS[c.kind].emoji}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-semibold">
                {c.name} · {c.people} คน
              </span>
              <span className="block text-[11px] text-ink-2">
                <Hearts distress={c.distress} /> น้ำที่บ้าน {c.depth >= 0.05 ? `${c.depth.toFixed(1)} ม.` : 'ยังไม่ท่วม'}
                {c.hand < 0 ? ' · ที่ลุ่ม' : ''}
              </span>
            </span>
            {action && <span className="tabular flex-none text-[11px] font-semibold text-ink-2">{isFinite(mp) ? `🧭 ${mp.toFixed(1)}` : '🚫'}</span>}
          </button>
        );
      })}
      {aboard.length > 0 && (
        <>
          <div className="mt-1 px-1 text-[11px] font-semibold text-ink-3">กำลังพาไปส่ง</div>
          {aboard.map((c) => (
            <div key={c.id} className="flex items-center gap-2 rounded-xl bg-accent-soft/60 px-2 py-1.5 text-[12px]">
              <span className="text-[20px]">{CALL_KINDS[c.kind].emoji}</span>
              <span className="min-w-0 flex-1 truncate">
                {c.name} · {c.people} คน · {state.teams[c.by!].name}
              </span>
            </div>
          ))}
        </>
      )}
      {done.length > 0 && (
        <>
          <div className="mt-1 px-1 text-[11px] font-semibold text-ink-3">เสร็จแล้ว</div>
          {done.map((c) => (
            <div key={c.id} className="flex items-center gap-2 rounded-xl bg-card px-2 py-1 text-[11.5px] text-ink-2">
              <span>{c.status === 'safe' ? '✅' : '💔'}</span>
              <span className="min-w-0 flex-1 truncate">
                {c.name} · {c.people} คน{c.at ? ` → ${c.at}` : ''}
              </span>
              {c.points > 0 && <b className="tabular text-good-ink">+{c.points}</b>}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function Shelters({ state }: { state: GameState }) {
  const g = useGame.getState();
  return (
    <div className="flex flex-col gap-1.5">
      <p className="px-1 text-[11px] leading-snug text-ink-3">ส่งครอบครัวที่ศูนย์พักพิง ส่งผู้ป่วยที่โรงพยาบาล — ศูนย์ที่น้ำท่วมถึงจะปิดรับ</p>
      {state.shelters.map((s) => (
        <button
          key={s.id}
          type="button"
          className={`flex items-center gap-2 rounded-xl border px-2 py-1.5 text-left hover:bg-hover ${s.closed ? 'border-critical/40 bg-[#fff1f1]' : 'border-line bg-white'}`}
          onClick={() => {
            g.clickNode(s.node);
            getEngine()?.flyTo(s.x, s.y, 1500);
          }}
        >
          <span className="text-[22px] leading-none">{s.icon}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12px] font-semibold">{s.name}</span>
            <span className="mt-0.5 flex items-center gap-1.5">
              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200">
                <span className="block h-full rounded-full bg-good" style={{ width: `${(s.occupants / s.capacity) * 100}%` }} />
              </span>
              <span className="tabular text-[10.5px] text-ink-2">
                {s.occupants}/{s.capacity}
              </span>
            </span>
          </span>
          {(s.closed || s.occupants >= s.capacity || s.hospital) && (
            <span className={`flex-none text-[10.5px] font-semibold ${s.closed ? 'text-critical-ink' : 'text-ink-3'}`}>{s.closed ? '🚫 ปิด' : s.occupants >= s.capacity ? '🈵 เต็ม' : 'ผู้ป่วย'}</span>
          )}
        </button>
      ))}
    </div>
  );
}

function Log({ state }: { state: GameState }) {
  const rows = state.log.slice(-60).reverse();
  let last = -1;
  return (
    <div className="flex flex-col gap-0.5 text-[12px]">
      {rows.map((r, i) => {
        const head = r.round !== last;
        last = r.round;
        return (
          <div key={`${i}-${r.text}`}>
            {head && <div className="mt-1.5 mb-0.5 px-1 text-[10.5px] font-bold text-ink-3">รอบ {r.round || '–'}</div>}
            <div className={`flex gap-1.5 rounded-lg px-1.5 py-0.5 ${r.tone === 'bad' ? 'text-critical-ink' : r.tone === 'good' ? 'text-good-ink' : 'text-ink-2'}`}>
              <span>{r.emoji}</span>
              <span className="min-w-0 flex-1">{r.text}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ───────────────────────────────────────────── bottom dock: route + end turn

function Dock() {
  const { state } = useGameState();
  const g = useGame.getState();
  const busy = useGame((s) => s.busy);
  const preview = useGame((s) => s.preview);
  const pinned = useGame((s) => s.pinned);
  const hint = useGame((s) => s.hint);
  if (!state || state.phase !== 'action') return <div />;
  const team = state.teams[state.active];
  const last = state.active === state.teams.length - 1;
  const route = preview?.route;
  const at: string[] = [];
  if (preview && pinned !== null) {
    for (const c of state.calls) if (c.status === 'waiting' && c.node === pinned) at.push(`${CALL_KINDS[c.kind].emoji} ${c.name} (${c.people} คน)`);
    for (const s of state.shelters) if (s.node === pinned) at.push(`${s.icon} ${s.name} (${s.occupants}/${s.capacity})`);
  }
  return (
    <div className="pointer-events-none flex flex-wrap items-end justify-center gap-2">
      {pinned === null && state.round === 1 && state.active === 0 && !busy && !team.moved && (
        <div className="glass pointer-events-auto max-w-[520px] rounded-2xl px-3 py-2 text-[12.5px] leading-snug text-ink-2 gm-pop">
          👆 <b className="text-ink">เริ่มยังไง?</b> แตะบ้านที่ขอความช่วยเหลือ (ไอคอนครอบครัว) หรือเลือกจากรายการ <b>📞 สายเข้า</b> ทางขวา แล้วกด <b>ไปเลย ▶</b> — ขากลับอย่าลืมไปส่งที่ศูนย์พักพิง ⛺
        </div>
      )}
      {pinned !== null && (
        <div className="glass pointer-events-auto flex max-w-[640px] flex-wrap items-center gap-x-3 gap-y-1.5 rounded-2xl px-3 py-2 gm-pop">
          {hint && <div className="basis-full text-[12.5px] font-semibold text-[#1d4f8f]">💡 {hint}</div>}
          {!preview ? (
            <span className="text-[13px] font-semibold text-critical-ink">🚫 ไปจุดนี้ไม่ได้ตอนนี้ (น้ำลึกหรือถนนถูกปิด)</span>
          ) : (
            <div className="min-w-0 text-[12.5px] leading-snug">
              <div className="font-semibold">
                🧭 {preview.full.mp.toFixed(1)} แต้มถึงเป้า
                {preview.partial && <span className="text-warning-ink"> · วันนี้ไปได้แค่ {route!.mp.toFixed(1)} จาก {team.mp.toFixed(1)}</span>}
                {!preview.partial && <span className="text-ink-3"> · เหลือ {(team.mp - preview.full.mp).toFixed(1)}</span>}
              </div>
              <div className="text-ink-2">
                {preview.full.steps.some((s) => s.mode === 1) ? '🚤 ใช้เรือช่วงน้ำลึก · ' : '🚙 ถนนปกติ · '}
                {preview.full.maxDepth > 0.05 ? `ลุยน้ำลึกสุด ${preview.full.maxDepth.toFixed(2)} ม.` : 'ถนนแห้ง'}
                {preview.full.risk > 0.01 && <b className="text-warning-ink"> · 🎲 เสี่ยงรถดับ {Math.round(preview.full.risk * 100)}%</b>}
              </div>
              {at.length > 0 && <div className="text-[#1d4f8f]">ที่จุดนี้: {at.join(' · ')}</div>}
            </div>
          )}
          <div className="ml-auto flex gap-1.5">
            {preview && route!.steps.length > 0 && (
              <button type="button" className="btn btn-primary px-3 py-1.5 text-[13px] font-bold" onClick={() => void g.confirm()} disabled={!!busy}>
                {preview.partial ? 'ไปให้ไกลที่สุด ▶' : 'ไปเลย ▶'}
              </button>
            )}
            <button type="button" className="btn px-2.5 py-1.5" onClick={g.clearPin} aria-label="ยกเลิกเส้นทาง">
              ✕
            </button>
          </div>
        </div>
      )}
      <button type="button" className="btn btn-primary pointer-events-auto h-12 rounded-2xl px-5 font-cute text-[15px] font-bold shadow-lg" onClick={g.endTurn} disabled={!!busy}>
        {last ? '🌊 ปล่อยน้ำ — จบรอบ' : `✅ จบเทิร์น ${team.name} → ทีมต่อไป`}
      </button>
    </div>
  );
}
