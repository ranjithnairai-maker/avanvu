-- Avanvu app schema (SPEC §10, CONTRACTS §9, §11, §12).
-- All tables live in schema `app`, which is NOT exposed through the Supabase Data API (D-03).
-- anon and authenticated have no privileges here. The API connects as avanvu_api and the worker as
-- avanvu_worker: dedicated roles, no superuser, no BYPASSRLS. RLS is enabled and FORCED on every
-- user-owned table. Sensitive columns (🔒) are bytea envelopes written only through packages/core/crypto.

create schema if not exists app;

-- Roles are created without login or password. Operators enable login and set passwords outside the
-- repository (Secret Manager). Never put credentials in a migration.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'avanvu_api') then
    create role avanvu_api nologin noinherit nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'avanvu_worker') then
    create role avanvu_worker nologin noinherit nobypassrls;
  end if;
end $$;

revoke all on schema app from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on schema app from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on schema app from authenticated;
  end if;
end $$;
alter default privileges in schema app revoke all on tables from public;
grant usage on schema app to avanvu_api, avanvu_worker;

-- ---------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------

-- Time-ordered UUID v7 for row ids (CONTRACTS §1).
create or replace function app.uuid_v7() returns uuid
language sql volatile as $$
  select encode(
    set_bit(
      set_bit(
        overlay(uuid_send(gen_random_uuid())
          placing substring(int8send(floor(extract(epoch from clock_timestamp()) * 1000)::bigint) from 3)
          from 1 for 6),
        52, 1),
      53, 1),
    'hex')::uuid
$$;

-- The per-transaction identity set by withUserTx / withSystemTx (SPEC §10.2).
create or replace function app.current_user_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

create or replace function app.is_system() returns boolean
language sql stable as $$
  select coalesce(current_setting('app.actor', true), '') in ('worker', 'system', 'webhook', 'api_system')
$$;

create or replace function app.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

grant execute on function app.uuid_v7(), app.current_user_id(), app.is_system(), app.touch_updated_at()
  to avanvu_api, avanvu_worker;

-- ---------------------------------------------------------------------------------------------
-- Reference data (not user-owned): readable by both roles, written only by migrations.
-- ---------------------------------------------------------------------------------------------

create table app.sport_engines (
  id text primary key,
  engine text not null check (engine in
    ('endurance_v1', 'field_court_team_v1', 'bat_ball_team_v1', 'closed_skill_v1', 'opponent_rally_v1')),
  label text not null
);

create table app.voice_catalog (
  id text primary key,
  label text not null,
  provider_voice_id text not null,
  wpm numeric(5, 1) not null check (wpm between 60 and 200),
  settings_version text not null,
  sample_path text,
  active boolean not null default true
);

create table app.music_catalog (
  id text primary key,
  style text not null check (style in ('ambient_warm', 'ambient_airy', 'low_drone', 'pulse')),
  duration_ms integer not null check (duration_ms > 0),
  storage_path text not null,
  licence_reference_id text not null,
  attribution text not null default '',
  active boolean not null default true
);

-- ---------------------------------------------------------------------------------------------
-- Users and account
-- ---------------------------------------------------------------------------------------------

create table app.users (
  id uuid primary key,                       -- = Supabase auth user id
  analytics_id uuid not null default gen_random_uuid(),
  time_zone text,
  age_assurance_method text check (age_assurance_method in ('declared_age_range', 'self_attested')),
  age_assured_at timestamptz,
  demo_account boolean not null default false,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index users_analytics_id_key on app.users (analytics_id);

create table app.consent_records (
  id uuid primary key default app.uuid_v7(),
  user_id uuid not null references app.users (id) on delete cascade,
  kind text not null check (kind in ('privacy', 'terms', 'processing', 'notifications', 'analytics')),
  version text not null,
  accepted boolean not null,
  created_at timestamptz not null default now()
);
create index consent_records_user_idx on app.consent_records (user_id, kind, created_at desc);

create table app.user_data_keys (
  user_id uuid not null references app.users (id) on delete cascade,
  key_version integer not null,
  wrapped_key bytea not null,
  kms_key_version text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, key_version)
);

