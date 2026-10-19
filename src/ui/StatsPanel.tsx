import { useMemo } from 'react';
import { HOUR, intensityClass, sampleForcing, totalHours } from '../sim/scenario';
import { getEngine, useApp } from '../store';
import { depthLevel, LEVEL_COLOR, LEVEL_TEXT, num, simClock, thaiDateTime } from './format';
import { IconTarget } from './icons';
import { TimeChart, type ChartSeries } from './TimeChart';

export function StatsPanel() {
  const scenario = useApp((s) => s.scenario);
  const stats = useApp((s) => s.stats);
  const series = useApp((s) => s.series);
  const peaks = useApp((s) => s.peaks);
  const city = useApp((s) => s.city);
  const events = useApp((s) => s.events);

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

  const rainSeries: ChartSeries[] = [{ id: 'rain', label: 'ฝน', color: '#3987e5', kind: 'step-area', points: plan.rain, progress: true }];
  const inflowSeries: ChartSeries[] = [{ id: 'inflow', label: 'น้ำไหลเข้า', color: '#d95926', kind: 'line', points: plan.inflow, progress: true }];
  const areaSeries: ChartSeries[] = [{ id: 'area', label: 'พื้นที่น้ำท่วม', color: '#3987e5', kind: 'line', points: series.map((p) => ({ t: p.t, v: p.area })) }];
  const gaugeSeries: ChartSeries[] = [{ id: 'sim', label: 'จำลอง', color: '#3987e5', kind: 'line', points: series.map((p) => ({ t: p.t, v: p.gauges?.x44 ?? null })) }];
  if (observed) gaugeSeries.push({ id: 'obs', label: 'ตรวจวัดจริง', color: '#d95926', kind: 'line', dashed: true, points: observed });

  return (
    <div className="flex h-full flex-col gap-3">
      <div>
        <div className="text-[11px] uppercase tracking-wide text-ink-3">เวลาในแบบจำลอง</div>
        <div className="tabular text-[15px] font-semibold leading-tight">{thaiDateTime(date)}</div>
        <div className="mt-1 flex items-center gap-2 text-[12px] text-ink-2">
          <span className="inline-block h-2.5 w-2.5 flex-none rounded-sm" style={{ background: phase?.color }} />
          <span className="truncate">
            เฟส {(stats?.phaseIndex ?? 0) + 1}/{scenario.phases.length}: {phase?.name}
          </span>
        </div>
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/10">
          <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, (now / Math.max(total, 1)) * 100)}%` }} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Kpi label="ฝนตอนนี้" value={num(rainNow, rainNow < 10 ? 1 : 0)} unit="มม./ชม." sub={intensityClass(rainNow).label} />
        <Kpi label="ฝนสะสม" value={num(stats?.cumulativeRainMm ?? 0)} unit="มม." />
        <Kpi label="น้ำไหลเข้าเมือง" value={num(stats?.inflowM3s ?? 0)} unit="ลบ.ม./วิ" sub="อู่ตะเภา + คลองหวะ" />
        <Kpi label="พื้นที่น้ำท่วม >10 ซม." value={num(stats?.floodedKm2 ?? 0, 1)} unit="ตร.กม." sub={`ลึก >50 ซม. ${num(stats?.deepKm2 ?? 0, 1)} · สูงสุด ${num(peaks.area, 1)}`} />
        <Kpi label="ความลึกสูงสุดในชุมชน" value={num(stats?.maxDepth ?? 0, 2)} unit="ม." sub={`สูงสุดทั้งเหตุการณ์ ${num(peaks.depth, 1)} ม.`} />
        <Kpi
          label="อาคารถูกน้ำท่วม >30 ซม."
          value={num(stats?.buildingsAffected ?? 0)}
          unit="หลัง"
          sub={`>1.5 ม. ${num(stats?.buildingsSevere ?? 0)} · จาก ${num(city?.meta.buildings.count ?? 0)}`}
        />
      </div>

      <DrainBar efficiency={stats?.drainEfficiency ?? 1} fill={stats?.canalFill ?? 0} />

      <div className="flex flex-col gap-2.5">
        <TimeChart title="ปริมาณฝน (ค่าเฉลี่ยพื้นที่)" unit="มม./ชม." total={total} now={now} startIso={scenario.start_time} series={rainSeries} />
        <TimeChart title="น้ำไหลเข้าจากต้นน้ำ" unit="ลบ.ม./วิ" total={total} now={now} startIso={scenario.start_time} series={inflowSeries} digits={0} />
        <TimeChart title="พื้นที่น้ำท่วม >10 ซม." unit="ตร.กม." total={total} now={now} startIso={scenario.start_time} series={areaSeries} />
        {x44 && (
          <TimeChart
            title={`ระดับน้ำ ${x44.code} ${x44.name.split(' ')[0]}`}
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
        <div className="mb-1.5 text-[12px] font-medium">จุดสำคัญในเมือง</div>
        <ul className="flex flex-col gap-1">
          {(stats?.pois ?? city?.meta.pois.map((p) => ({ id: p.id, name: p.name, depth: 0, maxDepth: 0 })) ?? []).map((p) => {
            const lv = depthLevel(p.depth);
            return (
              <li key={p.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-white/5"
                  onClick={() => getEngine()?.flyToPoi(p.id)}
                  title="ซูมไปที่จุดนี้"
                >
                  <span className="inline-flex w-[70px] flex-none items-center gap-1 text-[11px] font-medium" style={{ color: LEVEL_COLOR[lv] }}>
                    <StatusIcon level={lv} />
                    {LEVEL_TEXT[lv]}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12.5px]">{p.name}</span>
                  <span className="tabular flex-none text-right text-[12px]">
                    <span className="font-semibold text-ink">{p.depth >= 0.05 ? `${num(p.depth, 2)} ม.` : 'แห้ง'}</span>
                    <span className="block text-[10.5px] text-ink-3">สูงสุด {num(p.maxDepth, 2)} ม.</span>
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
    <div className="rounded-xl border border-line bg-white/[0.03] px-2.5 py-2 text-[11.5px]">
      <div className="flex items-baseline justify-between">
        <span className="text-ink-2">ระดับน้ำในคลอง (เทียบตลิ่ง)</span>
        <span className="tabular font-semibold">{pct}%</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: pct >= 80 ? 'var(--color-critical)' : pct >= 60 ? 'var(--color-serious)' : 'var(--color-accent)' }} />
      </div>
      <div className="mt-1 text-[10.5px] text-ink-3">
        ท่อระบายน้ำในเมืองทำงาน <b className="tabular text-ink">{eff}%</b>
        {eff < 50 ? ' — คลองเต็ม น้ำฝนระบายไม่ได้ ถนนเริ่มท่วม' : ''}
      </div>
    </div>
  );
}

function Kpi({ label, value, unit, sub }: { label: string; value: string; unit: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-line bg-white/[0.03] px-2.5 py-2">
      <div className="truncate text-[11px] text-ink-2">{label}</div>
      <div className="tabular mt-0.5 flex items-baseline gap-1">
        <span className="text-[19px] font-semibold leading-none">{value}</span>
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
        <path d="M3.5 6.2l1.7 1.6 3.3-3.4" stroke="#0b0d11" strokeWidth="1.5" fill="none" />
      </svg>
    );
  if (level === 'warning')
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M6 1l5 9.5H1z" fill="currentColor" />
        <path d="M6 4.3v3M6 8.6v.1" stroke="#0b0d11" strokeWidth="1.4" />
      </svg>
    );
  if (level === 'serious')
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <rect x="1.2" y="1.2" width="9.6" height="9.6" rx="2" fill="currentColor" />
        <path d="M6 3.4v3.4M6 8.4v.1" stroke="#0b0d11" strokeWidth="1.4" />
      </svg>
    );
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M4 1h4l3 3v4l-3 3H4L1 8V4z" fill="currentColor" />
      <path d="M4.2 4.2l3.6 3.6M7.8 4.2L4.2 7.8" stroke="#0b0d11" strokeWidth="1.4" />
    </svg>
  );
}
