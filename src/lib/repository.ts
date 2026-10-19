// Persistence for scenarios, phases and simulation runs.
// Uses the local Supabase stack when it is reachable, otherwise falls back to localStorage so the
// simulator keeps working (the UI shows which one is active).
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Place } from '../engine/cityData';
import { newId } from '../sim/scenario';
import type { Phase, Scenario, SeriesPoint } from '../sim/types';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const client: SupabaseClient | null = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;

export type DbMode = 'checking' | 'supabase' | 'local';
let mode: DbMode = 'checking';

export interface ScenarioSummary {
  id: string;
  slug: string | null;
  name: string;
  source: Scenario['source'];
  updated_at: string;
  phases: number;
}

export interface RunRecord {
  id: string;
  scenario_id: string | null;
  scenario_name: string;
  status: 'running' | 'completed' | 'stopped';
  seed: number;
  grid_cell_m: number;
  sim_hours: number;
  total_rain_mm: number | null;
  peak_flood_area_km2: number | null;
  peak_depth_m: number | null;
  peak_volume_m3: number | null;
  buildings_affected: number | null;
  poi_peaks: Record<string, number>;
  timeseries: SeriesPoint[];
  started_at: string;
  finished_at: string | null;
}

export type RunPatch = Partial<Omit<RunRecord, 'id' | 'started_at'>>;

const PHASE_FIELDS = [
  'name',
  'color',
  'duration_hours',
  'ramp_hours',
  'rain_mm_hr',
  'rain_pattern',
  'rain_variability',
  'storm_cells',
  'wind_dir_deg',
  'wind_speed_kmh',
  'upstream_inflow_m3s',
  'lake_level_m',
  'drainage_mm_hr',
  'infiltration_mm_hr',
  'events',
  'notes',
] as const;

export async function connect(): Promise<DbMode> {
  if (!client) return (mode = 'local');
  try {
    const { error } = await client.from('scenarios').select('id').limit(1);
    mode = error ? 'local' : 'supabase';
  } catch {
    mode = 'local';
  }
  return mode;
}

export const dbMode = () => mode;

// ───────────────────────────────────────────── local fallback

const LS_SCEN = 'hatyai.scenarios.v1';
const LS_RUNS = 'hatyai.runs.v1';
function lsRead<T>(k: string): T[] {
  try {
    return JSON.parse(localStorage.getItem(k) ?? '[]') as T[];
  } catch {
    return [];
  }
}
function lsWrite<T>(k: string, v: T[]) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage full or blocked: nothing persistent available */
  }
}

// ───────────────────────────────────────────── scenarios

export async function listScenarios(): Promise<ScenarioSummary[]> {
  if (mode === 'supabase' && client) {
    const { data, error } = await client.from('scenarios').select('id, slug, name, source, updated_at, phases(count)').order('updated_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      source: r.source,
      updated_at: r.updated_at,
      phases: (r.phases as unknown as { count: number }[])?.[0]?.count ?? 0,
    }));
  }
  return lsRead<Scenario & { id: string; updated_at: string }>(LS_SCEN).map((s) => ({
    id: s.id,
    slug: s.slug ?? null,
    name: s.name,
    source: s.source,
    updated_at: s.updated_at,
    phases: s.phases.length,
  }));
}

export async function loadScenario(id: string): Promise<Scenario> {
  if (mode === 'supabase' && client) {
    const { data, error } = await client.from('scenarios').select('*, phases(*)').eq('id', id).order('position', { referencedTable: 'phases' }).single();
    if (error) throw error;
    return {
      id: data.id,
      slug: data.slug ?? undefined,
      name: data.name,
      description: data.description,
      source: data.source,
      seed: data.seed,
      start_time: data.start_time ?? new Date().toISOString(),
      settings: data.settings ?? {},
      phases: (data.phases as Record<string, unknown>[]).sort((a, b) => Number(a.position) - Number(b.position)).map((p) => pickPhase(p)),
    };
  }
  const s = lsRead<Scenario>(LS_SCEN).find((x) => x.id === id);
  if (!s) throw new Error('ไม่พบสถานการณ์');
  return s;
}

function pickPhase(p: Record<string, unknown>): Phase {
  const out: Record<string, unknown> = { id: (p.id as string) ?? newId() };
  for (const f of PHASE_FIELDS) out[f] = p[f];
  return out as unknown as Phase;
}

export async function saveScenario(s: Scenario): Promise<string> {
  if (mode === 'supabase' && client) {
    const { data, error } = await client.rpc('save_scenario', {
      p_scenario: { id: s.id ?? null, slug: s.slug ?? null, name: s.name, description: s.description, source: s.source, seed: s.seed, start_time: s.start_time, settings: s.settings },
      p_phases: s.phases.map((p) => Object.fromEntries(PHASE_FIELDS.map((f) => [f, p[f]]))),
    });
    if (error) throw error;
    return data as string;
  }
  const all = lsRead<Scenario & { id: string; updated_at: string }>(LS_SCEN);
  const id = s.id ?? (s.slug ? all.find((x) => x.slug === s.slug)?.id : undefined) ?? newId();
  const rec = { ...s, id, updated_at: new Date().toISOString() };
  lsWrite(LS_SCEN, [rec, ...all.filter((x) => x.id !== id)]);
  return id;
}