create table app.apple_tokens (
  user_id uuid primary key references app.users (id) on delete cascade,
  refresh_token_enc bytea not null,          -- 🔒
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table app.devices (
  id uuid primary key default app.uuid_v7(),
  user_id uuid not null references app.users (id) on delete cascade,
  push_token text not null,
  platform text not null default 'ios',
  app_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, push_token)
);

create table app.waitlist_entries (
  id uuid primary key default app.uuid_v7(),
  user_id uuid not null references app.users (id) on delete cascade,
  sport_label text not null check (char_length(sport_label) <= 60),
  created_at timestamptz not null default now()
);
create index waitlist_entries_user_idx on app.waitlist_entries (user_id);

-- ---------------------------------------------------------------------------------------------
-- Events and programs
-- ---------------------------------------------------------------------------------------------

create table app.events (
  id uuid primary key default app.uuid_v7(),
  user_id uuid not null references app.users (id) on delete cascade,
  name_enc bytea not null,                   -- 🔒
  starts_local timestamp not null,           -- local wall time; never stored without the zone below
  time_zone text not null,                   -- IANA, e.g. America/Toronto
  starts_at timestamptz not null,            -- computed by the API from starts_local + time_zone
  status text not null default 'upcoming' check (status in ('upcoming', 'completed', 'canceled')),
  supported_sport_id text not null references app.sport_engines (id),
  engine text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index events_user_idx on app.events (user_id, starts_at);

create table app.programs (
  id uuid primary key default app.uuid_v7(),
  user_id uuid not null references app.users (id) on delete cascade,
  event_id uuid not null references app.events (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id)
);
create index programs_user_idx on app.programs (user_id);

create table app.program_items (
  id uuid primary key default app.uuid_v7(),
  user_id uuid not null references app.users (id) on delete cascade,
  program_id uuid not null references app.programs (id) on delete cascade,
  kind text not null check (kind in ('training', 'night_before', 'primer', 'debrief')),
  target_date date not null,
  generate_at timestamptz,
  state text not null default 'planned' check (state in ('planned', 'generating', 'ready', 'skipped', 'locked')),
  session_id uuid,
  core_scene jsonb,                          -- item ids only, no text (SPEC §3.5)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index program_items_user_idx on app.program_items (user_id, target_date);
create index program_items_due_idx on app.program_items (generate_at)
  where state = 'planned' and generate_at is not null;

-- ---------------------------------------------------------------------------------------------
-- Intake
-- ---------------------------------------------------------------------------------------------

create table app.intake_conversations (
  id uuid primary key default app.uuid_v7(),
  user_id uuid not null references app.users (id) on delete cascade,
  event_id uuid not null references app.events (id) on delete cascade,
  state text not null default 'ACTIVE' check (state in
    ('ACTIVE', 'AWAITING_USER', 'PROCESSING_TURN', 'RETRYABLE_ERROR', 'READY_FOR_SUMMARY',
     'SUMMARY_CONFIRMED', 'COMPLETE', 'PAUSED', 'SAFETY_INTERRUPTED')),
  paused_from text,
  phase text not null default 'objective',
  revision integer not null default 0,
  follow_up_counters jsonb not null default '{}'::jsonb,   -- path -> count, no text
  athlete_turns integer not null default 0,
  active_seconds integer not null default 0,
  summary_confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index intake_conversations_user_idx on app.intake_conversations (user_id, created_at desc);
-- One live (non-terminal) conversation per event.
create unique index intake_conversations_one_active on app.intake_conversations (event_id)
  where state not in ('SAFETY_INTERRUPTED', 'COMPLETE');

create table app.intake_turns (
  id uuid primary key default app.uuid_v7(),
  user_id uuid not null references app.users (id) on delete cascade,
  conversation_id uuid not null references app.intake_conversations (id) on delete cascade,
  seq integer not null,
  role text not null check (role in ('athlete', 'assistant')),
  client_message_id uuid,
  idempotency_key uuid,
  status text not null check (status in ('processing', 'committed', 'safety_interrupted', 'retryable_error')),
  lease_expires_at timestamptz,
  input_mode text check (input_mode in ('text', 'dictation', 'quick_reply')),
  content_enc bytea,                         -- 🔒
  safety_result text check (safety_result in ('none', 'ambiguous', 'crisis')),
  versions jsonb,                            -- prompt hash, schema, model id, lexicon version
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (conversation_id, seq)
);
create unique index intake_turns_client_message_key on app.intake_turns (conversation_id, client_message_id)
  where client_message_id is not null;
-- At most one processing turn per conversation (CONTRACTS §4.3 step 4).
create unique index intake_turns_one_processing on app.intake_turns (conversation_id)
  where status = 'processing';
create index intake_turns_retention_idx on app.intake_turns (created_at);

create table app.athlete_profile_drafts (
  conversation_id uuid primary key references app.intake_conversations (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  draft_enc bytea not null,                  -- 🔒
  updated_at timestamptz not null default now()
);
create index athlete_profile_drafts_user_idx on app.athlete_profile_drafts (user_id);

create table app.athlete_profile_versions (
  id uuid primary key default app.uuid_v7(),
  user_id uuid not null references app.users (id) on delete cascade,
  event_id uuid references app.events (id) on delete set null,
  version integer not null,
  source text not null check (source in ('intake', 'edit', 'debrief')),
  profile_enc bytea not null,                -- 🔒 immutable
  created_at timestamptz not null default now(),
  unique (user_id, version)
);
create index athlete_profile_versions_user_idx on app.athlete_profile_versions (user_id, version desc);

-- ---------------------------------------------------------------------------------------------
-- Sessions and rendering
-- ---------------------------------------------------------------------------------------------

create table app.sessions (
  id uuid primary key default app.uuid_v7(),
  user_id uuid not null references app.users (id) on delete cascade,
  program_item_id uuid references app.program_items (id) on delete set null,
  context text not null check (context in ('training', 'night_before', 'primer')),
  length_min integer not null check (length_min in (3, 5, 10, 15)),
  state text not null default 'reserved' check (state in
    ('reserved', 'queued', 'generating_script', 'validating', 'synthesizing', 'mixing', 'uploading',
     'ready', 'failed', 'canceled')),
  attempt integer not null default 0,
  engine text not null,
  profile_version_id uuid not null references app.athlete_profile_versions (id),
  voice_id text not null references app.voice_catalog (id),
  track_id text references app.music_catalog (id),
  audio_path text,
  duration_ms integer,
  sha256 text,
  bytes bigint,
  failure_code text,
  creation_key text not null,
  render_version integer not null default 1,
  ready_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (creation_key)
);
create index sessions_user_idx on app.sessions (user_id, created_at desc);
create index sessions_state_idx on app.sessions (user_id, state);

create table app.session_scripts (
  session_id uuid primary key references app.sessions (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  timeline_enc bytea not null,               -- 🔒 validated session_timeline_v1
  versions jsonb not null,                   -- prompt hash, schema, models, effort, lexicon, engine, renderer, voice, track
  created_at timestamptz not null default now()
);
create index session_scripts_user_idx on app.session_scripts (user_id);

create table app.render_jobs (
  id uuid primary key default app.uuid_v7(),
  user_id uuid not null references app.users (id) on delete cascade,
  session_id uuid not null references app.sessions (id) on delete cascade,
  state text not null default 'queued' check (state in ('queued', 'running', 'succeeded', 'failed', 'canceled')),
  attempt integer not null default 0,
  lease_owner text,
  lease_expires_at timestamptz,
  stage text,
  last_error_code text,
  timings jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id)
);
create index render_jobs_user_idx on app.render_jobs (user_id);
create index render_jobs_active_idx on app.render_jobs (state, lease_expires_at);

create table app.outbox_events (
  id uuid primary key default app.uuid_v7(),
  user_id uuid not null references app.users (id) on delete cascade,
  kind text not null,                        -- render, export, delete_account, entitlement_sync, push
  subject_id uuid not null,
  dispatch_generation integer not null default 0,
  dispatched_at timestamptz,
  created_at timestamptz not null default now()
);
create index outbox_undispatched_idx on app.outbox_events (created_at) where dispatched_at is null;
create index outbox_user_idx on app.outbox_events (user_id);

create table app.session_plays (
  id uuid primary key default app.uuid_v7(),
  user_id uuid not null references app.users (id) on delete cascade,
  session_id uuid not null references app.sessions (id) on delete cascade,
  mark text not null check (mark in ('start', '25', '50', '80', '100')),
  position_ms integer not null default 0,
  occurred_at timestamptz not null,
  client_event_id uuid not null,
  created_at timestamptz not null default now(),
  unique (session_id, client_event_id)
);
create index session_plays_user_idx on app.session_plays (user_id, session_id);

create table app.session_downloads (
  id uuid primary key default app.uuid_v7(),
  user_id uuid not null references app.users (id) on delete cascade,
  session_id uuid not null references app.sessions (id) on delete cascade,
  device_id uuid references app.devices (id) on delete set null,
  sha256 text not null,
  bytes bigint not null,
  verified_at timestamptz not null default now(),
  unique (session_id, device_id)
);
create index session_downloads_user_idx on app.session_downloads (user_id);

create table app.checkins (
  id uuid primary key default app.uuid_v7(),
  user_id uuid not null references app.users (id) on delete cascade,
  session_id uuid not null references app.sessions (id) on delete cascade,
  vividness smallint not null check (vividness between 1 and 5),
  readiness smallint not null check (readiness between 1 and 5),
  useful_enc bytea,                          -- 🔒
  off_enc bytea,                             -- 🔒
  created_at timestamptz not null default now(),
  unique (session_id)
);
create index checkins_user_idx on app.checkins (user_id, created_at desc);

create table app.event_debriefs (
  id uuid primary key default app.uuid_v7(),
  user_id uuid not null references app.users (id) on delete cascade,
  event_id uuid not null references app.events (id) on delete cascade,
  overall smallint not null check (overall between 1 and 5),
  cue_helped text check (cue_helped in ('yes', 'somewhat', 'no', 'not_used')),
  answers_enc bytea not null,                -- 🔒
  proposals_enc bytea,                       -- 🔒
  confirmed_items jsonb,                     -- item ids only
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  unique (event_id)
);
create index event_debriefs_user_idx on app.event_debriefs (user_id);

-- ---------------------------------------------------------------------------------------------
-- Entitlements, ledger, vendors
-- ---------------------------------------------------------------------------------------------

create table app.entitlements (
  user_id uuid primary key references app.users (id) on delete cascade,
  active boolean not null default false,
  period_type text check (period_type in ('normal', 'trial', 'intro')),
  product text,
  expires_at timestamptz,
  original_purchase_at timestamptz,
  will_renew boolean,
  billing_issue boolean not null default false,
  updated_at timestamptz not null default now()
);

-- Append-only (CONTRACTS §11): no updates, ever. Deletion only through account deletion.
create table app.usage_ledger (
  id uuid primary key default app.uuid_v7(),
  user_id uuid not null references app.users (id) on delete cascade,
  allowance_type text not null check (allowance_type in ('free_training', 'free_primer', 'pro')),
  bucket_start timestamptz not null,
  bucket_end timestamptz not null,
  entry_type text not null check (entry_type in ('grant', 'reserve', 'reverse', 'commit')),
  quantity integer not null,
  session_id uuid references app.sessions (id) on delete set null,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  check (bucket_end > bucket_start)
);
create index usage_ledger_user_idx on app.usage_ledger (user_id, allowance_type, bucket_start);

create table app.webhook_events (
  id uuid primary key default app.uuid_v7(),
  vendor text not null,
  vendor_event_id text not null,
  received_at timestamptz not null default now(),
  state text not null default 'received' check (state in ('received', 'processed', 'failed')),
  unique (vendor, vendor_event_id)
);
create index webhook_events_received_idx on app.webhook_events (received_at);

create table app.vendor_usage (
  id uuid primary key default app.uuid_v7(),
  user_id uuid references app.users (id) on delete set null,
  vendor text not null,
  kind text not null,                        -- intake, script, judge, debrief, tts, compute
  model text,
  tokens_in integer,
  tokens_out integer,
  characters integer,
  compute_seconds numeric(10, 2),
  est_cost_usd numeric(10, 4) not null default 0,
  created_at timestamptz not null default now()
);
create index vendor_usage_created_idx on app.vendor_usage (created_at);

create table app.idempotency_keys (
  user_id uuid not null references app.users (id) on delete cascade,
  endpoint text not null,
  key uuid not null,
  request_hash text not null,
  status text not null check (status in ('processing', 'completed')),
  response_code integer,
  response_enc bytea,                        -- 🔒 stored response may contain athlete text
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  primary key (user_id, endpoint, key)
);
create index idempotency_keys_expiry_idx on app.idempotency_keys (expires_at);

create table app.rate_limit_buckets (
  subject text not null,                     -- user id or hashed IP
  limit_name text not null,
  tokens double precision not null,
  updated_at timestamptz not null default now(),
  primary key (subject, limit_name)
);

create table app.notification_deliveries (
  id uuid primary key default app.uuid_v7(),
  user_id uuid not null references app.users (id) on delete cascade,
  kind text not null,
  subject_id uuid not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'suppressed')),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (user_id, kind, subject_id)
);

create table app.safety_events (
  id uuid primary key default app.uuid_v7(),
  user_id uuid references app.users (id) on delete cascade,
  conversation_id uuid,
  layer text not null check (layer in ('deterministic', 'model')),
  outcome text not null check (outcome in ('crisis', 'ambiguous')),
  lexicon_version text,
  created_at timestamptz not null default now()
);
create index safety_events_created_idx on app.safety_events (created_at);

create table app.export_jobs (
  id uuid primary key default app.uuid_v7(),
  user_id uuid not null references app.users (id) on delete cascade,
  state text not null default 'queued' check (state in ('queued', 'running', 'ready', 'failed', 'expired')),
  storage_path text,
  expires_at timestamptz,
  attempt integer not null default 0,
  lease_owner text,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index export_jobs_user_idx on app.export_jobs (user_id, created_at desc);

-- Deliberately no FK to users: the job row must outlive the user rows it deletes.
create table app.deletion_jobs (
  id uuid primary key default app.uuid_v7(),
  user_id uuid not null,
  state text not null default 'queued' check (state in ('queued', 'running', 'completed', 'failed')),
  steps jsonb not null default '{}'::jsonb,
  attempt integer not null default 0,
  lease_owner text,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id)
);

-- Survives deletion; used to re-apply deletions after a backup restore (SPEC §10.5).
create table app.deletion_ledger (
  user_id uuid primary key,
  deleted_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'users', 'apple_tokens', 'devices', 'events', 'programs', 'program_items', 'intake_conversations',
    'intake_turns', 'sessions', 'render_jobs', 'entitlements', 'export_jobs', 'deletion_jobs'
  ] loop
    execute format(
      'create trigger %I before update on app.%I for each row execute function app.touch_updated_at()',
      t || '_touch', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Row level security: enabled AND forced on every table that holds user data (SPEC §10.2).
-- A row is visible when it belongs to the transaction's user, or the transaction runs as an
-- internal actor (worker, webhook, system). A query that forgets `where user_id = ...` still
-- cannot read another user's rows inside a user transaction.
-- ---------------------------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'consent_records', 'user_data_keys', 'apple_tokens', 'devices', 'waitlist_entries', 'events', 'programs',
    'program_items', 'intake_conversations', 'intake_turns', 'athlete_profile_drafts',
    'athlete_profile_versions', 'sessions', 'session_scripts', 'render_jobs', 'outbox_events', 'session_plays',
    'session_downloads', 'checkins', 'event_debriefs', 'entitlements', 'usage_ledger', 'vendor_usage',
    'idempotency_keys', 'notification_deliveries', 'safety_events', 'export_jobs'
  ] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
    execute format(
      'create policy user_isolation on app.%I for all using (user_id = app.current_user_id() or app.is_system()) '
      'with check (user_id = app.current_user_id() or app.is_system())', t);
  end loop;
end $$;

-- users: the row id is the user id.
alter table app.users enable row level security;
alter table app.users force row level security;
create policy user_isolation on app.users for all
  using (id = app.current_user_id() or app.is_system())
  with check (id = app.current_user_id() or app.is_system());

-- Internal-only tables: visible to internal actors, never to a user transaction.
do $$
declare t text;
begin
  foreach t in array array['webhook_events', 'rate_limit_buckets', 'deletion_jobs', 'deletion_ledger'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
    execute format('create policy internal_only on app.%I for all using (app.is_system()) with check (app.is_system())', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Grants: explicit and minimal. No role has BYPASSRLS; RLS above is the second line of defence.
-- ---------------------------------------------------------------------------------------------

grant select on app.sport_engines, app.voice_catalog, app.music_catalog to avanvu_api, avanvu_worker;

-- API: ordinary read/write on user data.
grant select, insert, update, delete on
  app.users, app.consent_records, app.user_data_keys, app.apple_tokens, app.devices, app.waitlist_entries,
  app.events, app.programs, app.program_items, app.intake_conversations, app.intake_turns,
  app.athlete_profile_drafts, app.sessions, app.render_jobs, app.outbox_events, app.session_plays,
  app.session_downloads, app.checkins, app.event_debriefs, app.entitlements, app.idempotency_keys,
  app.notification_deliveries, app.export_jobs
  to avanvu_api;
-- Profile versions are immutable; scripts are written by the worker; the ledger is append-only.
grant select, insert on app.athlete_profile_versions, app.usage_ledger, app.safety_events, app.vendor_usage to avanvu_api;
grant select on app.session_scripts to avanvu_api;
grant select, insert, update, delete on app.webhook_events, app.rate_limit_buckets, app.deletion_jobs to avanvu_api;
grant select, insert on app.deletion_ledger to avanvu_api;

-- Worker: renders, exports, deletion, entitlement sync, push.
grant select, update on app.users, app.sessions, app.render_jobs, app.export_jobs, app.entitlements,
  app.notification_deliveries, app.program_items, app.outbox_events to avanvu_worker;
grant insert on app.entitlements, app.notification_deliveries, app.export_jobs to avanvu_worker;
grant select on app.consent_records, app.user_data_keys, app.apple_tokens, app.devices, app.events, app.programs,
  app.intake_conversations, app.intake_turns, app.athlete_profile_drafts, app.athlete_profile_versions,
  app.session_plays, app.session_downloads, app.checkins, app.event_debriefs, app.waitlist_entries
  to avanvu_worker;
grant select, insert, update, delete on app.session_scripts to avanvu_worker;
grant select, insert on app.usage_ledger, app.vendor_usage, app.safety_events to avanvu_worker;
grant select, insert, update, delete on app.webhook_events, app.deletion_jobs to avanvu_worker;
grant select, insert on app.deletion_ledger to avanvu_worker;
-- Account deletion and retention purges (system actor only; policies above still apply).
grant delete on app.users, app.consent_records, app.user_data_keys, app.apple_tokens, app.devices,
  app.waitlist_entries, app.events, app.programs, app.program_items, app.intake_conversations,
  app.intake_turns, app.athlete_profile_drafts, app.athlete_profile_versions, app.sessions, app.render_jobs,
  app.outbox_events, app.session_plays, app.session_downloads, app.checkins, app.event_debriefs,
  app.entitlements, app.usage_ledger, app.vendor_usage, app.idempotency_keys, app.notification_deliveries,
  app.safety_events, app.export_jobs, app.rate_limit_buckets
  to avanvu_worker;
grant select, delete on app.idempotency_keys, app.rate_limit_buckets to avanvu_worker;
