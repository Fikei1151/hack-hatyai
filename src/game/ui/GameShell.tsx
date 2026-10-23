import { useEffect } from 'react';
import '../game.css';
import { useGame } from '../store';
import { GameErrorBoundary } from './ErrorBoundary';
import { Hud } from './Hud';
import { DiceOverlay, EventModal, FloodOverlay, HelpModal, HoverTip, QuitModal, ResolveModal, Toasts } from './Modals';
import { ResultScreen } from './ResultScreen';
import { SetupScreen } from './SetupScreen';

/** The rescue board game's whole screen, laid over the live 3D city. */
export function GameShell() {
  const screen = useGame((s) => s.screen);
  const modal = useGame((s) => s.modal);
  const busy = useGame((s) => s.busy);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select')) return;
      const g = useGame.getState();
      const k = e.key.toLowerCase();
      if (e.key === 'Escape') {
        if (g.modal === 'help' || g.modal === 'quit') g.setModal(g.state?.phase === 'event' ? 'event' : g.state?.phase === 'resolve' ? 'resolve' : null);
        else g.clearPin();
      } else if (e.key === 'Enter') {
        if (g.modal === 'event') g.beginActions();
        else if (g.modal === 'resolve') g.nextRound();
        else if (!g.modal && g.pinned !== null) void g.confirm();
      } else if (!g.modal && g.screen === 'play' && g.state?.phase === 'action') {
        if (k === 'e') g.endTurn();
        else if (k === 'h') g.askHint();
        else if (k === 'a') g.actHere();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <GameErrorBoundary>
      <GameScreens screen={screen} modal={modal} busy={busy} />
    </GameErrorBoundary>
  );
}

function GameScreens({ screen, modal, busy }: { screen: string; modal: string | null; busy: string | null }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      {screen === 'setup' ? <SetupScreen /> : <Hud />}
      <Toasts />
      <FloodOverlay />
      <DiceOverlay />
      <HoverTip />
      {screen === 'play' && modal === 'event' && <EventModal />}
      {screen === 'play' && modal === 'resolve' && <ResolveModal />}
      {modal === 'help' && <HelpModal />}
      {modal === 'quit' && <QuitModal />}
      {screen === 'result' && <ResultScreen />}
      {busy === 'loading' && screen === 'play' && <div className="pointer-events-auto absolute inset-0 z-40 grid place-items-center bg-white/50 font-cute text-[18px] font-bold">⏳ กำลังสร้างฉาก…</div>}
    </div>
  );
}
