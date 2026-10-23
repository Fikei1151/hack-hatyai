// Integration test against this project's LOCAL stack. All temporary records are removed in finally.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { localStatus } from './supabase-local.mjs';

const status = localStatus();
const options = { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15000) }) } };
const db = createClient(status.API_URL, status.PUBLISHABLE_KEY || status.ANON_KEY, options);
// The admin key stays in this Node process and is used only to remove the test's own records.
const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, options);
const marker = `local-setup-test-${randomUUID()}`;
let scenarioId, runId, gameId;
const ok = ({ data, error }) => { if (error) throw new Error(error.message); return data; };

try {
  const phase = { name: 'ทดสอบฝน', color: '#3b82f6', duration_hours: 1, rain_mm_hr: 10, events: [] };
  const scenario = { slug: marker, name: 'ทดสอบการเชื่อมต่อชั่วคราว', source: 'custom', seed: 1, start_time: new Date().toISOString(), settings: {} };
  scenarioId = ok(await db.rpc('save_scenario', { p_scenario: scenario, p_phases: [phase] }));
  const saved = ok(await db.from('scenarios').select('id, phases(*)').eq('id', scenarioId).single());
  assert.equal(saved.phases.length, 1);
  assert.equal(saved.phases[0].rain_mm_hr, 10);

  // A rejected phase must roll back both the scenario update and phase replacement.
  const invalid = await db.rpc('save_scenario', { p_scenario: { ...scenario, id: scenarioId, name: 'must roll back' }, p_phases: [{ ...phase, duration_hours: -1 }] });
  assert.ok(invalid.error, 'Invalid phase was accepted');
  const unchanged = ok(await db.from('scenarios').select('name, phases(*)').eq('id', scenarioId).single());
  assert.equal(unchanged.name, scenario.name);
  assert.equal(unchanged.phases.length, 1);
  console.log('OK scenario save/read and transaction rollback');

  runId = ok(await db.from('simulation_runs').insert({ scenario_id: scenarioId, scenario_name: marker, scenario_snapshot: { ...scenario, phases: [phase] }, seed: 1, grid_cell_m: 20 }).select('id').single()).id;
  ok(await db.from('simulation_runs').update({ status: 'completed', sim_hours: 1, finished_at: new Date().toISOString(), timeseries: [{ t: 3600, rain: 10 }] }).eq('id', runId));
  assert.equal(ok(await db.from('simulation_runs').select('status').eq('id', runId).single()).status, 'completed');

  const place = ok(await db.from('places').select('id, lat, lon').limit(1).single());
  ok(await db.from('run_place_impacts').upsert({ run_id: runId, place_id: place.id, max_depth_m: 0.25, first_wet_hours: 0.5 }));
  const nearby = ok(await db.rpc('places_near', { p_lat: place.lat, p_lon: place.lon, p_radius_m: 100 }));
  assert.ok(nearby.some((p) => p.id === place.id));
  console.log('OK simulation result, place impact and PostGIS search');

  ok(await db.from('weather_cache').upsert({ key: marker, payload: { test: true }, fetched_at: new Date().toISOString() }));
  assert.equal(ok(await db.from('weather_cache').select('payload').eq('key', marker).single()).payload.test, true);

  const game = { seed: 1, difficulty: 'easy', rounds: 6, teams: [{ name: marker, role: 'rescue', rescued: 1 }], district: marker, people_total: 2, people_saved: 1, points: 10, stars: 1, summary: {} };
  gameId = ok(await db.from('game_results').insert(game).select('id').single()).id;
  const edit = await db.from('game_results').update({ points: 20 }).eq('id', gameId).select('id');
  assert.ok(edit.error || edit.data.length === 0, 'Anonymous users could edit a leaderboard result');
  const remove = await db.from('game_results').delete().eq('id', gameId).select('id');
  assert.ok(remove.error || remove.data.length === 0, 'Anonymous users could delete a leaderboard result');
  assert.equal(ok(await db.from('game_results').select('points').eq('id', gameId).single()).points, 10);
  assert.ok((await db.from('game_results').insert({ ...game, people_saved: 3 })).error, 'Invalid game result was accepted');
  console.log('OK API cache, leaderboard insert/read, edit/delete denial and score constraints');

  ok(await db.from('scenarios').delete().eq('id', scenarioId));
  assert.equal(ok(await db.from('simulation_runs').select('scenario_id').eq('id', runId).single()).scenario_id, null);
  console.log('OK scenario deletion keeps simulation history');
} finally {
  const cleanup = [];
  cleanup.push(await admin.from('weather_cache').delete().eq('key', marker));
  if (gameId) cleanup.push(await admin.from('game_results').delete().eq('id', gameId));
  if (runId) cleanup.push(await admin.from('simulation_runs').delete().eq('id', runId));
  if (scenarioId) cleanup.push(await admin.from('scenarios').delete().eq('id', scenarioId));
  for (const result of cleanup) ok(result);
  console.log('Temporary test records removed.');
}
console.log('Local database integration test passed.');
