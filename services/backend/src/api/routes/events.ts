/** Events and programs: POST/PATCH/GET /events, GET /programs/:id (SPEC §5.1, §11.1). */
import { sql } from 'kysely';
import type { Hono } from 'hono';
import {
  AvanvuError,
  MAX_EVENT_MONTHS_AHEAD,
  addMonthsUtc,
  eventCreateBodySchema,
  eventPatchBodySchema,
  getSport,
  isCustomEnduranceEligible,
  isValidTimeZone,
  parseLocal,
  zonedLocalToUtc,
} from '@avanvu/core';
import { withUserTx, type Tx } from '../../db/tx';
import { allowanceSummary, loadEntitlement, isProActive } from '../../domain/ledger';
import { planProgram, recomputeGenerateAt, type PlannedItem } from '../../domain/program';
import { LIMITS } from '../../http/ratelimit';
import type { UserSealer } from '../../security/seal';
import { mutate, type AppDeps, type AppEnv } from '../context';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nameCtx = (rowId: string) => ({
  table: 'events',
  column: 'name_enc',
  rowId,
  schemaVersion: 'event_name_v1',
});
const labelCtx = (rowId: string) => ({
  table: 'events',
  column: 'sport_label_enc',
  rowId,
  schemaVersion: 'sport_label_v1',
});

function resolveStart(startsLocal: string, zone: string, now: Date): Date {
  if (!isValidTimeZone(zone)) throw new AvanvuError('VALIDATION_FAILED', 'Check these fields: time_zone.');
  try {
    parseLocal(startsLocal);
  } catch {
    throw new AvanvuError('VALIDATION_FAILED', 'Check these fields: starts_local.');
  }
  const startsAt = zonedLocalToUtc(startsLocal, zone);
  if (startsAt <= now)
    throw new AvanvuError(
      'VALIDATION_FAILED',
      'Check these fields: starts_local (it must be in the future).',
    );
  if (startsAt > addMonthsUtc(now, MAX_EVENT_MONTHS_AHEAD)) {
    throw new AvanvuError('VALIDATION_FAILED', 'Check these fields: starts_local (up to 12 months ahead).');
  }
  return startsAt;
}

async function insertItems(
  trx: Tx,
  userId: string,
  programId: string,
  items: readonly PlannedItem[],
): Promise<void> {
  if (items.length === 0) return;
  await trx
    .insertInto('app.program_items')
    .values(
      items.map((i) => ({
        user_id: userId,
        program_id: programId,
        kind: i.kind,
        target_date: i.target_date,
        generate_at: i.generate_at,
      })),
    )
    .execute();
}

/** Selects an event with its local start as text, so no JS time zone parsing ever touches it. */
export const selectEvent = (trx: Tx) =>
  trx
    .selectFrom('app.events')
    .select([
      'id',
      'name_enc',
      'sport_label_enc',
      'time_zone',
      'starts_at',
      'status',
      'supported_sport_id',
      'engine',
      sql<string>`to_char(starts_local, 'YYYY-MM-DD"T"HH24:MI')`.as('starts_local'),
    ]);

export interface EventRow {
  id: string;
  name_enc: Uint8Array;
  sport_label_enc: Uint8Array | null;
  starts_local: string;
  time_zone: string;
  starts_at: Date | string;
  status: string;
  supported_sport_id: string;
  engine: string;
}

export async function presentEvent(sealer: UserSealer, row: EventRow, programId: string | null) {
  return {
    id: row.id,
    name: await sealer.open<string>(nameCtx(row.id), row.name_enc),
    sport_label: row.sport_label_enc
      ? await sealer.open<string>(labelCtx(row.id), row.sport_label_enc)
      : null,
    starts_local: row.starts_local,
    time_zone: row.time_zone,
    starts_at: new Date(row.starts_at).toISOString(),
    status: row.status,
    supported_sport_id: row.supported_sport_id,
    engine: row.engine,
    program_id: programId,
  };
}

