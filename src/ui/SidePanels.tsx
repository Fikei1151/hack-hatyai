import { useEffect } from 'react';
import { DEPTH_RAMP } from '../engine/glsl';
import { useApp } from '../store';
import { LEVEL_COLOR, LEVEL_TEXT, num, thaiShort } from './format';
import { StatusIcon } from './StatsPanel';
import { IconCloud, IconTrash } from './icons';

export function RunsPanel() {
  const runs = useApp((s) => s.runs);
  const db = useApp((s) => s.db);
  const a = useApp.getState();
  useEffect(() => {
    void a.refreshLists();
  }, [a]);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11.5px] leading-snug text-ink-2">
        ทุกครั้งที่กดเริ่มจำลอง ระบบบันทึกค่าสูงสุดและกราฟเวลาไว้ใน{db === 'supabase' ? 'ตาราง simulation_runs บน Supabase' : 'เบราว์เซอร์ (ออฟไลน์)'}
      </p>
      {!runs.length && <div className="rounded-xl border border-dashed border-line p-4 text-center text-[12px] text-ink-3">ยังไม่มีผลการรัน — กด ▶ เพื่อเริ่ม</div>}
      <ul className="flex flex-col gap-1.5">
        {runs.map((r) => (
          <li key={r.id} className="rounded-xl border border-line bg-white/[0.03] p-2.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-[12.5px] font-medium">{r.scenario_name}</div>
                <div className="text-[11px] text-ink-3">
                  {thaiShort(new Date(r.started_at))} · จำลอง {num(r.sim_hours, 1)} ชม. ·{' '}
                  <span className={r.status === 'completed' ? 'text-good' : r.status === 'running' ? 'text-warning' : 'text-ink-2'}>
                    {r.status === 'completed' ? 'ครบ' : r.status === 'running' ? 'กำลังรัน' : 'หยุดกลางทาง'}
                  </span>
                </div>
              </div>
              <button type="button" className="btn btn-ghost px-1.5 py-1 text-ink-3" onClick={() => void a.deleteRun(r.id)} aria-label="ลบผลการรัน">
                <IconTrash size={14} />
              </button>
            </div>
            <dl className="mt-1.5 grid grid-cols-4 gap-1 text-[11px]">
              <Stat k="ฝนรวม" v={`${num(r.total_rain_mm ?? 0)} มม.`} />
              <Stat k="ท่วมสูงสุด" v={`${num(r.peak_flood_area_km2 ?? 0, 1)} ตร.กม.`} />
              <Stat k="ลึกสุด" v={`${num(r.peak_depth_m ?? 0, 1)} ม.`} />
              <Stat k="อาคาร" v={num(r.buildings_affected ?? 0)} />
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-ink-3">{k}</dt>
      <dd className="tabular truncate font-medium text-ink">{v}</dd>
    </div>
  );
}

export function LivePanel() {
  const live = useApp((s) => s.live);
  const err = useApp((s) => s.liveError);
  const busy = useApp((s) => s.busy);
  const city = useApp((s) => s.city);
  const a = useApp.getState();
  useEffect(() => {
    void a.refreshLive();
    const t = setInterval(() => void a.refreshLive(), 5 * 60_000);
    return () => clearInterval(t);
  }, [a]);
  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-[11.5px] leading-snug text-ink-2">สถานการณ์น้ำล่าสุดจากสถานีโทรมาตรกรมชลประทาน (ThaiWater / สสน.) อัปเดตทุก 5 นาที</p>
      {err && <div className="rounded-lg bg-critical/15 px-2 py-1.5 text-[12px] text-[#ffc9c9]">ดึงข้อมูลไม่สำเร็จ: {err}</div>}
      {!live && !err && <div className="animate-pulse text-[12px] text-ink-3">กำลังโหลด…</div>}
      {live?.gauges.map((g) => {
        const def = city?.meta.gauges.find((x) => x.code === g.code);
        const bank = def?.critical ?? g.minBank ?? null;
        const pct = g.levelMsl !== null && bank ? Math.min(1, Math.max(0, g.levelMsl / bank)) : 0;
        return (
          <div key={g.code} className="rounded-xl border border-line bg-white/[0.03] p-2.5">
            <div className="flex items-baseline justify-between gap-2">
              <div className="truncate text-[12.5px] font-medium">
                {g.code} {g.name}
              </div>
              <div className="flex-none text-[10.5px] text-ink-3">{g.time.slice(5)}</div>
            </div>
            <div className="tabular mt-1 flex items-baseline gap-3 text-[12px]">
              <span>
                <b className="text-[17px]">{g.levelMsl === null ? '–' : num(g.levelMsl, 2)}</b> <span className="text-ink-3">ม.รทก.</span>
              </span>
              <span className="text-ink-2">{g.discharge === null ? '' : `${num(g.discharge, 1)} ลบ.ม./วิ`}</span>
            </div>
            {bank && (
              <div className="mt-1.5">
                <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full rounded-full bg-accent" style={{ width: `${pct * 100}%` }} />
                </div>
                <div className="mt-0.5 text-[10.5px] text-ink-3">ระดับวิกฤต/ตลิ่ง {num(bank, 2)} ม.รทก.</div>
              </div>
            )}
          </div>
        );
      })}
      {live && live.rain24h.length > 0 && (
        <div className="rounded-xl border border-line bg-white/[0.03] p-2.5">
          <div className="mb-1 text-[12px] font-medium">ฝนสะสม 24 ชม. รอบหาดใหญ่</div>
          <ul className="flex flex-col gap-0.5 text-[12px]">
            {live.rain24h.map((r) => (
              <li key={r.station} className="flex justify-between gap-2">
                <span className="truncate text-ink-2">{r.station}</span>
                <span className="tabular flex-none">{num(r.mm, 1)} มม.</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <button type="button" className="btn btn-primary" disabled={Boolean(busy)} onClick={() => void a.loadForecast().then(() => a.setPanel('scenario'))}>
        <IconCloud /> จำลองจากพยากรณ์ 7 วัน + สภาพปัจจุบัน
      </button>
    </div>
  );
}

export function DepthLegend() {
  const layers = useApp((s) => s.layers);
  if (layers.waterMode === 'realistic' && layers.impact === 'off') return layers.highlight ? <FloodStatusLegend /> : null;
  const title = layers.waterMode === 'maxdepth' || layers.impact === 'max' ? 'ความลึกน้ำสูงสุดที่เคยเกิด' : 'ความลึกน้ำ';
  return (
    <div className="glass pointer-events-auto rounded-xl px-3 py-2">
      <div className="mb-1 text-[11.5px] font-medium">{title} (ม.)</div>
      <div className="flex gap-[2px]">
        {DEPTH_RAMP.slice(0, -1).map((s, i) => (
          <div key={s.hex} className="flex w-11 flex-col gap-0.5">
            <div className="h-2.5 rounded-[3px]" style={{ background: `linear-gradient(90deg, ${s.hex}, ${DEPTH_RAMP[i + 1].hex})` }} />
            <span className="tabular text-[10.5px] text-ink-2">{s.label}</span>
          </div>
        ))}
        <div className="flex w-11 flex-col gap-0.5">
          <div className="h-2.5 rounded-[3px]" style={{ background: DEPTH_RAMP[DEPTH_RAMP.length - 1].hex }} />
          <span className="tabular text-[10.5px] text-ink-2">{DEPTH_RAMP[DEPTH_RAMP.length - 1].label}</span>
        </div>
      </div>
    </div>
  );
}

/** Roof colours of flooded buildings (status palette, always with a label). */
function FloodStatusLegend() {
  const rows: { level: 'warning' | 'serious' | 'critical'; text: string }[] = [
    { level: 'warning', text: '10–50 ซม.' },
    { level: 'serious', text: '0.5–1 ม.' },
    { level: 'critical', text: '>1 ม.' },
  ];
  return (
    <div className="glass pointer-events-auto rounded-xl px-3 py-2">
      <div className="mb-1 text-[11.5px] font-medium">หลังคาอาคารที่ถูกน้ำท่วม</div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
        {rows.map((r) => (
          <span key={r.level} className="inline-flex items-center gap-1.5 whitespace-nowrap" style={{ color: LEVEL_COLOR[r.level] }}>
            <StatusIcon level={r.level} />
            <span className="text-ink">
              {LEVEL_TEXT[r.level]} <span className="text-ink-3">{r.text}</span>
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function Toast() {
  const toast = useApp((s) => s.toast);
  if (!toast) return null;
  const tone = toast.kind === 'error' ? 'border-critical/50 text-[#ffd0d0]' : toast.kind === 'ok' ? 'border-good/50' : 'border-accent/50';
  return (
    <div role="status" className={`glass pointer-events-auto max-w-[420px] rounded-xl border px-3 py-2 text-[12.5px] ${tone}`}>
      {toast.text}
    </div>
  );
}
