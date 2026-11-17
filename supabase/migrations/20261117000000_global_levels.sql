-- Global levels, their replay-verified leaderboard, and admin unlock attempts.
-- Everyone can read levels and leaderboards. Only the `api` Edge Function (service role)
-- can write anything, after checking the admin password or re-running a replay.

create table public.global_levels (
  id uuid primary key default gen_random_uuid(),
  -- the admin's local level id, so "Update global" replaces the right one
  source_id text not null unique,
  name text not null check (char_length(name) between 1 and 60),
  data jsonb not null,
  level_hash text not null check (level_hash ~ '^[0-9a-f]{8}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.runs (
  id uuid primary key default gen_random_uuid(),
  level_id uuid not null references public.global_levels (id) on delete cascade,
  name text not null check (name ~ '^[A-Z0-9 ._-]{1,8}$'),
  -- worked out by the server re-running the replay, never taken from the client
  ticks integer not null check (ticks > 0),
  replay jsonb not null,
  created_at timestamptz not null default now(),
  unique (level_id, name)
);

create index runs_level_ticks on public.runs (level_id, ticks, created_at);

create table public.admin_attempts (
  id bigserial primary key,
  ip text not null,
  ok boolean not null,
  at timestamptz not null default now()
);

create index admin_attempts_at on public.admin_attempts (at);

alter table public.global_levels enable row level security;
alter table public.runs enable row level security;
alter table public.admin_attempts enable row level security;

create policy "global levels are public" on public.global_levels for select using (true);
create policy "runs are public" on public.runs for select using (true);
-- admin_attempts has no policies: only the service role can see or write it

revoke insert, update, delete on public.global_levels from anon, authenticated;
revoke insert, update, delete on public.runs from anon, authenticated;
revoke all on public.admin_attempts from anon, authenticated;
