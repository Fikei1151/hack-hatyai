import { useMemo, useState } from 'react';
import type { PlaceCategory } from '../engine/cityData';
import { PLACE_ICON } from '../engine/Labels';
import { ALL_CATEGORIES, getEngine, useApp } from '../store';
import { depthLevel, LEVEL_COLOR, LEVEL_TEXT, num } from './format';
import { StatusIcon } from './StatsPanel';

export const CATEGORY_TH: Record<PlaceCategory, string> = {
  health: 'โรงพยาบาล/สุขภาพ',
  emergency: 'ตำรวจ/ดับเพลิง',
  shelter: 'ศูนย์พักพิง/จุดรวมพล',
  education: 'สถานศึกษา',
  religion: 'ศาสนสถาน',
  market: 'ตลาด/ห้าง',
  government: 'หน่วยงานรัฐ',
  transport: 'คมนาคม',
  landmark: 'สวน/แหล่งสำคัญ',
  lodging: 'โรงแรม/ที่พัก',
};

const KIND_TH: Record<string, string> = {
  hospital: 'โรงพยาบาล',
  clinic: 'คลินิก',
  care_home: 'สถานดูแล',
  university: 'มหาวิทยาลัย/วิทยาลัย',
  school: 'โรงเรียน',
  kindergarten: 'โรงเรียนอนุบาล',
  temple: 'วัด',
  mosque: 'มัสยิด',
  church: 'โบสถ์',
  shrine: 'ศาลเจ้า/ศาสนสถาน',
  market: 'ตลาด',
  mall: 'ห้างสรรพสินค้า',
  supermarket: 'ซูเปอร์มาร์เก็ต',
  police: 'สถานีตำรวจ',
  fire_station: 'สถานีดับเพลิง',
  shelter: 'ที่พักพิง/จุดรวมพล',
  government: 'หน่วยงานราชการ',
  community_centre: 'ศูนย์ชุมชน',
  library: 'ห้องสมุด',
  post_office: 'ไปรษณีย์',
  rail_station: 'สถานีรถไฟ',
  bus_station: 'สถานีขนส่ง',
  airport: 'สนามบิน',
  hotel: 'โรงแรม',
  museum: 'พิพิธภัณฑ์',
  attraction: 'แหล่งท่องเที่ยว',
  park: 'สวนสาธารณะ',
  stadium: 'สนามกีฬา',
  sports_centre: 'ศูนย์กีฬา',
};

export const CATEGORY_COLOR: Record<PlaceCategory, string> = {
  health: '#d03b3b',
  emergency: '#eb6834',
  shelter: '#0ca30c',
  education: '#2a78d6',
  religion: '#c98500',
  market: '#d55181',
  government: '#6250d6',
  transport: '#199e70',
  landmark: '#6b7280',
  lodging: '#8b6f47',
};

