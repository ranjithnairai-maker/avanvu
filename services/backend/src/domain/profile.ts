/** Confirmed profile versions (CONTRACTS §3): immutable, sealed, one new version per confirmed change. */
import {
  AvanvuError,
  PROFILE_SCHEMA_VERSION,
  athleteProfileSchema,
  recomputeStatuses,
  type AthleteProfile,
} from '@avanvu/core';
import type { Tx } from '../db/tx';
import type { UserSealer } from '../security/seal';

const versionCtx = (id: string) => ({
  table: 'athlete_profile_versions',
  column: 'profile_enc',
  rowId: id,
  schemaVersion: PROFILE_SCHEMA_VERSION,
});

export interface StoredProfile {
  id: string;
  version: number;
  source: 'intake' | 'edit' | 'debrief';
  event_id: string | null;
  profile: AthleteProfile;
  created_at: Date;
}

export async function latestProfile(
  trx: Tx,
  sealer: UserSealer,
  userId: string,
): Promise<StoredProfile | null> {
  const row = await trx
    .selectFrom('app.athlete_profile_versions')
    .selectAll()
    .where('user_id', '=', userId)
    .orderBy('version', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row ? open(sealer, row) : null;
}

export async function profileById(
  trx: Tx,
  sealer: UserSealer,
  userId: string,
  id: string,
): Promise<StoredProfile | null> {
  const row = await trx
    .selectFrom('app.athlete_profile_versions')
    .selectAll()
    .where('id', '=', id)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return row ? open(sealer, row) : null;
}

async function open(
  sealer: UserSealer,
  row: {
    id: string;
    version: number;
    source: 'intake' | 'edit' | 'debrief';
    event_id: string | null;
    profile_enc: Uint8Array;
    created_at: Date;
  },
): Promise<StoredProfile> {
  const profile = await sealer.open<AthleteProfile>(versionCtx(row.id), row.profile_enc);
  return {
    id: row.id,
    version: row.version,
    source: row.source,
    event_id: row.event_id,
    profile,
    created_at: new Date(row.created_at),
  };
}

/** Validates the whole profile, refreshes field statuses, and stores it as the next immutable version. */
export async function createProfileVersion(
  trx: Tx,
  sealer: UserSealer,
  userId: string,
  profile: AthleteProfile,
  source: 'intake' | 'edit' | 'debrief',
  eventId: string | null,
): Promise<StoredProfile> {
  const next: AthleteProfile = { ...profile, field_status: recomputeStatuses(profile) };
  const parsed = athleteProfileSchema.safeParse(next);
  if (!parsed.success) throw new AvanvuError('VALIDATION_FAILED', 'That change does not fit the profile.');
  const max = await trx
    .selectFrom('app.athlete_profile_versions')
    .select((eb) => eb.fn.max('version').as('m'))
    .where('user_id', '=', userId)
    .executeTakeFirst();
  const version = Number(max?.m ?? 0) + 1;
  const id = crypto.randomUUID();
  await trx
    .insertInto('app.athlete_profile_versions')
    .values({
      id,
      user_id: userId,
      event_id: eventId,
      version,
      source,
      profile_enc: await sealer.seal(versionCtx(id), parsed.data),
    } as never)
    .execute();
  return {
    id,
    version,
    source,
    event_id: eventId,
    profile: parsed.data as AthleteProfile,
    created_at: new Date(),
  };
}
