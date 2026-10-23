import { useEffect, useRef, useState } from 'react';
import type { Layers } from '../engine/Engine';
import { useGame } from '../game/store';
import { getEngine, useApp } from '../store';
import { num } from './format';
import { IconDb, IconLayers } from './icons';

export function TopBar() {
  const db = useApp((s) => s.db);
  const city = useApp((s) => s.city);
  const places = useApp((s) => s.places.length);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);

  return (
    <header className="pointer-events-none flex items-start justify-between gap-3">
      <div className="glass pointer-events-auto flex min-w-0 items-center gap-3 rounded-2xl px-3.5 py-2 max-sm:gap-2 max-sm:px-2.5">
        <span className="grid h-10 w-10 flex-none place-items-center rounded-2xl bg-gradient-to-b from-[#d6ecff] to-[#8ccaf7] text-[22px] shadow-inner max-sm:h-8 max-sm:w-8 max-sm:text-[18px]" aria-hidden="true">
          <span className="bob">🌊</span>
        </span>
        <div className="min-w-0 leading-tight">
          <h1 className="truncate font-cute text-[16px] font-bold max-sm:text-[14px]">
            หาดใหญ่จำลอง <span className="text-accent max-[400px]:hidden">น้ำท่วม</span>
          </h1>
          <p className="text-[11px] text-ink-3 max-sm:hidden">
            {city ? `🏠 ${num(city.meta.buildings.count)} หลัง · 📍 ${num(places)} สถานที่ · 🗺️ ${num(city.meta.width / 1000, 1)}×${num(city.meta.height / 1000, 1)} กม.` : 'Hat Yai Flood Simulator'}
          </p>
        </div>
      </div>

      <div className="pointer-events-auto flex flex-none items-start gap-2 max-sm:gap-1.5">
        <div
          className="glass flex h-10 items-center gap-2 rounded-xl px-3 text-[12px] max-sm:px-2.5"
          title={db === 'supabase' ? 'เชื่อมต่อ Supabase local แล้ว — สถานการณ์และผลการรันถูกบันทึกในฐานข้อมูล' : 'ไม่พบ Supabase — บันทึกไว้ในเบราว์เซอร์แทน (รัน npm run db:start)'}
        >
          <IconDb size={15} className="text-ink-2" />
          <span className={`h-2 w-2 rounded-full ${db === 'supabase' ? 'bg-good' : db === 'checking' ? 'bg-ink-3' : 'bg-warning'}`} />
          <span className="text-ink-2 max-sm:hidden">{db === 'supabase' ? 'Supabase' : db === 'checking' ? 'กำลังเชื่อมต่อ…' : 'ออฟไลน์ (เบราว์เซอร์)'}</span>
        </div>
        <button type="button" className="btn btn-primary rounded-xl px-3 font-cute font-bold" onClick={() => useGame.getState().open()} title="เกมกระดานกู้ภัยน้ำท่วม">
          🎲 <span className="max-sm:hidden">เล่นเกม</span>
        </button>
        <div ref={ref} className="relative">
          <button type="button" className="btn glass rounded-xl" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            <IconLayers /> <span className="max-sm:hidden">ชั้นข้อมูล</span>
          </button>
          {open && <LayerMenu />}
        </div>
        <button type="button" className="btn glass rounded-xl px-2.5" onClick={() => useApp.setState({ showWelcome: true })} aria-label="วิธีใช้งาน" title="วิธีใช้งาน">
          ❓
        </button>
      </div>
    </header>
  );
}

function LayerMenu() {
  const layers = useApp((s) => s.layers);
  const set = useApp.getState().setLayer;
  return (
    <div className="glass absolute right-0 top-11 z-30 flex w-[330px] flex-col gap-3 rounded-2xl p-3 text-[12.5px]">
      <Segmented
        label="การแสดงน้ำ"
        value={layers.waterMode}
        onChange={(v) => set('waterMode', v)}
        options={[
          ['realistic', 'สมจริง'],
          ['depth', 'แผนที่ความลึก'],
          ['maxdepth', 'ท่วมสูงสุด'],
        ]}
      />
      <Segmented
        label="สีอาคารตามความลึกน้ำ"
        value={layers.impact}
        onChange={(v) => set('impact', v)}
        options={[
          ['off', 'ปิด'],
          ['current', 'ตอนนี้'],
          ['max', 'สูงสุด'],
        ]}
      />
      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        <Toggle label="ไฮไลต์อาคารที่ถูกน้ำท่วม" k="highlight" layers={layers} />
        <Toggle label="อาคาร 3 มิติ" k="buildings" layers={layers} />
        <Toggle label="ถนน" k="roads" layers={layers} />
        <Toggle label="ต้นไม้" k="trees" layers={layers} />
        <Toggle label="เงาแดด" k="shadows" layers={layers} />
        <Toggle label="ภาพดาวเทียม" k="imagery" layers={layers} />
        <Toggle label="เม็ดฝน/ฟ้าแลบ" k="rain" layers={layers} />
        <Toggle label="สถานที่สำคัญ" k="keyPlaces" layers={layers} />
        <Toggle label="ชื่อคลอง" k="canalNames" layers={layers} />
        <Toggle label="ชื่อถนน" k="roadNames" layers={layers} />
        <Toggle label="จุดหลัก/น้ำเข้า" k="labels" layers={layers} />
        <Toggle label="ชื่อชุมชน" k="places" layers={layers} />
        <Toggle label="กลางวัน/กลางคืนจริง" k="realLight" layers={layers} />
      </div>
      <div className="flex gap-2 border-t border-line pt-2.5">
        <button type="button" className="btn flex-1" onClick={() => getEngine()?.overview()}>
          ภาพรวมเมือง
        </button>
        <button type="button" className="btn flex-1" onClick={() => getEngine()?.flyToPoi('kimyong')}>
          ใจกลางเมือง
        </button>
      </div>
      <p className="border-t border-line pt-2 text-[10.5px] leading-snug text-ink-3">
        ภูมิประเทศ Copernicus GLO-30 © DLR/Airbus (ESA) · อาคาร ถนน คลอง สถานที่ © ผู้ร่วมพัฒนา OpenStreetMap (ODbL) · ภาพถ่าย Esri, Maxar, Earthstar
        Geographics · สถานีวัดน้ำ ThaiWater/สสน., กรมชลประทาน · ฝน Open-Meteo/ERA5 · น้ำท่า GloFAS
      </p>
    </div>
  );
}

function Toggle({ label, k, layers }: { label: string; k: keyof Layers; layers: Layers }) {
  const on = Boolean(layers[k]);
  return (
    <label className="flex cursor-pointer items-center justify-between gap-2">
      <span className="text-ink-2">{label}</span>
      <input type="checkbox" className="h-4 w-4 accent-[#2a78d6]" checked={on} onChange={(e) => useApp.getState().setLayer(k, e.target.checked as never)} />
    </label>
  );
}

function Segmented<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (v: T) => void; options: [T, string][] }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] text-ink-3">{label}</span>
      <div className="flex rounded-lg border border-line bg-card p-0.5" role="radiogroup" aria-label={label}>
        {options.map(([v, l]) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={value === v}
            className={`flex-1 rounded-md px-2 py-1 text-[12px] ${value === v ? 'bg-accent text-white' : 'text-ink-2 hover:bg-hover'}`}
            onClick={() => onChange(v)}
          >
            {l}
          </button>
        ))}
      </div>
    </div>
  );
}
