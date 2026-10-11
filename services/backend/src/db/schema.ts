/**
 * Typed view of schema `app` for Kysely (D-12). Mirrors supabase/migrations. Only columns the backend
 * touches need to be listed; add columns here when code starts using them.
 * Timestamps come back as Date, bytea as Uint8Array/Buffer, jsonb as parsed JSON.
 */
import type { ColumnType, Generated } from 'kysely';

type Ts = ColumnType<Date, Date | string | undefined, Date | string>;
type Bytes = Uint8Array;
type Json = unknown;

export interface UsersTable {
  id: string;
  analytics_id: Generated<string>;
  time_zone: string | null;
  age_assurance_method: 'declared_age_range' | 'self_attested' | null;
  age_assured_at: Ts | null;
  demo_account: Generated<boolean>;
  deleted_at: Ts | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ConsentRecordsTable {
  id: Generated<string>;
  user_id: string;
  kind: 'privacy' | 'terms' | 'processing' | 'notifications' | 'analytics';
  version: string;
  accepted: boolean;
  created_at: Generated<Date>;
}

export interface UserDataKeysTable {
  user_id: string;
  key_version: number;
  wrapped_key: Bytes;
  kms_key_version: string;
  created_at: Generated<Date>;
}

export interface EventsTable {
  id: Generated<string>;
  user_id: string;
  name_enc: Bytes;
  starts_local: string;
  sport_label_enc: Bytes | null;
  time_zone: string;
  starts_at: Ts;
  status: Generated<'upcoming' | 'completed' | 'canceled'>;
  supported_sport_id: string;
  engine: string;
}

export interface IntakeConversationsTable {
  id: Generated<string>;
  user_id: string;
  event_id: string;
  state: Generated<string>;
  paused_from: string | null;
  phase: Generated<string>;
  revision: Generated<number>;
  follow_up_counters: Generated<Json>;
  athlete_turns: Generated<number>;
  active_seconds: Generated<number>;
  summary_confirmed_at: Ts | null;
}

export interface IntakeTurnsTable {
  id: Generated<string>;
  user_id: string;
  conversation_id: string;
  seq: number;
  role: 'athlete' | 'assistant';
  client_message_id: string | null;
  idempotency_key: string | null;
  status: 'processing' | 'committed' | 'safety_interrupted' | 'retryable_error';
  lease_expires_at: Ts | null;
  input_mode: 'text' | 'dictation' | 'quick_reply' | null;
  content_enc: Bytes | null;
  safety_result: 'none' | 'ambiguous' | 'crisis' | null;
  versions: Json | null;
  created_at: Generated<Date>;
}

export interface AthleteProfileDraftsTable {
  conversation_id: string;
  user_id: string;
  draft_enc: Bytes;
  updated_at: Generated<Date>;
}

export interface AthleteProfileVersionsTable {
  id: Generated<string>;
  user_id: string;
  event_id: string | null;
  version: number;
  source: 'intake' | 'edit' | 'debrief';
  profile_enc: Bytes;
  created_at: Generated<Date>;
}

export interface SessionsTable {
  id: Generated<string>;
  user_id: string;
  program_item_id: string | null;
  context: 'training' | 'night_before' | 'primer';
  length_min: 3 | 5 | 10 | 15;
  state: Generated<string>;
  attempt: Generated<number>;
  engine: string;
  profile_version_id: string;
  voice_id: string;
  track_id: string | null;
  audio_path: string | null;
  duration_ms: number | null;
  sha256: string | null;
  bytes: string | number | null;
  failure_code: string | null;
  creation_key: string;
  render_version: Generated<number>;
  ready_at: Ts | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface SessionScriptsTable {
  session_id: string;
  user_id: string;
  timeline_enc: Bytes;
  versions: Json;
  created_at: Generated<Date>;
}

export interface RenderJobsTable {
  id: Generated<string>;
  user_id: string;
  session_id: string;
  state: Generated<'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'>;
  attempt: Generated<number>;
  lease_owner: string | null;
  lease_expires_at: Ts | null;
  stage: string | null;
  last_error_code: string | null;
  timings: Json | null;
}

export interface OutboxEventsTable {
  id: Generated<string>;
  user_id: string;
  kind: string;
  subject_id: string;
  dispatch_generation: Generated<number>;
  dispatched_at: Ts | null;
  created_at: Generated<Date>;
}

export interface UsageLedgerTable {
  id: Generated<string>;
  user_id: string;
  allowance_type: 'free_training' | 'free_primer' | 'pro';
  bucket_start: Ts;
  bucket_end: Ts;
  entry_type: 'grant' | 'reserve' | 'reverse' | 'commit';
  quantity: number;
  session_id: string | null;
  idempotency_key: string;
  created_at: Generated<Date>;
}

export interface EntitlementsTable {
  user_id: string;
  active: boolean;
  period_type: 'normal' | 'trial' | 'intro' | null;
  product: string | null;
  expires_at: Ts | null;
  original_purchase_at: Ts | null;
  will_renew: boolean | null;
  billing_issue: boolean;
}

export interface IdempotencyKeysTable {
  user_id: string;
  endpoint: string;
  key: string;
  request_hash: string;
  status: 'processing' | 'completed';
  response_code: number | null;
  response_enc: Bytes | null;
  created_at: Generated<Date>;
  expires_at: Generated<Date>;
}

export interface RateLimitBucketsTable {
  subject: string;
  limit_name: string;
  tokens: number;
  updated_at: Generated<Date>;
}

export interface VendorUsageTable {
  id: Generated<string>;
  user_id: string | null;
  vendor: string;
  kind: string;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  characters: number | null;
  compute_seconds: number | null;
  est_cost_usd: number;
  created_at: Generated<Date>;
}

export interface SafetyEventsTable {
  id: Generated<string>;
  user_id: string | null;
  conversation_id: string | null;
  layer: 'deterministic' | 'model';
  outcome: 'crisis' | 'ambiguous';
  lexicon_version: string | null;
}

export interface WaitlistEntriesTable {
  id: Generated<string>;
  user_id: string;
  sport_label: string;
}

export interface SportEnginesTable {
  id: string;
  engine: string;
  label: string;
}

export interface VoiceCatalogTable {
  id: string;
  label: string;
  provider_voice_id: string;
  wpm: string | number;
  settings_version: string;
  sample_path: string | null;
  active: Generated<boolean>;
}

export interface MusicCatalogTable {
  id: string;
  style: 'ambient_warm' | 'ambient_airy' | 'low_drone' | 'pulse';
  duration_ms: number;
  storage_path: string;
  licence_reference_id: string;
  attribution: Generated<string>;
  active: Generated<boolean>;
}

export interface ProgramsTable {
  id: Generated<string>;
  user_id: string;
  event_id: string;
}

export interface ProgramItemsTable {
  id: Generated<string>;
  user_id: string;
  program_id: string;
  kind: 'training' | 'night_before' | 'primer' | 'debrief';
  target_date: string;
  generate_at: Ts | null;
  state: Generated<'planned' | 'generating' | 'ready' | 'skipped' | 'locked'>;
  session_id: string | null;
  core_scene: Json | null;
}

export interface DevicesTable {
  id: Generated<string>;
  user_id: string;
  push_token: string;
  platform: Generated<string>;
  app_version: string | null;
}

export interface DB {
  'app.users': UsersTable;
  'app.consent_records': ConsentRecordsTable;
  'app.user_data_keys': UserDataKeysTable;
  'app.events': EventsTable;
  'app.programs': ProgramsTable;
  'app.program_items': ProgramItemsTable;
  'app.devices': DevicesTable;
  'app.intake_conversations': IntakeConversationsTable;
  'app.intake_turns': IntakeTurnsTable;
  'app.athlete_profile_drafts': AthleteProfileDraftsTable;
  'app.athlete_profile_versions': AthleteProfileVersionsTable;
  'app.sessions': SessionsTable;
  'app.session_scripts': SessionScriptsTable;
  'app.render_jobs': RenderJobsTable;
  'app.outbox_events': OutboxEventsTable;
  'app.usage_ledger': UsageLedgerTable;
  'app.entitlements': EntitlementsTable;
  'app.idempotency_keys': IdempotencyKeysTable;
  'app.rate_limit_buckets': RateLimitBucketsTable;
  'app.vendor_usage': VendorUsageTable;
  'app.safety_events': SafetyEventsTable;
  'app.waitlist_entries': WaitlistEntriesTable;
  'app.sport_engines': SportEnginesTable;
  'app.voice_catalog': VoiceCatalogTable;
  'app.music_catalog': MusicCatalogTable;
}
