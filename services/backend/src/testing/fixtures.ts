/** Fictional fixtures only (CLAUDE.md non-negotiable 9). No real athlete data, ever. */
import { PROFILE_SCHEMA_VERSION, fictionalProfile, type AthleteProfile } from '@avanvu/core';
import type { Harness } from './harness';

export { fictionalProfile };

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
