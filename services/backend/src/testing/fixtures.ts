/** Fictional fixtures only (CLAUDE.md non-negotiable 9). No real athlete data, ever. */
import {
  PROFILE_SCHEMA_VERSION,
  applyProfileUpdates,
  createEmptyProfile,
  recomputeStatuses,
  type AthleteProfile,
  type Engine,
  type ProfileUpdate,
} from '@avanvu/core';
import type { Harness } from './harness';

const up = (op: ProfileUpdate['op'], path: string, value = ''): ProfileUpdate => ({
  op,
  path,
  value,
  item_id: '',
});
const km = (label: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ label, description: `${label} during the event`, ...extra });

export interface FictionalOptions {
  engine?: Engine;
  sportId?: string;
  sportLabel?: string;
  cue?: string;
  intention?: string;
  voiceId?: string;
  fearedSelf?: boolean;
  skipPeople?: boolean;
}

/** A complete confirmed profile for a fictional athlete. */
export function fictionalProfile(o: FictionalOptions = {}): AthleteProfile {
  const base = createEmptyProfile({
    supportedSportId: o.sportId ?? 'running_road',
    engine: o.engine ?? 'endurance_v1',
    sportLabel: o.sportLabel ?? 'Road marathon',
    voiceId: o.voiceId ?? 'voice_a',
  });
  const updates: ProfileUpdate[] = [
    up('set', 'objective.primary', 'Finish feeling in control of my race'),
    up('set', 'objective.process_success', 'Hold my planned pace through the first half'),
    up('add_item', 'scene.visual', 'Banners at the start line'),
    up('add_item', 'scene.visual', 'Runners in bright jackets'),
    up('add_item', 'scene.visual', 'Mist over the river'),
    up('add_item', 'scene.sounds', 'Cowbells and cheering'),
    up('add_item', 'scene.sounds', 'Shoes on wet pavement'),
    up('set', 'performance.routine', 'Shake out my arms, three slow breaths, first step'),
    up('add_item', 'performance.key_moments', km('The start', { realtime_seconds: 20 })),
    up('add_item', 'performance.key_moments', km('Kilometre thirty two', { body_feel: 'Heavy legs' })),
    up('set', 'obstacles.hardest_moment', 'Heavy legs and doubt after the bridge'),
    up(
      'add_item',
      'responses.if_then',
      JSON.stringify({ when: 'my legs get heavy', then: 'I shorten my stride and breathe out' }),
    ),
    up('set', 'responses.cue_phrase', o.cue ?? 'Smooth and steady'),
    up('set', 'identity.hoped_self', 'Relaxed shoulders, quiet mind, steady stride'),
    up('set', 'identity.intention', o.intention ?? 'I run my own race'),
    up('set', 'outcome.body', 'Tired, proud, loose shoulders'),
    up('set', 'outcome.emotion', 'Quiet pride'),
  ];
  if (o.fearedSelf)
    updates.push(up('set', 'identity.feared_self', 'Someone who panics and stops running his own race'));
  if (o.skipPeople) updates.push(up('mark_skipped', 'outcome.people'));
  const applied = applyProfileUpdates(base, updates).profile;
  applied.field_status = recomputeStatuses(applied);
  return { ...applied, schema_version: PROFILE_SCHEMA_VERSION };
}

export async function seedCatalog(h: Harness): Promise<void> {
  await h.db.pg.exec(`
    insert into app.voice_catalog (id, label, provider_voice_id, wpm, settings_version) values
      ('voice_a', 'Voice A', 'prov_a', 100, 's1'), ('voice_b', 'Voice B', 'prov_b', 110, 's1')
      on conflict do nothing;
    insert into app.music_catalog (id, style, duration_ms, storage_path, licence_reference_id) values
      ('warm_1', 'ambient_warm', 180000, 'music/warm_1.wav', 'lic-test'),
      ('drone_1', 'low_drone', 180000, 'music/drone_1.wav', 'lic-test'),
      ('pulse_1', 'pulse', 180000, 'music/pulse_1.wav', 'lic-test')
      on conflict do nothing;`);
}

/** Inserts a sealed confirmed profile version for the user; returns its id and version. */
export async function seedProfile(
  h: Harness,
  userId: string,
  profile: AthleteProfile = fictionalProfile(),
  version?: number,
): Promise<{ id: string; version: number }> {
  await h.deps.accounts.check(userId);
  const sealer = await h.sealer.forUser(userId);
  const id = crypto.randomUUID();
  const existing = await h.db.admin.kysely
    .selectFrom('app.athlete_profile_versions')
    .select((eb) => eb.fn.max('version').as('m'))
    .where('user_id', '=', userId)
    .executeTakeFirst();
  const v = version ?? Number(existing?.m ?? 0) + 1;
  const enc = await sealer.seal(
    {
      table: 'athlete_profile_versions',
      column: 'profile_enc',
      rowId: id,
      schemaVersion: PROFILE_SCHEMA_VERSION,
    },
    profile,
  );
  await h.db.admin.kysely
    .insertInto('app.athlete_profile_versions')
    .values({ id, user_id: userId, version: v, source: 'intake', profile_enc: enc } as never)
    .execute();
  return { id, version: v };
}

/** Marks a user as an active Pro subscriber (entitlement snapshot only; no purchase involved). */
export async function grantPro(
  h: Harness,
  userId: string,
  type: 'normal' | 'trial' = 'normal',
): Promise<void> {
  await h.deps.accounts.check(userId);
  await h.db.pg.exec(`
    insert into app.entitlements (user_id, active, period_type, product, expires_at, original_purchase_at, will_renew)
    values ('${userId}', true, '${type}', 'pro_monthly', '2027-10-01T00:00:00Z', '2026-10-01T09:00:00Z', true)
    on conflict (user_id) do update set active = true, period_type = '${type}'`);
}
