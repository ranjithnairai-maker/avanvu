/**
 * Session creation and lifecycle on the API side (SPEC §5.3, CONTRACTS §8). Creation reserves allowance,
 * creates the session (`reserved`, then `queued`), its render job and an outbox row in ONE transaction and
 * returns at once; the worker does everything else. Allowance is reversed on cancel and on failure.
 */
import { sql } from 'kysely';
import {
  AvanvuError,
  IN_PROGRESS_STATES,
  SESSION_LENGTHS,
  clientStatus,
  generationMinimumMissing,
  type SessionState,
} from '@avanvu/core';
import type { Tx } from '../db/tx';
import { withSystemTx, type Db } from '../db/tx';
import { addOutboxEvent } from './outbox';
import {
  loadEntitlement,
  reserveSession,
  reverseReservation,
  type AllowanceConfig,
  type SessionContext,
} from './ledger';
import { latestProfile } from './profile';
import type { UserSealer } from '../security/seal';

export const MAX_IN_PROGRESS = 2;

export interface CreateSessionInput {
  program_item_id: string | null;
  context: SessionContext;
  length_min: 3 | 5 | 10 | 15;
}

export interface SessionView {
  id: string;
  context: string;
  length_min: number;
  status: string;
  state: string;
  engine: string;
  created_at: string;
  ready_at: string | null;
  duration_ms: number | null;
  failure_code: string | null;
  program_item_id: string | null;
}

const SESSION_COLUMNS = [
  'id',
  'context',
  'length_min',
  'state',
  'engine',
  'created_at',
  'ready_at',
  'duration_ms',
  'failure_code',
  'program_item_id',
] as const;

export function present(row: {
  id: string;
  context: string;
  length_min: number;
  state: string;
  engine: string;
  created_at: Date | string;
  ready_at: Date | string | null;
  duration_ms: number | null;
  failure_code: string | null;
  program_item_id: string | null;
}): SessionView {
  return {
    id: row.id,
    context: row.context,
    length_min: row.length_min,
    status: clientStatus(row.state as SessionState),
    state: row.state,
    engine: row.engine,
    created_at: new Date(row.created_at).toISOString(),
    ready_at: row.ready_at ? new Date(row.ready_at).toISOString() : null,
    duration_ms: row.duration_ms,
    failure_code: row.failure_code,
    program_item_id: row.program_item_id,
  };
}

/** Server picks a licensed track in the athlete's chosen style (D-31). Deterministic per session. */
async function pickTrack(
  trx: Tx,
  context: SessionContext,
  style: string,
  sessionId: string,
): Promise<string | null> {
  const effective = style === 'voice_only' ? null : context === 'night_before' ? 'low_drone' : style;
  if (!effective) return null;
  const tracks = await trx
    .selectFrom('app.music_catalog')
    .select('id')
    .where('style', '=', effective as never)
    .where('active', '=', true)
    .orderBy('id')
    .execute();
  if (tracks.length === 0) return null;
  let h = 0;
  for (const ch of sessionId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (tracks[h % tracks.length] as { id: string }).id;
}

export async function createSession(
  trx: Tx,
  input: {
    userId: string;
    body: CreateSessionInput;
    creationKey: string;
    now: Date;
    cfg: AllowanceConfig;
    sealer: UserSealer;
  },
): Promise<{ session: SessionView; outboxId: string; created: boolean }> {
  const { userId, body, creationKey, now, cfg, sealer } = input;

  // A replayed creation key returns the existing session instead of a second one.
  const existing = await trx
    .selectFrom('app.sessions')
    .select(SESSION_COLUMNS)
    .where('creation_key', '=', creationKey)
    .executeTakeFirst();
  if (existing) return { session: present(existing), outboxId: '', created: false };

  if (!SESSION_LENGTHS[body.context].includes(body.length_min)) {
    throw new AvanvuError('VALIDATION_FAILED', 'Check these fields: length_min.');
  }

  const profile = await latestProfile(trx, sealer, userId);
  if (!profile || generationMinimumMissing(profile.profile, true).length > 0) {
    throw new AvanvuError('MINIMUM_PROFILE_INCOMPLETE', 'Finish your profile before creating a session.');
  }
  const voice = await trx
    .selectFrom('app.voice_catalog')
    .select('id')
    .where('id', '=', profile.profile.preferences.voice_id)
    .where('active', '=', true)
    .executeTakeFirst();
  if (!voice) throw new AvanvuError('VALIDATION_FAILED', 'Choose a voice in your delivery settings.');

  const inProgress = await trx
    .selectFrom('app.sessions')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('user_id', '=', userId)
    .where('state', 'in', IN_PROGRESS_STATES as never)
    .executeTakeFirst();
  if (Number(inProgress?.n ?? 0) >= MAX_IN_PROGRESS) {
    throw new AvanvuError('RATE_LIMITED', 'Two sessions are already being prepared. Try again shortly.', {
      retryAfterMs: 60_000,
    });
  }

  // Optional link to a program item: must be the athlete's own and match the context.
  let fromSpecialItem = false;
  if (body.program_item_id) {
    const item = await trx
      .selectFrom('app.program_items')
      .select(['id', 'kind', 'state'])
      .where('id', '=', body.program_item_id)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!item) throw new AvanvuError('NOT_FOUND', 'Program item not found.');
    if (item.kind !== body.context)
      throw new AvanvuError('VALIDATION_FAILED', 'Check these fields: context.');
    if (item.state === 'generating' || item.state === 'ready') {
      throw new AvanvuError('VALIDATION_FAILED', 'That session has already been created.');
    }
    fromSpecialItem = item.kind === 'night_before' || item.kind === 'primer';
  }

  const sessionId = crypto.randomUUID();
  const trackId = await pickTrack(trx, body.context, profile.profile.preferences.music_style, sessionId);
  await trx
    .insertInto('app.sessions')
    .values({
      id: sessionId,
      user_id: userId,
      program_item_id: body.program_item_id,
      context: body.context,
      length_min: body.length_min,
      state: 'reserved',
      engine: profile.profile.sport.engine,
      profile_version_id: profile.id,
      voice_id: voice.id,
      track_id: trackId,
      creation_key: creationKey,
    } as never)
    .execute();

  const ent = await loadEntitlement(trx, userId);
  await reserveSession(trx, {
    userId,
    sessionId,
    context: body.context,
    fromSpecialItem,
    now,
    ent,
    cfg,
  });

  await trx
    .updateTable('app.sessions')
    .set({ state: 'queued' })
    .where('id', '=', sessionId)
    .where('state', '=', 'reserved')
    .execute();
  const job = await trx
    .insertInto('app.render_jobs')
    .values({ user_id: userId, session_id: sessionId })
    .returning('id')
    .executeTakeFirstOrThrow();
  const outboxId = await addOutboxEvent(trx, { userId, kind: 'render', subjectId: job.id });
  if (body.program_item_id) {
    await trx
      .updateTable('app.program_items')
      .set({ state: 'generating', session_id: sessionId })
      .where('id', '=', body.program_item_id)
      .execute();
  }
  const row = await trx
    .selectFrom('app.sessions')
    .select(SESSION_COLUMNS)
    .where('id', '=', sessionId)
    .executeTakeFirstOrThrow();
  return { session: present(row), outboxId, created: true };
}

