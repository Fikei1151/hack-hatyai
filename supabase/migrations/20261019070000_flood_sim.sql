-- Hat Yai flood simulator: scenarios made of ordered phases, plus recorded simulation runs.

create table public.scenarios (
  id uuid primary key default gen_random_uuid(),
  slug text unique,
  name text not null,
  description text not null default '',
  source text not null default 'custom'
    check (source in ('custom', 'preset', 'random', 'forecast', 'historical')),
  seed integer not null default 1,
  start_time timestamptz,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.phases (
  id uuid primary key default gen_random_uuid(),
  scenario_id uuid not null references public.scenarios (id) on delete cascade,
  position integer not null,
  name text not null,
  color text not null default '#3b82f6',
  duration_hours real not null check (duration_hours > 0 and duration_hours <= 720),
  ramp_hours real not null default 0.5 check (ramp_hours >= 0),
  rain_mm_hr real not null default 0 check (rain_mm_hr between 0 and 400),
  rain_pattern text not null default 'uniform'
    check (rain_pattern in ('uniform', 'storm_cells', 'orographic', 'squall_line')),
  rain_variability real not null default 0.3 check (rain_variability between 0 and 1),
  storm_cells integer not null default 0 check (storm_cells between 0 and 16),
  wind_dir_deg real not null default 45,
  wind_speed_kmh real not null default 15 check (wind_speed_kmh >= 0),
  upstream_inflow_m3s real not null default 20 check (upstream_inflow_m3s >= 0),
  lake_level_m real not null default 1.0,
  drainage_mm_hr real not null default 30 check (drainage_mm_hr >= 0),
  infiltration_mm_hr real not null default 6 check (infiltration_mm_hr >= 0),
  events jsonb not null default '[]'::jsonb,
  notes text not null default '',
  unique (scenario_id, position)
);

create index phases_scenario_idx on public.phases (scenario_id, position);

create table public.simulation_runs (
  id uuid primary key default gen_random_uuid(),
  scenario_id uuid references public.scenarios (id) on delete set null,
  scenario_name text not null,
  scenario_snapshot jsonb not null,
  seed integer not null,
  grid_cell_m real not null,
  status text not null default 'running' check (status in ('running', 'completed', 'stopped')),
  sim_hours real not null default 0,
  total_rain_mm real,
  peak_flood_area_km2 real,
  peak_depth_m real,
  peak_volume_m3 double precision,
  buildings_affected integer,
  poi_peaks jsonb not null default '{}'::jsonb,
  timeseries jsonb not null default '[]'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index simulation_runs_started_idx on public.simulation_runs (started_at desc);

-- Cache of external weather/hydrology API responses (Open-Meteo, GloFAS) so replays work offline.
create table public.weather_cache (
  key text primary key,
  payload jsonb not null,
  fetched_at timestamptz not null default now()
);

create function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger scenarios_touch before update on public.scenarios
  for each row execute function public.touch_updated_at();

-- Upsert a scenario and replace its phases in one transaction.
create function public.save_scenario(p_scenario jsonb, p_phases jsonb) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
  v_id uuid := nullif(p_scenario ->> 'id', '')::uuid;
begin
  if v_id is null and p_scenario ? 'slug' then
    select id into v_id from public.scenarios where slug = p_scenario ->> 'slug';
  end if;

  if v_id is null then
    insert into public.scenarios (slug, name, description, source, seed, start_time, settings)
    values (
      p_scenario ->> 'slug',
      p_scenario ->> 'name',
      coalesce(p_scenario ->> 'description', ''),
      coalesce(p_scenario ->> 'source', 'custom'),
      coalesce((p_scenario ->> 'seed')::integer, 1),
      (p_scenario ->> 'start_time')::timestamptz,
      coalesce(p_scenario -> 'settings', '{}'::jsonb)
    )
    returning id into v_id;
  else
    insert into public.scenarios (id, slug, name, description, source, seed, start_time, settings)
    values (
      v_id,
      p_scenario ->> 'slug',
      p_scenario ->> 'name',
      coalesce(p_scenario ->> 'description', ''),
      coalesce(p_scenario ->> 'source', 'custom'),
      coalesce((p_scenario ->> 'seed')::integer, 1),
      (p_scenario ->> 'start_time')::timestamptz,
      coalesce(p_scenario -> 'settings', '{}'::jsonb)
    )
    on conflict (id) do update set
      slug = excluded.slug,
      name = excluded.name,
      description = excluded.description,
      source = excluded.source,
      seed = excluded.seed,
      start_time = excluded.start_time,
      settings = excluded.settings;
  end if;

  delete from public.phases where scenario_id = v_id;

  insert into public.phases (
    scenario_id, position, name, color, duration_hours, ramp_hours, rain_mm_hr, rain_pattern,
    rain_variability, storm_cells, wind_dir_deg, wind_speed_kmh, upstream_inflow_m3s,
    lake_level_m, drainage_mm_hr, infiltration_mm_hr, events, notes
  )
  select
    v_id,
    (e.ord - 1)::integer,
    e.p ->> 'name',
    coalesce(e.p ->> 'color', '#3b82f6'),
    (e.p ->> 'duration_hours')::real,
    coalesce((e.p ->> 'ramp_hours')::real, 0.5),
    coalesce((e.p ->> 'rain_mm_hr')::real, 0),
    coalesce(e.p ->> 'rain_pattern', 'uniform'),
    coalesce((e.p ->> 'rain_variability')::real, 0.3),
    coalesce((e.p ->> 'storm_cells')::integer, 0),
    coalesce((e.p ->> 'wind_dir_deg')::real, 45),
    coalesce((e.p ->> 'wind_speed_kmh')::real, 15),
    coalesce((e.p ->> 'upstream_inflow_m3s')::real, 20),
    coalesce((e.p ->> 'lake_level_m')::real, 1.0),
    coalesce((e.p ->> 'drainage_mm_hr')::real, 30),
    coalesce((e.p ->> 'infiltration_mm_hr')::real, 6),
    coalesce(e.p -> 'events', '[]'::jsonb),
    coalesce(e.p ->> 'notes', '')
  from jsonb_array_elements(p_phases) with ordinality as e (p, ord);

  return v_id;
end $$;

-- Local prototype: the browser talks to the database with the anon key and there is no login yet,
-- so every table is open to anon. Tighten these policies before exposing the project publicly.
alter table public.scenarios enable row level security;
alter table public.phases enable row level security;
alter table public.simulation_runs enable row level security;
alter table public.weather_cache enable row level security;

create policy "prototype open access" on public.scenarios for all to anon, authenticated using (true) with check (true);
create policy "prototype open access" on public.phases for all to anon, authenticated using (true) with check (true);
create policy "prototype open access" on public.simulation_runs for all to anon, authenticated using (true) with check (true);
create policy "prototype open access" on public.weather_cache for all to anon, authenticated using (true) with check (true);

grant select, insert, update, delete on public.scenarios, public.phases, public.simulation_runs, public.weather_cache
  to anon, authenticated;
grant execute on function public.save_scenario (jsonb, jsonb) to anon, authenticated;
