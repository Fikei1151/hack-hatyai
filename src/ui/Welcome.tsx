import { useEffect } from 'react';
import { useGame } from '../game/store';
import { useApp } from '../store';
import { num } from './format';

/** First-visit card: what this is, and the three things worth trying first. */
export function Welcome() {
  const buildings = useApp((s) => s.city?.meta.buildings.count ?? 0);
  const places = useApp((s) => s.places.length);
  const a = useApp.getState();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && useApp.getState().dismissWelcome();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const go = (fn: () => void) => {
    a.dismissWelcome();
    fn();
  };

  return (
    <div className="absolute inset-0 z-40 grid place-items-center bg-[#0b2340]/25 p-4 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
      <div className="glass w-[min(580px,100%)] rounded-3xl p-5 max-sm:p-4">
        <div className="text-center text-[40px] leading-none" aria-hidden="true">
          <span className="bob inline-block">🌧️</span>🏘️🌊
        </div>
        <h1 id="welcome-title" className="mt-2 text-center font-cute text-[22px] font-bold">
          สวัสดี! นี่คือหาดใหญ่จำลอง 3 มิติ
        </h1>
        <p className="mx-auto mt-1 max-w-[460px] text-center text-[13px] leading-relaxed text-ink-2">
          สร้างจากข้อมูลจริง: ภูมิประเทศจากดาวเทียม อาคาร {num(buildings)} หลัง คลองทุกสาย และสถานที่สำคัญ {num(places)} แห่ง แล้วให้ GPU คำนวณน้ำไหลจริงทีละ 20 เมตร
        </p>
        <button
          type="button"
          onClick={() => go(() => useGame.getState().open())}
          className="group mt-4 flex w-full items-center gap-3 rounded-2xl border-[1.5px] border-[#7fb2ef] bg-gradient-to-r from-accent-soft to-white px-4 py-3 text-left transition hover:-translate-y-0.5 hover:shadow-md"
        >
          <span className="text-[34px] leading-none transition group-hover:rotate-12">🎲</span>
          <span>
            <span className="block font-cute text-[16px] font-bold">เล่นเกมกู้ภัยน้ำท่วม (ใหม่!)</span>
            <span className="block text-[12px] leading-snug text-ink-2">เกมกระดานบนแผนที่หาดใหญ่ — พายุสุ่ม ถนนถูกน้ำตัด พาทีมกู้ภัยไปรับครอบครัวให้ทัน</span>
          </span>
        </button>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <Tile emoji="🌧️" title="ทดลองฝนตก" text="ถ้าฝนตกชั่วโมงละ X มม. น้ำจะท่วมตรงไหน?" onClick={() => go(() => a.setPanel('rainlab'))} />
          <Tile emoji="📅" title="พยากรณ์ & โอกาสท่วม" text="10 วันข้างหน้า จากพยากรณ์อากาศจริง ดูทีละวัน" onClick={() => go(() => a.setPanel('forecast'))} />
          <Tile
            emoji="⏪"
            title="ย้อนดูน้ำท่วมปี 68"
            text="เหตุการณ์จริง 19–28 พ.ย. 2568 เล่นด้วยความเร็ว 3 เท่า"
            onClick={() =>
              go(() => {
                a.setPanel('scenario');
                void a.loadEvent('2025-11').then(() => {
                  useApp.getState().setSpeed(5400);
                  useApp.getState().play();
                });
              })
            }
          />
        </div>
        <div className="mt-3 flex justify-center">
          <button type="button" className="btn btn-ghost text-[12.5px] text-ink-2" onClick={() => a.dismissWelcome()}>
            ไว้ทีหลัง ขอดูแผนที่ก่อน
          </button>
        </div>
      </div>
    </div>
  );
}

function Tile({ emoji, title, text, onClick }: { emoji: string; title: string; text: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col items-center gap-1 rounded-2xl border-[1.5px] border-[#dde4ee] bg-white px-3 py-3 text-center transition hover:-translate-y-0.5 hover:border-[#7fb2ef] hover:shadow-md max-sm:flex-row max-sm:text-left"
    >
      <span className="text-[30px] leading-none transition group-hover:scale-110">{emoji}</span>
      <span>
        <span className="block font-cute text-[14.5px] font-bold">{title}</span>
        <span className="block text-[11.5px] leading-snug text-ink-2">{text}</span>
      </span>
    </button>
  );
}