export function registerEventRoutes(api: Hono<AppEnv>, deps: AppDeps): void {
  api.post('/events', (c) =>
    mutate(
      c,
      deps,
      { endpoint: 'POST /v1/events', schema: eventCreateBodySchema, limit: LIMITS.accountMutations },
      async ({ trx, body, userId, sealer, now }) => {
        const sport = getSport(body.supported_sport_id);
        if (!sport) throw new AvanvuError('UNSUPPORTED_SPORT', "We don't support that sport yet.");
        let label = sport.label;
        if (sport.id === 'custom_endurance') {
          if (!body.custom_label || !body.custom_answers || !isCustomEnduranceEligible(body.custom_answers)) {
            throw new AvanvuError('UNSUPPORTED_SPORT', "We can't build sessions for that event yet.");
          }
          label = body.custom_label;
        }
        const startsAt = resolveStart(body.starts_local, body.time_zone, now);

        const id = crypto.randomUUID();
        await trx
          .insertInto('app.events')
          .values({
            id,
            user_id: userId,
            name_enc: await sealer.seal(nameCtx(id), body.name),
            sport_label_enc: await sealer.seal(labelCtx(id), label),
            starts_local: body.starts_local.replace('T', ' '),
            time_zone: body.time_zone,
            starts_at: startsAt,
            supported_sport_id: sport.id,
            engine: sport.engine,
          } as never)
          .execute();
        const program = await trx
          .insertInto('app.programs')
          .values({ user_id: userId, event_id: id })
          .returning('id')
          .executeTakeFirstOrThrow();
        await insertItems(
          trx,
          userId,
          program.id,
          planProgram({ startsAt, timeZone: body.time_zone, now, trainingDays: body.training_days }),
        );
        const row = await selectEvent(trx).where('id', '=', id).executeTakeFirstOrThrow();
        return { status: 201, body: await presentEvent(sealer, row as unknown as EventRow, program.id) };
      },
    ),
  );

  api.get('/events/:id', async (c) => {
    const id = c.req.param('id');
    if (!UUID.test(id)) throw new AvanvuError('NOT_FOUND', 'Event not found.');
    const userId = c.get('userId');
    const sealer = await deps.sealer.forUser(userId);
    const out = await withUserTx(deps.db, userId, async (trx) => {
      const row = await selectEvent(trx)
        .where('id', '=', id)
        .where('user_id', '=', userId)
        .executeTakeFirst();
      if (!row) throw new AvanvuError('NOT_FOUND', 'Event not found.');
      const program = await trx
        .selectFrom('app.programs')
        .select('id')
        .where('event_id', '=', id)
        .executeTakeFirst();
      return presentEvent(sealer, row as unknown as EventRow, program?.id ?? null);
    });
    return c.json(out);
  });

  api.patch('/events/:id', (c) =>
    mutate(
      c,
      deps,
      { endpoint: 'PATCH /v1/events/:id', schema: eventPatchBodySchema, limit: LIMITS.accountMutations },
      async ({ trx, body, userId, sealer, now }) => {
        const id = c.req.param('id');
        if (!UUID.test(id)) throw new AvanvuError('NOT_FOUND', 'Event not found.');
        const row = await selectEvent(trx)
          .where('id', '=', id)
          .where('user_id', '=', userId)
          .executeTakeFirst();
        if (!row) throw new AvanvuError('NOT_FOUND', 'Event not found.');
        const current = row as unknown as EventRow;

        const startsLocal = body.starts_local ?? current.starts_local;
        const zone = body.time_zone ?? current.time_zone;
        const timeChanged = body.starts_local !== undefined || body.time_zone !== undefined;
        const startsAt = timeChanged ? resolveStart(startsLocal, zone, now) : new Date(current.starts_at);

        await trx
          .updateTable('app.events')
          .set({
            ...(body.name !== undefined ? { name_enc: await sealer.seal(nameCtx(id), body.name) } : {}),
            ...(timeChanged
              ? { starts_local: startsLocal.replace('T', ' '), time_zone: zone, starts_at: startsAt }
              : {}),
          } as never)
          .where('id', '=', id)
          .execute();

        let sessionsAffected = 0;
        if (timeChanged) {
          const program = await trx
            .selectFrom('app.programs')
            .select('id')
            .where('event_id', '=', id)
            .executeTakeFirstOrThrow();
          const items = await trx
            .selectFrom('app.program_items')
            .select(['id', 'kind', 'state'])
            .where('program_id', '=', program.id)
            .execute();
          sessionsAffected = items.filter((i) => i.state === 'ready' || i.state === 'generating').length;
          // Rebuild what has not been generated; keep items that already have a session.
          const kept = items.filter((i) => i.state !== 'planned');
          await trx
            .deleteFrom('app.program_items')
            .where('program_id', '=', program.id)
            .where('state', '=', 'planned')
            .execute();
          const keptSpecial = new Set<string>(
            kept.map((k) => k.kind).filter((k) => k === 'night_before' || k === 'primer'),
          );
          const fresh = planProgram({ startsAt, timeZone: zone, now }).filter(
            (i) =>
              !keptSpecial.has(i.kind) && !(i.kind === 'debrief' && kept.some((k) => k.kind === 'debrief')),
          );
          await insertItems(
            trx,
            userId,
            program.id,
            fresh.map((i) => ({ ...i, generate_at: recomputeGenerateAt(i.kind, startsAt, now) })),
          );
        }
        const updated = await selectEvent(trx).where('id', '=', id).executeTakeFirstOrThrow();
        const program = await trx
          .selectFrom('app.programs')
          .select('id')
          .where('event_id', '=', id)
          .executeTakeFirst();
        return {
          status: 200,
          body: {
            ...(await presentEvent(sealer, updated as unknown as EventRow, program?.id ?? null)),
            generated_sessions_unaffected: sessionsAffected,
          },
        };
      },
    ),
  );

  api.get('/programs/:id', async (c) => {
    const id = c.req.param('id');
    if (!UUID.test(id)) throw new AvanvuError('NOT_FOUND', 'Program not found.');
    const userId = c.get('userId');
    const now = deps.now();
    const out = await withUserTx(deps.db, userId, async (trx) => {
      const program = await trx
        .selectFrom('app.programs')
        .selectAll()
        .where('id', '=', id)
        .where('user_id', '=', userId)
        .executeTakeFirst();
      if (!program) throw new AvanvuError('NOT_FOUND', 'Program not found.');
      const items = await trx
        .selectFrom('app.program_items')
        .select(['id', 'kind', 'target_date', 'generate_at', 'state', 'session_id'])
        .where('program_id', '=', id)
        .orderBy('target_date')
        .orderBy('kind')
        .execute();
      const ent = await loadEntitlement(trx, userId);
      const pro = isProActive(ent, now);
      const allowance = await allowanceSummary(trx, userId, ent, now);
      // Free users see the whole program; items beyond their free grant show a lock (SPEC §5.1).
      let freeTraining =
        allowance.free_training + items.filter((i) => i.kind === 'training' && i.session_id).length;
      return {
        id,
        event_id: program.event_id,
        items: items.map((i) => {
          let locked = false;
          if (!pro && i.state !== 'ready' && i.state !== 'generating') {
            if (i.kind === 'night_before') locked = true;
            if (i.kind === 'training') {
              if (freeTraining > 0) freeTraining--;
              else locked = true;
            }
          }
          return {
            id: i.id,
            kind: i.kind,
            target_date: String(i.target_date).slice(0, 10),
            generate_at: i.generate_at ? new Date(i.generate_at).toISOString() : null,
            state: i.state,
            session_id: i.session_id,
            locked,
          };
        }),
      };
    });
    return c.json(out);
  });
}