export function PlacesPanel() {
  const places = useApp((s) => s.places);
  const source = useApp((s) => s.placesSource);
  const impact = useApp((s) => s.impact);
  const cats = useApp((s) => s.layers.placeCategories);
  const showOnMap = useApp((s) => s.layers.keyPlaces);
  const a = useApp.getState();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'depth' | 'importance'>('depth');

  const rows = useMemo(
    () =>
      places.map((p, i) => ({
        p,
        i,
        depth: impact?.depth[i] ?? 0,
        max: impact?.maxDepth[i] ?? 0,
        firstWet: impact?.firstWet[i] ?? -1,
      })),
    [places, impact],
  );

  const summary = useMemo(() => {
    const m = new Map<PlaceCategory, { total: number; wet: number; deep: number }>();
    for (const r of rows) {
      const e = m.get(r.p.category) ?? { total: 0, wet: 0, deep: 0 };
      e.total++;
      if (r.depth >= 0.1) e.wet++;
      if (r.depth >= 0.5) e.deep++;
      m.set(r.p.category, e);
    }
    return m;
  }, [rows]);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows
      .filter((r) => cats.includes(r.p.category))
      .filter((r) => !needle || r.p.name.toLowerCase().includes(needle) || (r.p.name_en ?? '').toLowerCase().includes(needle))
      .sort((x, y) => (sort === 'depth' ? y.depth - x.depth || y.max - x.max || y.p.importance - x.p.importance : y.p.importance - x.p.importance));
  }, [rows, cats, q, sort]);

  const wetTotal = rows.filter((r) => r.depth >= 0.1).length;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <div className="text-[13px] font-semibold">สถานที่สำคัญ {num(places.length)} แห่ง</div>
          <div className="text-[11px] text-ink-3">{source === 'supabase' ? 'จากตาราง places บน Supabase (OpenStreetMap)' : 'จาก OpenStreetMap (ไฟล์ในเครื่อง)'}</div>
        </div>
        <label className="flex items-center gap-1.5 text-[11.5px] text-ink-2">
          <input type="checkbox" className="h-4 w-4 accent-[#3987e5]" checked={showOnMap} onChange={(e) => a.setLayer('keyPlaces', e.target.checked)} />
          แสดงบนแผนที่
        </label>
      </div>

      <div className={`rounded-xl border px-2.5 py-2 text-[12px] ${wetTotal ? 'border-serious/50 bg-serious/10' : 'border-line bg-white/[0.03]'}`}>
        {wetTotal ? (
          <span>
            ขณะนี้ <b className="text-[14px]">{num(wetTotal)}</b> แห่งมีน้ำท่วมขัง ≥10 ซม. — ในจำนวนนี้ลึกเกิน 50 ซม. <b>{num(rows.filter((r) => r.depth >= 0.5).length)}</b> แห่ง
          </span>
        ) : (
          <span className="text-ink-2">ยังไม่มีสถานที่สำคัญถูกน้ำท่วม — กด ▶ เพื่อเริ่มจำลอง</span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-1">
        {ALL_CATEGORIES.map((c) => {
          const e = summary.get(c);
          if (!e) return null;
          const on = cats.includes(c);
          return (
            <button
              key={c}
              type="button"
              onClick={() => a.toggleCategory(c)}
              aria-pressed={on}
              className={`flex items-center gap-1.5 rounded-lg border px-1.5 py-1 text-left text-[11.5px] ${on ? 'border-line bg-white/[0.06]' : 'border-transparent opacity-45'}`}
            >
              <span className="grid h-[18px] w-[18px] flex-none place-items-center rounded-full text-[10px] font-bold text-white" style={{ background: CATEGORY_COLOR[c] }}>
                {PLACE_ICON[c]}
              </span>
              <span className="min-w-0 flex-1 truncate">{CATEGORY_TH[c]}</span>
              <span className="tabular flex-none text-ink-3">
                {e.wet ? <b className="text-serious">{e.wet}</b> : 0}/{e.total}
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex gap-1.5">
        <input className="field" placeholder="ค้นหาชื่อสถานที่…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="ค้นหาสถานที่" />
        <select className="field w-[118px]" value={sort} onChange={(e) => setSort(e.target.value as 'depth' | 'importance')} aria-label="เรียงลำดับ">
          <option value="depth">น้ำลึกสุดก่อน</option>
          <option value="importance">ความสำคัญ</option>
        </select>
      </div>

      <ul className="flex flex-col">
        {list.slice(0, 160).map((r) => {
          const lv = depthLevel(r.depth);
          return (
            <li key={r.p.id}>
              <button type="button" className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left hover:bg-white/5" onClick={() => getEngine()?.flyToPlace(r.p.id)}>
                <span className="grid h-[22px] w-[22px] flex-none place-items-center rounded-full text-[11px] font-bold text-white" style={{ background: CATEGORY_COLOR[r.p.category] }} aria-hidden="true">
                  {PLACE_ICON[r.p.category]}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px]">{r.p.name}</span>
                  <span className="block truncate text-[10.5px] text-ink-3">
                    {KIND_TH[r.p.kind] ?? r.p.kind}
                    {r.firstWet >= 0 ? ` · น้ำถึงชั่วโมงที่ ${num(r.firstWet, 1)}` : ''}
                  </span>
                </span>
                <span className="flex flex-none flex-col items-end text-[11px]">
                  <span className="inline-flex items-center gap-1 font-medium" style={{ color: LEVEL_COLOR[lv] }}>
                    <StatusIcon level={lv} />
                    {r.depth >= 0.05 ? `${num(r.depth, 2)} ม.` : LEVEL_TEXT[lv]}
                  </span>
                  {r.max >= 0.1 && <span className="tabular text-[10.5px] text-ink-3">สูงสุด {num(r.max, 1)} ม.</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {list.length > 160 && <div className="text-center text-[11px] text-ink-3">แสดง 160 จาก {list.length} — ใช้ช่องค้นหาเพื่อกรอง</div>}
    </div>
  );
}
