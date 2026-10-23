import { useMemo, useState } from 'react';
import { bankPoints } from '../sim/random';
import { createRng } from '../sim/rng';
import { formatDuration, intensityClass, PATTERN_LABELS, totalHours, WIND_NAMES } from '../sim/scenario';
import type { EventType, Phase, PhaseEvent, RainPattern } from '../sim/types';
import { useApp } from '../store';
import { num } from './format';
import { IconCloud, IconCopy, IconDice, IconDown, IconHistory, IconPlus, IconSave, IconTrash, IconUp, IconX } from './icons';

const SOURCE_GROUPS: { key: string; label: string; match: (s: string) => boolean }[] = [
  { key: 'historical', label: 'เหตุการณ์จริง (ข้อมูลตรวจวัด)', match: (s) => s === 'historical' },
  { key: 'preset', label: 'สถานการณ์ตั้งต้น', match: (s) => s === 'preset' },
  { key: 'mine', label: 'ที่บันทึกไว้ (สุ่ม / พยากรณ์ / สร้างเอง)', match: (s) => !['historical', 'preset'].includes(s) },
];

export function ScenarioPanel() {
  const scenario = useApp((s) => s.scenario);
  const saved = useApp((s) => s.saved);
  const dirty = useApp((s) => s.dirty);
  const busy = useApp((s) => s.busy);
  const db = useApp((s) => s.db);
  const selected = useApp((s) => s.selectedPhase);
  const a = useApp.getState();
  const [histOpen, setHistOpen] = useState(false);
  const [histDate, setHistDate] = useState('2025-11-19');
  const [histDays, setHistDays] = useState(7);
  const hours = totalHours(scenario);
  const rainTotal = scenario.phases.reduce((s, p) => s + p.rain_mm_hr * p.duration_hours, 0) * (scenario.settings.rain_bias ?? 1);

  return (
    <div className="flex flex-col gap-3">
      <section className="flex flex-col gap-2">
        <label className="text-[11px] uppercase tracking-wide text-ink-3" htmlFor="scenario-select">
          สถานการณ์
        </label>
        <select
          id="scenario-select"
          className="field"
          value={scenario.id ?? ''}
          onChange={(e) => e.target.value && void a.loadSaved(e.target.value)}
        >
          {!scenario.id && <option value="">{scenario.name} (ยังไม่บันทึก)</option>}
          {SOURCE_GROUPS.map((g) => {
            const items = saved.filter((s) => g.match(s.source));
            if (!items.length) return null;
            return (
              <optgroup key={g.key} label={g.label}>
                {items.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.phases} เฟส
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>
        <div className="grid grid-cols-2 gap-1.5">
          <button type="button" className="btn btn-primary" onClick={() => a.randomize()} disabled={Boolean(busy)}>
            <IconDice /> สุ่มน้ำท่วม
          </button>
          <button type="button" className="btn" onClick={() => void a.loadForecast()} disabled={Boolean(busy)} title="Open-Meteo + GloFAS ปรับเทียบกับสถานีวัดน้ำปัจจุบัน">
            <IconCloud /> พยากรณ์ 7 วัน
          </button>
          <button type="button" className="btn" onClick={() => setHistOpen((v) => !v)} disabled={Boolean(busy)} aria-expanded={histOpen}>
            <IconHistory /> ย้อนเหตุการณ์
          </button>
          <button
            type="button"
            className="btn"
            onClick={() =>
              a.setScenario(
                {
                  name: 'สถานการณ์ใหม่',
                  description: '',
                  source: 'custom',
                  seed: Math.floor(Math.random() * 1e6),
                  start_time: new Date().toISOString(),
                  settings: { initial_inflow_m3s: 50, initial_lake_m: 0.85 },
                  phases: [
                    { ...scenario.phases[0], id: crypto.randomUUID(), name: 'ฝนเริ่มตก', duration_hours: 6, rain_mm_hr: 8, events: [] },
                  ],
                },
                { keepDirty: true },
              )
            }
          >
            <IconPlus /> สร้างใหม่
          </button>
        </div>
        {histOpen && (
          <div className="flex flex-col gap-2 rounded-xl border border-line bg-card p-2.5">
            <div className="text-[11.5px] leading-snug text-ink-2">
              ดึงฝนรายชั่วโมง (ERA5 ปรับเทียบสถานีสนามบินหาดใหญ่) และน้ำท่าจริงจากสถานี X.90 + X.174 ของกรมชลประทานผ่าน ThaiWater
            </div>
            <div className="flex gap-2">
              <input type="date" className="field" value={histDate} max={new Date(Date.now() - 6 * 86400_000).toISOString().slice(0, 10)} onChange={(e) => setHistDate(e.target.value)} aria-label="วันที่เริ่ม" />
              <select className="field w-28" value={histDays} onChange={(e) => setHistDays(Number(e.target.value))} aria-label="จำนวนวัน">
                {[2, 3, 5, 7, 10, 14].map((d) => (
                  <option key={d} value={d}>
                    {d} วัน
                  </option>
                ))}
              </select>
            </div>
            <button type="button" className="btn btn-primary" disabled={Boolean(busy)} onClick={() => void a.loadHistorical(histDate, histDays).then(() => setHistOpen(false))}>
              ดึงข้อมูลและสร้างเฟส
            </button>
          </div>
        )}
        {busy && <div className="animate-pulse text-[12px] text-ink-2">{busy}</div>}
      </section>

      <section className="flex flex-col gap-2 rounded-xl border border-line bg-card p-2.5">
        <input className="field text-[14px] font-semibold" value={scenario.name} onChange={(e) => a.patchScenario({ name: e.target.value })} aria-label="ชื่อสถานการณ์" />
        {scenario.description && <p className="max-h-24 overflow-auto text-[11.5px] leading-snug text-ink-2 scroll-thin">{scenario.description}</p>}
        <div className="grid grid-cols-2 gap-2 text-[12px]">
          <Field label="เริ่มเวลา">
            <input
              type="datetime-local"
              className="field"
              value={toLocalInput(scenario.start_time)}
              onChange={(e) => e.target.value && a.patchScenario({ start_time: new Date(`${e.target.value}:00+07:00`).toISOString() })}
            />
          </Field>
          <Field label="Seed สุ่ม">
            <div className="flex gap-1">
              <input type="number" className="field" value={scenario.seed} onChange={(e) => a.patchScenario({ seed: Number(e.target.value) || 0 })} />
              <button type="button" className="btn px-2" title="สุ่มสถานการณ์ใหม่จาก seed นี้" onClick={() => a.randomize(scenario.seed)}>
                <IconDice />
              </button>
            </div>
          </Field>
          <Field label={`ตัวคูณฝน ×${num(scenario.settings.rain_bias ?? 1, 2)}`}>
            <input type="range" min={0.3} max={2.5} step={0.05} value={scenario.settings.rain_bias ?? 1} onChange={(e) => a.patchSettings({ rain_bias: Number(e.target.value) })} className="w-full" />
          </Field>
          <Field label="น้ำไหลเข้าเริ่มต้น">
            <div className="flex items-center gap-1">
              <input type="number" className="field" min={0} value={scenario.settings.initial_inflow_m3s ?? scenario.phases[0]?.upstream_inflow_m3s ?? 0} onChange={(e) => a.patchSettings({ initial_inflow_m3s: Number(e.target.value) })} />
              <span className="text-[11px] text-ink-3">ม³/วิ</span>
            </div>
          </Field>
        </div>
        <div className="flex items-center justify-between gap-2">
          <div className="text-[11.5px] text-ink-3">
            รวม {formatDuration(hours)} · ฝน ~{num(rainTotal)} มม.
          </div>
          <button type="button" className={`btn ${dirty ? 'btn-primary' : ''}`} onClick={() => void a.saveCurrent()} disabled={Boolean(busy)} title={db === 'supabase' ? 'บันทึกลง Supabase' : 'บันทึกในเบราว์เซอร์'}>
            <IconSave /> {dirty ? 'บันทึก' : 'บันทึกแล้ว'}
          </button>
        </div>
      </section>

      <section className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between">
          <h2 className="text-[13px] font-semibold">เฟสของเหตุการณ์ ({scenario.phases.length})</h2>
          <span className="text-[11px] text-ink-3">คลิกเพื่อแก้ไข</span>
        </div>
        <ol className="flex flex-col gap-1">
          {scenario.phases.map((p, i) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => a.selectPhase(selected === i ? null : i)}
                className={`flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors ${selected === i ? 'border-accent/60 bg-accent/10' : 'border-transparent hover:bg-hover'}`}
                aria-expanded={selected === i}
              >
                <span className="h-7 w-1.5 flex-none rounded-full" style={{ background: p.color }} />
                <span className="w-5 flex-none text-[11px] text-ink-3 tabular">{i + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium">{p.name}</span>
                  <span className="block truncate text-[11px] text-ink-3 tabular">
                    {formatDuration(p.duration_hours)} · ฝน {num(p.rain_mm_hr, 1)} มม./ชม. · น้ำเข้า {num(p.upstream_inflow_m3s)} ม³/วิ
                    {p.events.length ? ` · ⚠ ${p.events.length}` : ''}
                  </span>
                </span>
              </button>
              {selected === i && <PhaseEditor index={i} phase={p} />}
            </li>
          ))}
        </ol>
        <button type="button" className="btn btn-ghost justify-start text-ink-2" onClick={() => a.addPhase(selected ?? scenario.phases.length - 1)}>
          <IconPlus /> เพิ่มเฟส
        </button>
      </section>
    </div>
  );
}

function PhaseEditor({ index, phase }: { index: number; phase: Phase }) {
  const a = useApp.getState();
  const city = useApp((s) => s.city);
  const n = useApp((s) => s.scenario.phases.length);
  const banks = useMemo(() => (city ? bankPoints(city.waterways) : []), [city]);
  const up = (p: Partial<Phase>) => a.updatePhase(index, p);

  const addEvent = (type: EventType) => {
    const r = createRng(Date.now());
    let ev: PhaseEvent;
    if (type === 'surge') {
      const b = banks.length ? r.pick(banks) : { x: 0, y: 0, canal: 'คลอง' };
      ev = { type, at_hours: 0, duration_hours: Math.min(6, phase.duration_hours), magnitude: 150, x: Math.round(b.x), y: Math.round(b.y), label: `น้ำล้นตลิ่ง${b.canal}` };
    } else if (type === 'drain_block') ev = { type, at_hours: 0, duration_hours: phase.duration_hours, magnitude: 0.6, label: 'ท่อระบายน้ำอุดตัน' };
    else ev = { type, at_hours: 0, duration_hours: phase.duration_hours, magnitude: 0.3, label: 'ทะเลสาบหนุนสูง' };
    up({ events: [...phase.events, ev] });
  };

  return (
    <div className="mt-1 mb-2 flex flex-col gap-2.5 rounded-xl border border-line bg-card p-2.5 text-[12px]">
      <div className="flex gap-2">
        <input className="field flex-1" value={phase.name} onChange={(e) => up({ name: e.target.value })} aria-label="ชื่อเฟส" />
        <input type="color" className="h-[31px] w-9 flex-none cursor-pointer rounded-md border border-line bg-transparent" value={phase.color} onChange={(e) => up({ color: e.target.value })} aria-label="สีเฟส" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="ระยะเวลา (ชม.)">
          <input type="number" className="field" min={0.25} max={240} step={0.5} value={phase.duration_hours} onChange={(e) => up({ duration_hours: clamp(Number(e.target.value), 0.25, 240) })} />
        </Field>
        <Field label="ช่วงเปลี่ยนผ่าน (ชม.)">
          <input type="number" className="field" min={0} max={phase.duration_hours} step={0.25} value={phase.ramp_hours} onChange={(e) => up({ ramp_hours: clamp(Number(e.target.value), 0, phase.duration_hours) })} />
        </Field>
      </div>
      <Slider label="ฝน (ค่าเฉลี่ยพื้นที่)" unit="มม./ชม." min={0} max={150} step={0.5} value={phase.rain_mm_hr} onChange={(v) => up({ rain_mm_hr: v, color: phase.color === intensityClass(phase.rain_mm_hr).color ? intensityClass(v).color : phase.color })} hint={intensityClass(phase.rain_mm_hr).label} />
      <div className="grid grid-cols-2 gap-2">
        <Field label="รูปแบบฝน">
          <select className="field" value={phase.rain_pattern} onChange={(e) => up({ rain_pattern: e.target.value as RainPattern, storm_cells: e.target.value === 'storm_cells' ? Math.max(phase.storm_cells, 4) : phase.storm_cells })}>
            {Object.entries(PATTERN_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        {phase.rain_pattern === 'storm_cells' ? (
          <Field label="จำนวนกลุ่มเมฆฝน">
            <input type="number" className="field" min={1} max={16} value={phase.storm_cells} onChange={(e) => up({ storm_cells: clamp(Number(e.target.value), 1, 16) })} />
          </Field>
        ) : (
          <div />
        )}
      </div>
      <Slider label="ความแปรปรวนของฝน (สุ่ม)" unit="" min={0} max={1} step={0.05} value={phase.rain_variability} onChange={(v) => up({ rain_variability: v })} digits={2} />
      <div className="grid grid-cols-2 gap-2">
        <Field label="ลมพัดจากทิศ">
          <select className="field" value={Math.round(phase.wind_dir_deg / 45) % 8} onChange={(e) => up({ wind_dir_deg: Number(e.target.value) * 45 })}>
            {WIND_NAMES.map((w, k) => (
              <option key={w} value={k}>
                {w}
              </option>
            ))}
          </select>
        </Field>
        <Field label="ความเร็วพายุ (กม./ชม.)">
          <input type="number" className="field" min={0} max={80} value={phase.wind_speed_kmh} onChange={(e) => up({ wind_speed_kmh: clamp(Number(e.target.value), 0, 80) })} />
        </Field>
      </div>
      <Slider label="น้ำไหลเข้าจากต้นน้ำ ณ สิ้นเฟส" unit="ลบ.ม./วิ" min={0} max={4000} step={10} value={phase.upstream_inflow_m3s} onChange={(v) => up({ upstream_inflow_m3s: v })} digits={0} hint="ความจุคลอง ร.1 ≈1,200 · อู่ตะเภาในเมือง ≈465" />
      <div className="grid grid-cols-3 gap-2">
        <Field label="ทะเลสาบ (ม.รทก.)">
          <input type="number" className="field" min={0} max={3} step={0.05} value={phase.lake_level_m} onChange={(e) => up({ lake_level_m: clamp(Number(e.target.value), 0, 3) })} />
        </Field>
        <Field label="ท่อระบาย (มม./ชม.)">
          <input type="number" className="field" min={0} max={120} value={phase.drainage_mm_hr} onChange={(e) => up({ drainage_mm_hr: clamp(Number(e.target.value), 0, 120) })} />
        </Field>
        <Field label="ซึมลงดิน (มม./ชม.)">
          <input type="number" className="field" min={0} max={40} value={phase.infiltration_mm_hr} onChange={(e) => up({ infiltration_mm_hr: clamp(Number(e.target.value), 0, 40) })} />
        </Field>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="text-[11.5px] text-ink-2">เหตุการณ์พิเศษในเฟสนี้</div>
        {phase.events.map((ev, k) => (
          <div key={k} className="flex items-center gap-1.5 rounded-lg bg-card px-2 py-1">
            <span className="min-w-0 flex-1 truncate">
              {ev.label ?? ev.type} · ชม.ที่ {num(ev.at_hours, 1)}–{num(ev.at_hours + ev.duration_hours, 1)} ·{' '}
              {ev.type === 'surge' ? `${num(ev.magnitude)} ม³/วิ` : ev.type === 'drain_block' ? `ลดลง ${num(ev.magnitude * 100)}%` : `+${num(ev.magnitude, 2)} ม.`}
            </span>
            <button type="button" className="btn btn-ghost px-1 py-0.5" aria-label="ลบเหตุการณ์" onClick={() => up({ events: phase.events.filter((_, j) => j !== k) })}>
              <IconX size={13} />
            </button>
          </div>
        ))}
        <div className="flex flex-wrap gap-1">
          <button type="button" className="btn px-2 py-1 text-[11.5px]" onClick={() => addEvent('surge')}>
            + น้ำล้นตลิ่ง (สุ่มจุด)
          </button>
          <button type="button" className="btn px-2 py-1 text-[11.5px]" onClick={() => addEvent('drain_block')}>
            + ท่ออุดตัน
          </button>
          <button type="button" className="btn px-2 py-1 text-[11.5px]" onClick={() => addEvent('lake_surge')}>
            + ทะเลสาบหนุน
          </button>
        </div>
      </div>

      <div className="flex gap-1 border-t border-line pt-2">
        <button type="button" className="btn px-2" disabled={index === 0} onClick={() => a.movePhase(index, -1)} aria-label="เลื่อนขึ้น">
          <IconUp />
        </button>
        <button type="button" className="btn px-2" disabled={index === n - 1} onClick={() => a.movePhase(index, 1)} aria-label="เลื่อนลง">
          <IconDown />
        </button>
        <button type="button" className="btn px-2" onClick={() => a.duplicatePhase(index)}>
          <IconCopy /> ทำซ้ำ
        </button>
        <button type="button" className="btn ml-auto px-2 text-critical-ink" disabled={n <= 1} onClick={() => a.removePhase(index)}>
          <IconTrash /> ลบ
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="truncate text-[11px] text-ink-2">{label}</span>
      {children}
    </label>
  );
}

function Slider({ label, unit, min, max, step, value, onChange, digits = 1, hint }: { label: string; unit: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void; digits?: number; hint?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-ink-2">{label}</span>
        <span className="flex items-baseline gap-1">
          <input type="number" className="field w-20 py-0.5 text-right tabular" min={min} max={max} step={step} value={value} onChange={(e) => onChange(clamp(Number(e.target.value), min, max))} aria-label={label} />
          <span className="text-[11px] text-ink-3">{unit}</span>
        </span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={`${label} (${num(value, digits)} ${unit})`} />
      {hint && <span className="text-[10.5px] text-ink-3">{hint}</span>}
    </div>
  );
}

const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);

function toLocalInput(iso: string) {
  const d = new Date(Date.parse(iso) + 7 * 3600_000);
  return d.toISOString().slice(0, 16);
}
