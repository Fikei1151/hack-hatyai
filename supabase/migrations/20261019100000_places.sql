-- Important places in Hat Yai (hospitals, schools, temples/mosques, markets, government, transport,
-- shelters, hotels…) extracted from OpenStreetMap by scripts/build-city.mjs, plus the flood impact
-- each simulation run had on them.

create extension if not exists postgis with schema extensions;

create table public.places (
  id text primary key, -- 'osm:node/123'
  name text not null,
  name_en text,
  category text not null
    check (category in ('health', 'education', 'religion', 'market', 'emergency', 'government', 'transport', 'lodging', 'landmark', 'shelter')),
  kind text not null,
  importance smallint not null default 5 check (importance between 1 and 10),
  lat double precision not null,
  lon double precision not null,
  -- local metres from the simulation origin (x east, y north) so the client needs no projection
  x real not null,
  y real not null,
  ground_m real,
  geog extensions.geography(point, 4326)
    generated always as (extensions.st_setsrid(extensions.st_makepoint(lon, lat), 4326)::extensions.geography) stored,
  tags jsonb not null default '{}'::jsonb,
  source text not null default 'OpenStreetMap',
  updated_at timestamptz not null default now()
);

create index places_category_idx on public.places (category, importance desc);
create index places_geog_idx on public.places using gist (geog);

-- Per-run flood impact on each place that got wet (max depth, when water first arrived).
create table public.run_place_impacts (
  run_id uuid not null references public.simulation_runs (id) on delete cascade,
  place_id text not null references public.places (id) on delete cascade,
  max_depth_m real not null,
  first_wet_hours real,
  primary key (run_id, place_id)
);

create index run_place_impacts_place_idx on public.run_place_impacts (place_id);

-- Places within a radius of a point, nearest first (e.g. "which hospitals are near this breach?").
create function public.places_near(p_lat double precision, p_lon double precision, p_radius_m double precision default 1000)
returns setof public.places
language sql stable set search_path = '' as $$
  select p.*
  from public.places p
  where extensions.st_dwithin(p.geog, extensions.st_setsrid(extensions.st_makepoint(p_lon, p_lat), 4326)::extensions.geography, p_radius_m)
  order by extensions.st_distance(p.geog, extensions.st_setsrid(extensions.st_makepoint(p_lon, p_lat), 4326)::extensions.geography);
$$;

alter table public.places enable row level security;
alter table public.run_place_impacts enable row level security;

-- Places are reference data: readable by everyone, written only by the seed (postgres role).
create policy "places are readable" on public.places for select to anon, authenticated using (true);
-- Same open prototype access as simulation_runs (see the first migration).
create policy "prototype open access" on public.run_place_impacts for all to anon, authenticated using (true) with check (true);

grant select on public.places to anon, authenticated;
grant select, insert, update, delete on public.run_place_impacts to anon, authenticated;
grant execute on function public.places_near (double precision, double precision, double precision) to anon, authenticated;
