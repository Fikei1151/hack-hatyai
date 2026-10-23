import { useEffect, useState } from 'react';
import { loadCity } from './engine/cityData';
import { loadEvents } from './sim/realdata';
import { useApp } from './store';
import { GameShell } from './game/ui/GameShell';
import { ForecastPanel } from './ui/ForecastPanel';
import { PlacesPanel } from './ui/PlacesPanel';
import { RainLabPanel } from './ui/RainLabPanel';
import { ScenarioPanel } from './ui/ScenarioPanel';
import { DepthLegend, LivePanel, RunsPanel, Toast } from './ui/SidePanels';
import { StatsPanel } from './ui/StatsPanel';
import { DayViewBanner, Timeline } from './ui/Timeline';
import { TopBar } from './ui/TopBar';
import { Viewport } from './ui/Viewport';
import { Welcome } from './ui/Welcome';

const CITY_BASE = '/city/hatyai';

const TABS = [
  { key: 'rainlab', emoji: '🌧️', label: 'ทดลองฝน' },
  { key: 'forecast', emoji: '📅', label: 'พยากรณ์' },
  { key: 'scenario', emoji: '🎬', label: 'สถานการณ์' },
  { key: 'places', emoji: '📍', label: 'สถานที่' },
  { key: 'live', emoji: '📡', label: 'ข้อมูลสด' },
  { key: 'runs', emoji: '📊', label: 'ผลการรัน' },
] as const;