export async function deleteScenario(id: string) {
  if (mode === 'supabase' && client) {
    const { error } = await client.from('scenarios').delete().eq('id', id);
    if (error) throw error;
    return;
  }
  lsWrite(
    LS_SCEN,
    lsRead<Scenario & { id: string }>(LS_SCEN).filter((x) => x.id !== id),
  );
}

/** Insert built-in scenarios that are not stored yet (matched by slug); never overwrites edits. */
export async function syncPresets(presets: Scenario[]) {
  const existing = new Set((await listScenarios()).map((s) => s.slug).filter(Boolean));
  for (const p of presets) if (p.slug && !existing.has(p.slug)) await saveScenario(p);
}

// ───────────────────────────────────────────── runs

export async function createRun(s: Scenario, cell: number): Promise<string> {
  const rec = {
    scenario_id: s.id ?? null,
    scenario_name: s.name,
    scenario_snapshot: s,
    seed: s.seed,
    grid_cell_m: cell,
    status: 'running' as const,
  };
  if (mode === 'supabase' && client) {
    const { data, error } = await client.from('simulation_runs').insert(rec).select('id').single();
    if (error) throw error;
    return data.id as string;
  }
  const id = newId();
  const runs = lsRead<RunRecord>(LS_RUNS);
  lsWrite(LS_RUNS, [
    {
      ...rec,
      id,
      sim_hours: 0,
      total_rain_mm: null,
      peak_flood_area_km2: null,
      peak_depth_m: null,
      peak_volume_m3: null,
      buildings_affected: null,
      poi_peaks: {},
      timeseries: [],
      started_at: new Date().toISOString(),
      finished_at: null,
    },
    ...runs,
  ].slice(0, 30));
  return id;
}

export async function updateRun(id: string, patch: RunPatch) {
  if (mode === 'supabase' && client) {
    const { error } = await client.from('simulation_runs').update(patch).eq('id', id);
    if (error) throw error;
    return;
  }
  lsWrite(
    LS_RUNS,
    lsRead<RunRecord>(LS_RUNS).map((r) => (r.id === id ? { ...r, ...patch } : r)),
  );
}

export async function listRuns(limit = 20): Promise<RunRecord[]> {
  if (mode === 'supabase' && client) {
    const { data, error } = await client
      .from('simulation_runs')
      .select('id, scenario_id, scenario_name, status, seed, grid_cell_m, sim_hours, total_rain_mm, peak_flood_area_km2, peak_depth_m, peak_volume_m3, buildings_affected, poi_peaks, timeseries, started_at, finished_at')
      .order('started_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data ?? []) as RunRecord[];
  }
  return lsRead<RunRecord>(LS_RUNS).slice(0, limit);
}

export async function deleteRun(id: string) {
  if (mode === 'supabase' && client) {
    const { error } = await client.from('simulation_runs').delete().eq('id', id);
    if (error) throw error;
    return;
  }
  lsWrite(
    LS_RUNS,
    lsRead<RunRecord>(LS_RUNS).filter((r) => r.id !== id),
  );
}

// ───────────────────────────────────────────── important places

export async function loadPlaces(): Promise<Place[]> {
  if (mode !== 'supabase' || !client) return [];
  const { data, error } = await client
    .from('places')
    .select('id, name, name_en, category, kind, importance, lat, lon, x, y, ground_m')
    .order('importance', { ascending: false })
    .order('name');
  if (error) throw error;
  return (data ?? []) as Place[];
}

export interface PlaceImpactRow {
  run_id: string;
  place_id: string;
  max_depth_m: number;
  first_wet_hours: number | null;
}

export async function saveRunImpacts(rows: PlaceImpactRow[]) {
  if (mode !== 'supabase' || !client || !rows.length) return;
  const { error } = await client.from('run_place_impacts').upsert(rows);
  if (error) throw error;
}

// ───────────────────────────────────────────── API response cache

export async function cached<T>(cacheKey: string, maxAgeHours: number, fetcher: () => Promise<T>): Promise<T> {
  if (mode === 'supabase' && client) {
    const { data } = await client.from('weather_cache').select('payload, fetched_at').eq('key', cacheKey).maybeSingle();
    if (data && Date.now() - Date.parse(data.fetched_at) < maxAgeHours * 3600_000) return data.payload as T;
    const fresh = await fetcher();
    await client.from('weather_cache').upsert({ key: cacheKey, payload: fresh, fetched_at: new Date().toISOString() });
    return fresh;
  }
  return fetcher();
}
