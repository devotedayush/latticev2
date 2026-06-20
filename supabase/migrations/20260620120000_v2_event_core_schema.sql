-- ============================================================
-- Lattice V2 — event-sourced core: schema layer
-- Truth = utterances + append-only events. Snapshot = entities (derived).
-- ============================================================

-- new enums
do $$ begin create type lattice_event_kind as enum (
  'entity_created','entity_updated','owner_change','due_change','confidence_change',
  'status_change','blocker_emerged','blocker_resolved','goal_shift','scope_change',
  'assumption_changed','intervention_suggested','deferral','decline','retraction','note'
); exception when duplicate_object then null; end $$;

do $$ begin create type lattice_utterance_source as enum
  ('chat','voice','manual','seed','system');
exception when duplicate_object then null; end $$;

-- raw human input
create table if not exists public.utterances (
  id text primary key default ('utt-'||replace(gen_random_uuid()::text,'-','')),
  team_space_id text not null references public.team_spaces(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_name text,
  raw_text text not null,
  source lattice_utterance_source not null default 'chat',
  audio_ref text,
  interpretation jsonb,
  created_at timestamptz not null default now()
);
create index if not exists utterances_team_time_idx on public.utterances(team_space_id, created_at desc);

-- append-only source of truth
create table if not exists public.events (
  id text primary key default ('evt-'||replace(gen_random_uuid()::text,'-','')),
  team_space_id text not null references public.team_spaces(id) on delete cascade,
  seq bigint not null default 0,
  utterance_id text references public.utterances(id) on delete set null,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_name text,
  kind lattice_event_kind not null,
  entity_id text,
  entity_type orgmind_object_type,
  before jsonb,
  after jsonb,
  confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  supersedes text references public.events(id) on delete set null,
  retracted_at timestamptz,
  retracted_by uuid references auth.users(id) on delete set null,
  source text not null default 'interpretation',
  created_at timestamptz not null default now()
);
create index if not exists events_team_seq_idx   on public.events(team_space_id, seq);
create index if not exists events_entity_seq_idx  on public.events(entity_id, seq);
create index if not exists events_team_time_idx   on public.events(team_space_id, created_at desc);
create index if not exists events_supersedes_idx  on public.events(supersedes) where supersedes is not null;

-- derived snapshot of the seven primitives (replaces field_objects as a CACHE)
create table if not exists public.entities (
  id text primary key,
  team_space_id text not null references public.team_spaces(id) on delete cascade,
  type orgmind_object_type not null,
  title text not null default '',
  detail text not null default '',
  owner text,
  status text,
  confidence numeric not null default 0.7 check (confidence >= 0 and confidence <= 1),
  pulse text not null default 'quiet',
  links text[] not null default '{}',
  due_at timestamptz,
  deferred_until timestamptz,
  decline_reason text,
  conflict jsonb,
  last_event_seq bigint not null default 0,
  unowned boolean generated always as (owner is null or owner = '') stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists entities_team_idx      on public.entities(team_space_id, type);
create index if not exists entities_owner_idx      on public.entities(team_space_id, lower(owner));
create index if not exists entities_conflict_idx   on public.entities(team_space_id) where conflict is not null;

-- memoized derived views (brief / nudges / stats)
create table if not exists public.view_cache (
  team_space_id text not null references public.team_spaces(id) on delete cascade,
  key text not null,
  payload jsonb not null,
  computed_at timestamptz not null default now(),
  valid_until timestamptz,
  primary key (team_space_id, key)
);

-- RLS: reads symmetric within a team; events append-only
alter table public.utterances enable row level security;
alter table public.events     enable row level security;
alter table public.entities   enable row level security;
alter table public.view_cache enable row level security;

do $$ begin
  create policy utterances_member_read on public.utterances for select using (public.is_orgmind_team_member(team_space_id));
  create policy utterances_member_ins  on public.utterances for insert with check (public.is_orgmind_team_member(team_space_id));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy events_member_read on public.events for select using (public.is_orgmind_team_member(team_space_id));
  create policy events_member_ins  on public.events for insert with check (public.is_orgmind_team_member(team_space_id));
  create policy events_member_retract on public.events for update using (public.is_orgmind_team_member(team_space_id)) with check (public.is_orgmind_team_member(team_space_id));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy entities_member_read on public.entities for select using (public.is_orgmind_team_member(team_space_id));
  create policy entities_member_ins  on public.entities for insert with check (public.is_orgmind_team_member(team_space_id));
  create policy entities_member_upd  on public.entities for update using (public.is_orgmind_team_member(team_space_id)) with check (public.is_orgmind_team_member(team_space_id));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy view_cache_member_all on public.view_cache for all using (public.is_orgmind_team_member(team_space_id)) with check (public.is_orgmind_team_member(team_space_id));
exception when duplicate_object then null; end $$;

-- realtime: clients subscribe to events (primary) + entities (fallback)
do $$ begin alter publication supabase_realtime add table public.events;   exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.entities; exception when duplicate_object then null; end $$;
