import { simClock, thaiShort } from '../../ui/format';
import { useGame } from '../store';
import type { GameState } from '../rules';

/** the live game state (mutated in place by the rules); subscribing to `rev` re-renders on every change */
export function useGameState() {
  useGame((s) => s.rev);
  const s = useGame.getState();
  return { state: s.state, world: s.world };
}

export const HOUR_S = 3600;

/** local date and time at the start (offset 0) or end (offset 1) of the current round */
export function roundClock(state: GameState, offset = 0): string {
  return thaiShort(simClock(state.scenario.start_time, (state.round - 1 + offset) * state.cfg.roundHours * HOUR_S));
}

export function riverWord(q: number): { text: string; emoji: string } {
  if (q < 250) return { text: 'ปกติ', emoji: '🙂' };
  if (q < 600) return { text: 'สูงขึ้น', emoji: '🤨' };
  if (q < 1000) return { text: 'มาก', emoji: '😬' };
  return { text: 'หลากแรง', emoji: '😱' };
}

export function Hearts({ distress, lost }: { distress: number; lost?: boolean }) {
  if (lost) return <span title="ช่วยไม่ทัน">💔</span>;
  const left = Math.max(0, 3 - Math.floor(distress));
  return (
    <span className="tracking-[-1px]" title={`ความทรุดโทรม ${distress.toFixed(1)}/3`}>
      {'❤️'.repeat(left)}
      {'🤍'.repeat(3 - left)}
    </span>
  );
}
