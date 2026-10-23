import { useMemo, useState } from 'react';
import { HOUR, sampleForcing, totalHours } from '../sim/scenario';
import { getEngine, useApp } from '../store';
import { bodyLevel, depthLevel, LEVEL_INK, LEVEL_TEXT, num, rainLook, simClock, thaiDateTime } from './format';
import { IconTarget } from './icons';
import { TimeChart, type ChartSeries } from './TimeChart';
import { WaterBuddy } from './WaterBuddy';

const BLUE = '#2a78d6';
const ORANGE = '#eb6834';

export function StatsPanel() {
  const scenario = useApp((s) => s.scenario);
  const stats = useApp((s) => s.stats);
  const series = useApp((s) => s.series);
  const peaks = useApp((s) => s.peaks);
  const city = useApp((s) => s.city);
  const events = useApp((s) => s.events);
  const [buddy, setBuddy] = useState<string>('auto');

  const total = totalHours(scenario) * HOUR;
  const now = stats?.simTime ?? 0;

  const plan = useMemo(() => {
    const rain: { t: number; v: number }[] = [];
    const inflow: { t: number; v: number }[] = [];
    const step = Math.max(600, total / 400);
    for (let t = 0; t <= total; t += step) {
      const f = sampleForcing(scenario, Math.min(t, total - 1));
      rain.push({ t, v: f.rainMmHr });
      inflow.push({ t, v: f.inflowM3s });
    }
    return { rain, inflow };
  }, [scenario, total]);

  const observed = useMemo(() => {
    const ev = events.find((e) => e.id === scenario.settings.event_id);
    if (!ev?.observed.x44LevelM) return null;
    const offset = (Date.parse(ev.start) - Date.parse(scenario.start_time)) / 1000;
    return ev.observed.x44LevelM.map((v, i) => ({ t: offset + i * HOUR, v }));
  }, [events, scenario]);

  const x44 = city?.meta.gauges.find((g) => g.id === 'x44');
  const phase = scenario.phases[stats?.phaseIndex ?? 0];
  const date = simClock(scenario.start_time, now);
  const rainNow = stats?.rainMmHr ?? 0;
  const look = rainLook(rainNow);
  const pois = stats?.pois ?? city?.meta.pois.map((p) => ({ id: p.id, name: p.name, depth: 0, maxDepth: 0 })) ?? [];
  const watched = buddy === 'auto' ? [...pois].sort((a, b) => b.depth - a.depth || b.maxDepth - a.maxDepth)[0] : pois.find((p) => p.id === buddy);

  const rainSeries: ChartSeries[] = [{ id: 'rain', label: 'ฝน', color: BLUE, kind: 'step-area', points: plan.rain, progress: true }];
  const inflowSeries: ChartSeries[] = [{ id: 'inflow', label: 'น้ำไหลเข้า', color: ORANGE, kind: 'line', points: plan.inflow, progress: true }];
  const areaSeries: ChartSeries[] = [{ id: 'area', label: 'พื้นที่น้ำท่วม', color: BLUE, kind: 'line', points: series.map((p) => ({ t: p.t, v: p.area })) }];
  const gaugeSeries: ChartSeries[] = [{ id: 'sim', label: 'จำลอง', color: BLUE, kind: 'line', points: series.map((p) => ({ t: p.t, v: p.gauges?.x44 ?? null })) }];
  if (observed) gaugeSeries.push({ id: 'obs', label: 'ตรวจวัดจริง', color: ORANGE, kind: 'line', dashed: true, points: observed });

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center gap-3 rounded-2xl bg-gradient-to-br from-[#e7f2ff] to-[#fdf4ff] p-2.5">
        <div className="grid h-12 w-12 flex-none place-items-center rounded-2xl bg-white text-[28px] shadow-sm" aria-hidden="true">
          {look.emoji}
        </div>
        <div className="min-w-0">
          <div className="tabular font-cute text-[15px] font-bold leading-tight">{thaiDateTime(date)}</div>
          <div className="truncate text-[12px] text-ink-2">
            {look.text} · เฟส {(stats?.phaseIndex ?? 0) + 1}/{scenario.phases.length}: {phase?.name}
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white">
            <div className="h-full rounded-full bg-gradient-to-r from-[#7cc4ff] to-[#2a78d6]" style={{ width: `${Math.min(100, (now / Math.max(total, 1)) * 100)}%` }} />
          </div>
        </div>
      </div>

      {watched && (
        <div className="flex flex-col gap-1.5">
          <WaterBuddy depth={watched.depth} maxDepth={watched.maxDepth} place={watched.name} />
          <select className="field py-1 text-[12px]" value={buddy} onChange={(e) => setBuddy(e.target.value)} aria-label="เลือกจุดที่จะดูระดับน้ำ">
            <option value="auto">ดูจุดที่น้ำลึกที่สุดอัตโนมัติ</option>
            {pois.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Kpi emoji="🌧️" label="ฝนตอนนี้" value={num(rainNow, rainNow < 10 ? 1 : 0)} unit="มม./ชม." sub={look.text} />
        <Kpi emoji="🪣" label="ฝนสะสม" value={num(stats?.cumulativeRainMm ?? 0)} unit="มม." />
        <Kpi emoji="🌊" label="น้ำไหลเข้าเมือง" value={num(stats?.inflowM3s ?? 0)} unit="ลบ.ม./วิ" sub="อู่ตะเภา + คลองหวะ" />
        <Kpi emoji="🗺️" label="พื้นที่น้ำท่วม" value={num(stats?.floodedKm2 ?? 0, 1)} unit="ตร.กม." sub={`ลึกเกินเข่า ${num(stats?.deepKm2 ?? 0, 1)} · สูงสุด ${num(peaks.area, 1)}`} />
        <Kpi emoji="📏" label="ลึกสุดในชุมชน" value={num(stats?.maxDepth ?? 0, 2)} unit="ม." sub={`ถึง${bodyLevel(stats?.maxDepth ?? 0).text} · สูงสุด ${num(peaks.depth, 1)} ม.`} />
        <Kpi emoji="🏠" label="บ้านน้ำเข้า (>30 ซม.)" value={num(stats?.buildingsAffected ?? 0)} unit="หลัง" sub={`มิดชั้นล่าง ${num(stats?.buildingsSevere ?? 0)} · จาก ${num(city?.meta.buildings.count ?? 0)}`} />
      </div>

      <DrainBar efficiency={stats?.drainEfficiency ?? 1} fill={stats?.canalFill ?? 0} />

      <div className="flex flex-col gap-2.5">
        <TimeChart title="🌧️ ปริมาณฝน (เฉลี่ยทั้งพื้นที่)" unit="มม./ชม." total={total} now={now} startIso={scenario.start_time} series={rainSeries} />
        <TimeChart title="🌊 น้ำไหลเข้าจากต้นน้ำ" unit="ลบ.ม./วิ" total={total} now={now} startIso={scenario.start_time} series={inflowSeries} digits={0} />
        <TimeChart title="🗺️ พื้นที่น้ำท่วม >10 ซม." unit="ตร.กม." total={total} now={now} startIso={scenario.start_time} series={areaSeries} />
        {x44 && (
          <TimeChart
            title={`📈 ระดับน้ำ ${x44.code} ${x44.name.split(' ')[0]}`}
            unit="ม.รทก."
            total={total}
            now={now}
            startIso={scenario.start_time}
            series={gaugeSeries}
            refs={[
              { v: x44.watch, label: `เฝ้าระวัง ${x44.watch}` },
              { v: x44.critical, label: `วิกฤต/ล้นตลิ่ง ${x44.critical}` },
            ]}
            digits={2}
            yMin={-1}
          />
        )}
      </div>

      <div>
        <div className="mb-1.5 font-cute text-[14px] font-bold">📍 จุดหลักในเมือง</div>
        <ul className="flex flex-col gap-0.5">
          {pois.map((p) => {
            const lv = depthLevel(p.depth);
            const b = bodyLevel(p.depth);
            return (
              <li key={p.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left hover:bg-hover"
                  onClick={() => {
                    getEngine()?.flyToPoi(p.id);
                    setBuddy(p.id);
                  }}
                  title="ซูมไปที่จุดนี้"
                >
                  <span className="inline-flex w-[68px] flex-none items-center gap-1 text-[11px] font-semibold" style={{ color: LEVEL_INK[lv] }}>
                    <StatusIcon level={lv} />
                    {LEVEL_TEXT[lv]}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12.5px]">{p.name}</span>
                  <span className="tabular flex-none text-right text-[12px]">
                    <span className="font-semibold text-ink">{p.depth >= 0.05 ? `${num(p.depth, 2)} ม. ${b.emoji}` : 'แห้ง'}</span>
                    <span className="block text-[10.5px] text-ink-3">{p.depth >= 0.05 ? `ถึง${b.text}` : `สูงสุด ${num(p.maxDepth, 2)} ม.`}</span>
                  </span>
                  <IconTarget size={14} className="flex-none text-ink-3" />
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="mt-auto text-[10.5px] leading-relaxed text-ink-3">
        ตัวแก้สมการ: shallow water แบบ local-inertial (LISFLOOD-FP) บน GPU · กริด {city?.meta.cell} ม. ({num((city?.meta.nx ?? 0) * (city?.meta.ny ?? 0))} เซลล์) ·{' '}
        <span className="tabular">{num(stats?.stepsPerSecond ?? 0)} ก้าว/วิ, Δt {num(stats?.dt ?? 0, 2)} วิ</span>
      </div>
    </div>
  );
}

/** Canal fill vs storm-drain function: the mechanism that turns heavy rain into street flooding. */
function DrainBar({ efficiency, fill }: { efficiency: number; fill: number }) {
  const pct = Math.round(Math.min(1, fill) * 100);
  const eff = Math.round(efficiency * 100);
  return (
    <div className="rounded-2xl border border-line bg-card px-3 py-2 text-[11.5px]">
      <div className="flex items-baseline justify-between">
        <span className="text-ink-2">〰 น้ำในคลอง (เทียบตลิ่ง)</span>
        <span className="tabular font-cute text-[14px] font-bold">{pct}%</span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-white">
        <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${pct}%`, background: pct >= 80 ? 'var(--color-critical)' : pct >= 60 ? 'var(--color-serious)' : 'linear-gradient(90deg,#7cc4ff,#2a78d6)' }} />
      </div>
      <div className="mt-1 text-[11px] text-ink-2">
        🚰 ท่อระบายน้ำทำงาน <b className="tabular text-ink">{eff}%</b>
        {eff < 50 ? ' — คลองเต็มแล้ว น้ำฝนระบายไม่ทัน ถนนเริ่มท่วม' : ''}
      </div>
    </div>
  );
}

function Kpi({ emoji, label, value, unit, sub }: { emoji: string; label: string; value: string; unit: string; sub?: string }) {
  return (
    <div className="rounded-2xl border border-line bg-card px-2.5 py-2">
      <div className="flex items-center gap-1 truncate text-[11px] text-ink-2">
        <span aria-hidden="true">{emoji}</span>
        {label}
      </div>
      <div className="tabular mt-0.5 flex items-baseline gap-1">
        <span className="font-cute text-[21px] font-bold leading-none">{value}</span>
        <span className="text-[11px] text-ink-3">{unit}</span>
      </div>
      {sub && <div className="mt-0.5 truncate text-[10.5px] text-ink-3">{sub}</div>}
    </div>
  );
}

export function StatusIcon({ level }: { level: keyof typeof LEVEL_TEXT }) {
  if (level === 'good')
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <circle cx="6" cy="6" r="5" fill="currentColor" />
        <path d="M3.5 6.2l1.7 1.6 3.3-3.4" stroke="#fff" strokeWidth="1.5" fill="none" />
      </svg>
    );
  if (level === 'warning')
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M6 1l5 9.5H1z" fill="currentColor" />
        <path d="M6 4.3v3M6 8.6v.1" stroke="#fff" strokeWidth="1.4" />
      </svg>
    );
  if (level === 'serious')
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <rect x="1.2" y="1.2" width="9.6" height="9.6" rx="2" fill="currentColor" />
        <path d="M6 3.4v3.4M6 8.4v.1" stroke="#fff" strokeWidth="1.4" />
      </svg>
    );
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M4 1h4l3 3v4l-3 3H4L1 8V4z" fill="currentColor" />
      <path d="M4.2 4.2l3.6 3.6M7.8 4.2L4.2 7.8" stroke="#fff" strokeWidth="1.4" />
    </svg>
  );
}
