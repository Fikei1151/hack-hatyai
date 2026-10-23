// Dev-only helpers for playing the board game without a human: `window.__bot` runs greedy teams through
// whole games on the live flood model (used to check the game's balance; see scripts/game-test).
import { getEngine, useApp } from '../store';
import * as rules from './rules';
import { useGame } from './store';
import type { RoleId } from './roles';
import type { Difficulty } from './storm';

const G = () => useGame.getState();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** one round: the greedy bot plays every team, then the flood is run flat out and resolved */
async function round(): Promise<rules.Phase> {
  const g = G();
  const s = g.state;
  const world = g.world;
  if (!s || !world) throw new Error('no game running');
  if (s.phase === 'resolve') G().nextRound();
  if (G().state!.phase === 'event') G().beginActions();
  for (let t = 0; t < s.teams.length; t++) {
    s.active = t;
    rules.autoTurn(s, world, t);
    G().endTurn();
  }
  const eng = getEngine()!;
  let guard = 0;
  while (eng.pump(2000) && guard++ < 5000) if (guard % 3 === 0) await sleep(0);
  while (G().state!.phase === 'flood') await sleep(20); // the depth read-back and resolution are async
  return G().state!.phase;
}

export interface BotConfig {
  seed: number;
  difficulty: Difficulty;
  roles: RoleId[];
  rounds?: number;
}

async function play(c: BotConfig) {
  G().setForm({ difficulty: c.difficulty, rounds: c.rounds ?? 8, teams: c.roles.map((role, i) => ({ name: `ทีม${i + 1}`, role })) });
  await G().start(c.seed);
  let phase: rules.Phase = 'event';
  for (let i = 0; i < 20 && phase !== 'over'; i++) phase = await round();
  const s = G().state!;
  return {
    ...c,
    saved: rules.savedPeople(s),
    people: s.stats.people,
    calls: s.calls.length,
    safe: s.calls.filter((x) => x.status === 'safe').length,
    stars: rules.stars(s),
    points: s.stats.points,
    stalls: s.stats.stalls,
    rounds: s.history.map((h) => ({ rain: h.rain, km2: Math.round(h.floodedKm2), cutPct: Math.round((100 * h.roadKmBlocked) / h.roadKm), safe: h.safe, lost: h.lost })),
  };
}

export function installDevTools() {
  Object.assign(window, { __bot: { round, play, rules, app: useApp } });
}
