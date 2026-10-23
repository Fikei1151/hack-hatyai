-- Results of the flood-rescue board game: one row per finished game, also used as a small leaderboard.
-- IF NOT EXISTS also supports local databases where this table was created manually during prototyping.
create table if not exists public.game_results (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  seed integer not null,
  difficulty text not null check (difficulty in ('easy', 'normal', 'hard')),
  rounds smallint not null check (rounds between 3 and 20),
  teams jsonb not null check (pg_column_size(teams) < 2048),
  district text not null check (char_length(district) <= 120),
  people_total smallint not null check (people_total between 0 and 500),
  people_saved smallint not null check (people_saved between 0 and 500),
  points integer not null check (points between 0 and 20000),
  stars smallint not null check (stars between 0 and 3),
  summary jsonb not null default '{}'::jsonb check (pg_column_size(summary) < 8192),
  check (people_saved <= people_total)
);

create index if not exists game_results_rank on public.game_results (difficulty, points desc);

alter table public.game_results enable row level security;

-- Unlike the prototype tables: anyone may read the leaderboard and add a result, nobody can edit or delete.
drop policy if exists "read results" on public.game_results;
drop policy if exists "add results" on public.game_results;
create policy "read results" on public.game_results for select to anon, authenticated using (true);
create policy "add results" on public.game_results for insert to anon, authenticated with check (true);

revoke update, delete, truncate, references, trigger on public.game_results from anon, authenticated;
grant select, insert on public.game_results to anon, authenticated;