/** Cancel is allowed only from reserved or queued; it reverses the reservation. */
export async function cancelSession(trx: Tx, userId: string, sessionId: string): Promise<SessionView> {
  const row = await trx
    .selectFrom('app.sessions')
    .select(SESSION_COLUMNS)
    .where('id', '=', sessionId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!row) throw new AvanvuError('NOT_FOUND', 'Session not found.');
  if (row.state === 'canceled') return present(row);
  if (row.state !== 'reserved' && row.state !== 'queued') {
    throw new AvanvuError('VALIDATION_FAILED', "It's too late to cancel this session.");
  }
  // Compare-and-swap: the worker may have just started it.
  const cas = await trx
    .updateTable('app.sessions')
    .set({ state: 'canceled' })
    .where('id', '=', sessionId)
    .where('state', 'in', ['reserved', 'queued'])
    .executeTakeFirst();
  if (Number(cas.numUpdatedRows) !== 1) {
    throw new AvanvuError('VALIDATION_FAILED', "It's too late to cancel this session.");
  }
  await trx
    .updateTable('app.render_jobs')
    .set({ state: 'canceled' })
    .where('session_id', '=', sessionId)
    .execute();
  await reverseReservation(trx, userId, sessionId);
  await trx
    .updateTable('app.program_items')
    .set({ state: 'planned', session_id: null })
    .where('session_id', '=', sessionId)
    .execute();
  const after = await trx
    .selectFrom('app.sessions')
    .select(SESSION_COLUMNS)
    .where('id', '=', sessionId)
    .executeTakeFirstOrThrow();
  return present(after);
}

/** Total estimated vendor cost in the last 24 hours across all athletes (cost circuit breaker). */
export class CostGuard {
  constructor(
    private readonly db: Db,
    private readonly dailyCapUsd: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async spentLast24h(): Promise<number> {
    const since = new Date(this.now().getTime() - 86_400_000);
    return withSystemTx(this.db, 'api_system', async (trx) => {
      const r = await trx
        .selectFrom('app.vendor_usage')
        .select(sql<string>`coalesce(sum(est_cost_usd), 0)`.as('total'))
        .where('created_at', '>=', since)
        .executeTakeFirst();
      return Number(r?.total ?? 0);
    });
  }

  /** New generations pause above the cap; intake continues under its own cap (SPEC §11.3). */
  async assertGenerationAllowed(): Promise<void> {
    if ((await this.spentLast24h()) >= this.dailyCapUsd) {
      throw new AvanvuError(
        'GENERATION_PAUSED',
        "We're pausing new sessions for a short while. Your allowance wasn't used. Please try again later.",
        { retryAfterMs: 15 * 60_000 },
      );
    }
  }
}