export default function App() {
  const load = useApp((s) => s.load);
  const city = useApp((s) => s.city);
  const panel = useApp((s) => s.panel);
  const engineReady = useApp((s) => s.engineReady);
  const showWelcome = useApp((s) => s.showWelcome);
  const mode = useApp((s) => s.mode);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);

  useEffect(() => {
    const st = useApp.getState();
    let cancelled = false;
    (async () => {
      try {
        const [c, events] = await Promise.all([loadCity(CITY_BASE, (stage, f) => !cancelled && st.setLoad(stage, f)), loadEvents(CITY_BASE)]);
        if (cancelled) return;
        st.setLoad('สร้างโมเดล 3 มิติของเมือง…', 0.97);
        st.setCity(c, events);
        await st.initDb();
        st.setLoad('พร้อม', 1);
      } catch (e) {
        st.setLoad('โหลดข้อมูลเมืองไม่สำเร็จ', 1, (e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="relative h-full w-full overflow-hidden">
      <Viewport />
      {city && mode === 'game' && <GameShell />}
      {city && mode === 'sim' && (
        <div className="pointer-events-none absolute inset-0 flex flex-col gap-3 p-3">
          <TopBar />
          <div className="relative flex min-h-0 flex-1 gap-3">
            {leftOpen ? (
              <aside className="glass pointer-events-auto flex w-[350px] flex-none flex-col overflow-hidden rounded-2xl max-md:absolute max-md:inset-0 max-md:z-20 max-md:w-auto">
                <div className="flex items-stretch gap-1 border-b border-line p-1.5">
                  <div className="grid flex-1 grid-cols-3 gap-1" role="tablist">
                    {TABS.map((t) => (
                      <button
                        key={t.key}
                        type="button"
                        role="tab"
                        aria-selected={panel === t.key}
                        className={`flex min-w-0 items-center justify-center gap-1.5 rounded-xl px-1 py-1.5 ${panel === t.key ? 'bg-accent-soft text-[#1d4f8f]' : 'text-ink-2 hover:bg-hover'}`}
                        onClick={() => useApp.getState().setPanel(t.key)}
                      >
                        <span className={`text-[16px] leading-none ${panel === t.key ? 'bob' : ''}`}>{t.emoji}</span>
                        <span className={`truncate text-[12px] leading-tight ${panel === t.key ? 'font-bold' : 'font-medium'}`}>{t.label}</span>
                      </button>
                    ))}
                  </div>
                  <button type="button" className="btn btn-ghost px-1.5 text-ink-3" onClick={() => setLeftOpen(false)} aria-label="ซ่อนแผง">
                    ‹
                  </button>
                </div>
                <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-3">
                  {panel === 'rainlab' && <RainLabPanel />}
                  {panel === 'forecast' && <ForecastPanel />}
                  {panel === 'scenario' && <ScenarioPanel />}
                  {panel === 'places' && <PlacesPanel />}
                  {panel === 'live' && <LivePanel />}
                  {panel === 'runs' && <RunsPanel />}
                </div>
              </aside>
            ) : (
              <button type="button" className="btn glass pointer-events-auto h-10 self-start rounded-xl" onClick={() => setLeftOpen(true)}>
                ☰ {TABS.find((t) => t.key === panel)?.emoji} เมนู
              </button>
            )}

            <div className="flex min-w-0 flex-1 flex-col items-center justify-end gap-2">
              <div className="mb-auto flex w-full justify-center">
                <DayViewBanner />
              </div>
              <Toast />
              <div className="flex w-full items-end justify-between gap-2">
                <p className="pointer-events-auto max-w-[460px] text-[10px] leading-snug text-ink-2 [text-shadow:0_0_4px_#fff,0_0_8px_#fff] max-md:hidden">
                  ข้อมูล: ภูมิประเทศ Copernicus GLO-30 © DLR/Airbus (ESA) · อาคาร/คลอง © ผู้ร่วมพัฒนา OpenStreetMap · ภาพถ่าย Esri, Maxar · สถานีวัดน้ำ ThaiWater/สสน., กรมชลประทาน · ฝน Open-Meteo/ERA5, GloFAS
                </p>
                <DepthLegend />
              </div>
            </div>

            {rightOpen ? (
              <aside className="glass pointer-events-auto relative w-[330px] flex-none overflow-hidden rounded-2xl max-lg:hidden">
                <button type="button" className="btn btn-ghost absolute right-1.5 top-1.5 z-10 px-2 py-1 text-ink-3" onClick={() => setRightOpen(false)} aria-label="ซ่อนแผงผลลัพธ์">
                  ›
                </button>
                <div className="scroll-thin h-full overflow-y-auto p-3">
                  <StatsPanel />
                </div>
              </aside>
            ) : (
              <button type="button" className="btn glass pointer-events-auto h-10 self-start rounded-xl max-lg:hidden" onClick={() => setRightOpen(true)}>
                ผลลัพธ์ ‹
              </button>
            )}
          </div>
          <Timeline />
        </div>
      )}
      {city && engineReady && showWelcome && mode === 'sim' && <Welcome />}
      {load.progress < 1 || load.error || (city && !engineReady) ? (
        <LoadingScreen stage={load.progress >= 1 && !engineReady ? 'ปรับสมดุลน้ำในคลองก่อนเริ่มจำลอง…' : load.stage} progress={load.progress >= 1 && !engineReady ? 0.99 : load.progress} error={load.error} />
      ) : null}
    </div>
  );
}

function LoadingScreen({ stage, progress, error }: { stage: string; progress: number; error?: string }) {
  return (
    <div className="absolute inset-0 z-50 grid place-items-center bg-gradient-to-b from-[#cfe6fb] to-[#f4f9ff]">
      <div className="flex w-[min(420px,88vw)] flex-col items-center gap-3 text-center">
        <div className="relative h-[72px] w-[120px]" aria-hidden="true">
          <span className="bob absolute left-1/2 top-0 -translate-x-1/2 text-[44px] leading-none">🌧️</span>
          <span className="absolute bottom-0 left-1/2 -translate-x-1/2 text-[30px] leading-none">🏘️</span>
        </div>
        <div className="font-cute text-[22px] font-bold">หาดใหญ่จำลอง · น้ำมาแล้ว!</div>
        <div className="text-[13px] text-ink-2">{error ? 'เกิดข้อผิดพลาด' : stage}</div>
        <div className="h-2.5 w-full overflow-hidden rounded-full bg-white/80 shadow-inner">
          <div className="h-full rounded-full bg-gradient-to-r from-[#7cc4fa] to-[#2a78d6] transition-[width] duration-300" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        {error && (
          <div className="rounded-lg border border-critical/40 bg-critical/10 p-3 text-[12.5px] leading-relaxed text-critical-ink">
            {error}
            <div className="mt-1 text-ink-3">ตรวจสอบว่าเบราว์เซอร์รองรับ WebGL2 และสร้างข้อมูลเมืองแล้ว (npm run city:build)</div>
          </div>
        )}
      </div>
    </div>
  );
}
