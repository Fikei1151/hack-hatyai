// Headless self-play of the rules on the real road network with a synthetic flood (water level above the
// canal banks rising with the storm). Checks invariants and prints how a greedy bot fares.
import { autoTurn, beginRound, endTurn, newGame, resolveFlood, savedPeople, startActions, stars, type GameConfig, type GameState } from '../../src/game/rules';
import { ROLES, type RoleId } from '../../src/game/roles';
import { type Difficulty } from '../../src/game/storm';
import { createWorld, type GameWorld } from '../../src/game/world';
import { loadCityNode, permanentMask } from './load';

const city = loadCityNode();
const world: GameWorld = createWorld(city, permanentMask(city));

function synthDepth(state: GameState, world: GameWorld, round: number): Float32Array {
  const s = state.storm[round - 1];
  const rainBoost = state.patches.reduce((m, p) => m * (p.rainMul ?? 1), 1);
  const W = (s.inflow / 1000) * 1.6 - 0.4 + (s.rain * rainBoost) / 60;
  const d = new Float32Array(world.hand.length);
  for (let i = 0; i < d.length; i++) {
    if (world.permanent[i]) continue;
    const h = world.hand[i];
    d[i] = Math.max(0, W - h) * (h < 6 ? 1 : 0);
  }
  return d;
}

function invariants(state: GameState, where: string) {
  for (const t of state.teams) {
    if (t.mp < -1e-6) throw new Error(`${where}: negative mp ${t.mp}`);
    const seats = ROLES[t.role].capacity + t.capBonus;
    const used = t.load.reduce((s, id) => s + state.calls.find((c) => c.id === id)!.people, 0);
    if (used > seats) throw new Error(`${where}: overloaded ${used}/${seats}`);
    for (const id of t.load) if (state.calls.find((c) => c.id === id)!.status !== 'aboard') throw new Error(`${where}: load/status mismatch`);
  }
  for (const sh of state.shelters) if (sh.occupants > sh.capacity) throw new Error(`${where}: shelter over capacity`);
  const aboard = state.calls.filter((c) => c.status === 'aboard').length;
  const carried = state.teams.reduce((s, t) => s + t.load.length, 0);
  if (aboard !== carried && state.phase !== 'over') throw new Error(`${where}: aboard ${aboard} vs carried ${carried}`);
}

function play(seed: number, difficulty: Difficulty, teams: RoleId[], rounds = 8): { state: GameState; ms: number } {
  const cfg: GameConfig = { seed, difficulty, rounds, roundHours: 4, teams: teams.map((role, i) => ({ name: `ทีม${i + 1}`, role })) };
  const t0 = performance.now();
  const state = newGame(cfg, world, new Date('2026-10-21T06:00:00+07:00').toISOString());
  for (let r = 1; r <= rounds; r++) {
    beginRound(state, world);
    startActions(state);
    invariants(state, `r${r} begin`);
    for (let t = 0; t < state.teams.length; t++) {
      state.active = t;
      autoTurn(state, world, t);
      invariants(state, `r${r} team${t}`);
      endTurn(state);
    }
    const depth = synthDepth(state, world, r);
    resolveFlood(state, world, depth);
    invariants(state, `r${r} resolve`);
  }
  return { state, ms: performance.now() - t0 };
}

const mixes: Record<string, RoleId[]> = { solo: ['rescue'], duo: ['rescue', 'boat'], trio: ['rescue', 'boat', 'medic'], quad: ['rescue', 'boat', 'medic', 'scout'] };
for (const diff of ['easy', 'normal', 'hard'] as Difficulty[]) {
  for (const [name, roles] of Object.entries(mixes)) {
    const rows: string[] = [];
    let saved = 0, total = 0, stalls = 0, ms = 0, n = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const { state, ms: t } = play(seed * 101, diff, roles);
      saved += savedPeople(state);
      total += state.stats.people;
      stalls += state.stats.stalls;
      ms += t;
      n++;
      rows.push(`${savedPeople(state)}/${state.stats.people}★${stars(state)}`);
    }
    console.log(`${diff.padEnd(6)} ${name.padEnd(5)} saved ${(100 * saved / total).toFixed(0).padStart(3)}%  stalls/game ${(stalls / n).toFixed(1)}  ${(ms / n).toFixed(0)} ms/game  [${rows.join(' ')}]`);
  }
}
