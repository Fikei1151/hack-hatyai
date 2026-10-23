import { useEffect, useRef } from 'react';
import { Engine } from '../engine/Engine';
import { useGame } from '../game/store';
import { setEngine, useApp } from '../store';

/** Hosts the WebGL canvas and owns the Engine's lifetime. */
export function Viewport() {
  const ref = useRef<HTMLDivElement>(null);
  const city = useApp((s) => s.city);

  useEffect(() => {
    if (!ref.current || !city) return;
    let engine: Engine;
    try {
      engine = new Engine(ref.current, city, () => {
        const s = useApp.getState();
        return { playing: s.playing, speed: s.speed, scenario: s.scenario, layers: s.layers };
      }, {
        onStats: (st) => useApp.getState().onStats(st),
        onSeriesPoint: (p) => useApp.getState().onSeriesPoint(p),
        onFinished: () => useApp.getState().onFinished(),
        onPoiClick: (id) => engine.flyToPoi(id),
        onPlaceClick: (id) => {
          engine.flyToPlace(id);
          useApp.getState().setPanel('places');
        },
        onPlaceImpact: (im) => useApp.getState().onPlaceImpact(im),
        onDaySnapshot: (d) => useApp.getState().onDaySnapshot(d),
        onFastForwardDone: () => {
          useApp.getState().onFastForwardDone();
          void useGame.getState().onFloodDone();
        },
      });
      const loaded = useApp.getState();
      if (loaded.placesSource === 'supabase') engine.setPlaces(loaded.places);
    } catch (e) {
      useApp.getState().setLoad('ไม่สามารถเริ่ม WebGL2 ได้', 1, (e as Error).message);
      return;
    }
    setEngine(engine);
    useApp.getState().setEngineReady(false);
    engine.ready.then(() => useApp.getState().setEngineReady(true));
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || (e.target as HTMLElement).closest('input, select, textarea, button')) return;
      e.preventDefault();
      const st = useApp.getState();
      if (st.mode === 'game') return;
      if (st.playing) st.pause();
      else st.play();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      setEngine(null);
      engine.dispose();
    };
  }, [city]);

  return <div ref={ref} className="absolute inset-0" />;
}
