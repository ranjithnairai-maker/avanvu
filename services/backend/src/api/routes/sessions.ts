/** Session endpoints (SPEC §11.1): create, list, status, cancel, delete, transcript, download, plays, check-in. */
import type { Hono } from 'hono';
import { z } from 'zod';
import {
  AvanvuError,
  checkinBodySchema,
  downloadVerifiedBodySchema,
  playsBodySchema,
  sessionCreateBodySchema,
  type SessionTimeline,
} from '@avanvu/core';
import { withUserTx } from '../../db/tx';
import { cancelSession, createSession, present } from '../../domain/sessions';
import { LIMITS } from '../../http/ratelimit';
import { mutate, type AppDeps, type AppEnv } from '../context';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIGNED_URL_SECONDS = 15 * 60;

const idParam = (id: string) => {
  if (!UUID.test(id)) throw new AvanvuError('NOT_FOUND', 'Session not found.');
  return id;
};

const scriptCtx = (sessionId: string) => ({
  table: 'session_scripts',
  column: 'timeline_enc',
  rowId: sessionId,
  schemaVersion: 'session_timeline_v1',
});
const checkinCtx = (sessionId: string, column: string) => ({
  table: 'checkins',
  column,
  rowId: sessionId,
  schemaVersion: 'checkin_text_v1',
});

const listQuerySchema = z.object({
  context: z.enum(['training', 'night_before', 'primer']).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(200).optional(),
});

export function registerSessionRoutes(api: Hono<AppEnv>, deps: AppDeps): void {
  api.post('/sessions', async (c) => {
    let outboxId = '';
    const res = await mutate(
      c,
      deps,
      {
        endpoint: 'POST /v1/sessions',
        schema: sessionCreateBodySchema,
        limit: LIMITS.sessionCreations,
        // Cost circuit breaker: runs only for new work, so a replay still returns the stored result.
        preflight: () => deps.costGuard.assertGenerationAllowed(),
      },
      async ({ trx, body, userId, sealer, now }) => {
        const r = await createSession(trx, {
          userId,
          body,
          creationKey: `create:${c.req.header('Idempotency-Key')?.toLowerCase()}`,
          now,
          cfg: deps.config,
          sealer,
        });
        outboxId = r.outboxId;
        return { status: r.created ? 202 : 200, body: r.session };
      },
    );
    // After commit: enqueue the render task. A failure here is recovered by the sweeper.
    if (outboxId) await deps.dispatcher.dispatchAfterCommit([outboxId]);
    return res;
  });

  api.get('/sessions', async (c) => {
    const userId = c.get('userId');
    const q = listQuerySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
    if (!q.success) throw new AvanvuError('VALIDATION_FAILED', 'Check the query parameters.');
    const { context, limit, cursor } = q.data;
    let cursorAt: Date | null = null;
    let cursorId: string | null = null;
    if (cursor) {
      try {
        const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|');
        cursorAt = new Date(at ?? '');
        cursorId = id ?? null;
        if (Number.isNaN(cursorAt.getTime()) || !cursorId || !UUID.test(cursorId)) throw new Error();
      } catch {
        throw new AvanvuError('VALIDATION_FAILED', 'Check the query parameters.');
      }
    }
    const rows = await withUserTx(deps.db, userId, async (trx) => {
      let query = trx
        .selectFrom('app.sessions')
        .select([
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
        ])
        .where('user_id', '=', userId)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit + 1);
      if (context) query = query.where('context', '=', context);
      if (cursorAt && cursorId) {
        query = query.where((eb) =>
          eb.or([
            eb('created_at', '<', cursorAt),
            eb.and([eb('created_at', '=', cursorAt), eb('id', '<', cursorId)]),
          ]),
        );
      }
      return query.execute();
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return c.json({
      sessions: page.map(present),
      next_cursor:
        rows.length > limit && last
          ? Buffer.from(`${new Date(last.created_at).toISOString()}|${last.id}`).toString('base64url')
          : null,
    });
  });

  api.get('/sessions/:id', async (c) => {
    const id = idParam(c.req.param('id'));
    const userId = c.get('userId');
    const row = await withUserTx(deps.db, userId, (trx) =>
      trx
        .selectFrom('app.sessions')
        .select([
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
          'sha256',
          'bytes',
        ])
        .where('id', '=', id)
        .where('user_id', '=', userId)
        .executeTakeFirst(),
    );
    if (!row) throw new AvanvuError('NOT_FOUND', 'Session not found.');
    return c.json({
      ...present(row),
      sha256: row.sha256,
      bytes: row.bytes === null ? null : Number(row.bytes),
    });
  });

  api.post('/sessions/:id/cancel', (c) =>
    mutate(c, deps, { endpoint: 'POST /v1/sessions/:id/cancel', schema: null }, async ({ trx, userId }) => ({
      status: 200,
      body: await cancelSession(trx, userId, idParam(c.req.param('id'))),
    })),
  );

  api.delete('/sessions/:id', async (c) => {
    // Delete script, audio and the session. The allowance stays consumed.
    let audioPath: string | null = null;
    const res = await mutate(
      c,
      deps,
      { endpoint: 'DELETE /v1/sessions/:id', schema: null },
      async ({ trx, userId }) => {
        const id = idParam(c.req.param('id'));
        const row = await trx
          .selectFrom('app.sessions')
          .select(['id', 'audio_path', 'state'])
          .where('id', '=', id)
          .where('user_id', '=', userId)
          .executeTakeFirst();
        if (!row) throw new AvanvuError('NOT_FOUND', 'Session not found.');
        if (row.state !== 'ready' && row.state !== 'failed' && row.state !== 'canceled') {
          throw new AvanvuError('VALIDATION_FAILED', 'This session is still being prepared.');
        }
        audioPath = row.audio_path;
        await trx
          .updateTable('app.program_items')
          .set({ state: 'skipped', session_id: null })
          .where('session_id', '=', id)
          .execute();
        await trx.deleteFrom('app.sessions').where('id', '=', id).execute(); // cascades the script, plays, check-in
        return { status: 200, body: { deleted: true } };
      },
    );
    if (audioPath)
      await deps.storage
        .delete('audio', audioPath)
        .catch(() => deps.logger.warn('audio_delete_deferred', {}));
    return res;
  });

  api.get('/sessions/:id/transcript', async (c) => {
    const id = idParam(c.req.param('id'));
    const userId = c.get('userId');
    const sealer = await deps.sealer.forUser(userId);
    const out = await withUserTx(deps.db, userId, async (trx) => {
      const script = await trx
        .selectFrom('app.session_scripts')
        .select('timeline_enc')
        .where('session_id', '=', id)
        .where('user_id', '=', userId)
        .executeTakeFirst();
      if (!script) throw new AvanvuError('NOT_FOUND', 'No transcript yet.');
      return sealer.open<SessionTimeline>(scriptCtx(id), script.timeline_enc);
    });
    // Derived from the stored script (D-11): speech in order, pauses shown subtly.
    return c.json({
      title: out.title,
      items: out.items.map((i) =>
        i.type === 'speech'
          ? { type: 'speech', block: i.block, text: i.text }
          : { type: i.type, block: i.block, seconds: Math.round(i.duration_ms / 1000) },
      ),
    });
  });

  api.post('/sessions/:id/download-url', async (c) => {
    const id = idParam(c.req.param('id'));
    const userId = c.get('userId');
    const row = await withUserTx(deps.db, userId, (trx) =>
      trx
        .selectFrom('app.sessions')
        .select(['audio_path', 'sha256', 'bytes', 'state'])
        .where('id', '=', id)
        .where('user_id', '=', userId)
        .executeTakeFirst(),
    );
    if (!row) throw new AvanvuError('NOT_FOUND', 'Session not found.');
    if (row.state !== 'ready' || !row.audio_path) {
      throw new AvanvuError('VALIDATION_FAILED', 'This session is not ready to download yet.');
    }
    const url = await deps.storage.signedUrl('audio', row.audio_path, SIGNED_URL_SECONDS);
    return c.json({ url, sha256: row.sha256, bytes: Number(row.bytes), expires_in: SIGNED_URL_SECONDS });
  });

  api.post('/sessions/:id/download-verified', (c) =>
    mutate(
      c,
      deps,
      { endpoint: 'POST /v1/sessions/:id/download-verified', schema: downloadVerifiedBodySchema },
      async ({ trx, body, userId }) => {
        const id = idParam(c.req.param('id'));
        const row = await trx
          .selectFrom('app.sessions')
          .select(['sha256', 'bytes', 'state'])
          .where('id', '=', id)
          .where('user_id', '=', userId)
          .executeTakeFirst();
        if (!row) throw new AvanvuError('NOT_FOUND', 'Session not found.');
        if (row.state !== 'ready' || row.sha256 !== body.sha256 || Number(row.bytes) !== body.bytes) {
          throw new AvanvuError('VALIDATION_FAILED', 'The downloaded file does not match.');
        }
        await trx
          .insertInto('app.session_downloads')
          .values({
            user_id: userId,
            session_id: id,
            device_id: body.device_id ?? null,
            sha256: body.sha256,
            bytes: body.bytes,
          } as never)
          .onConflict((oc) => oc.doNothing())
          .execute();
        return { status: 200, body: { verified: true } };
      },
    ),
  );

  api.post('/sessions/:id/plays', (c) =>
    mutate(
      c,
      deps,
      { endpoint: 'POST /v1/sessions/:id/plays', schema: playsBodySchema },
      async ({ trx, body, userId }) => {
        const id = idParam(c.req.param('id'));
        const owns = await trx
          .selectFrom('app.sessions')
          .select('id')
          .where('id', '=', id)
          .where('user_id', '=', userId)
          .executeTakeFirst();
        if (!owns) throw new AvanvuError('NOT_FOUND', 'Session not found.');
        await trx
          .insertInto('app.session_plays')
          .values(
            body.plays.map((p) => ({
              user_id: userId,
              session_id: id,
              mark: p.mark,
              position_ms: p.position_ms,
              occurred_at: new Date(p.occurred_at),
              client_event_id: p.client_event_id,
            })) as never,
          )
          .onConflict((oc) => oc.columns(['session_id', 'client_event_id']).doNothing())
          .execute();
        return { status: 200, body: { recorded: body.plays.length } };
      },
    ),
  );

  api.post('/sessions/:id/checkin', (c) =>
    mutate(
      c,
      deps,
      { endpoint: 'POST /v1/sessions/:id/checkin', schema: checkinBodySchema },
      async ({ trx, body, userId, sealer }) => {
        const id = idParam(c.req.param('id'));
        const row = await trx
          .selectFrom('app.sessions')
          .select('state')
          .where('id', '=', id)
          .where('user_id', '=', userId)
          .executeTakeFirst();
        if (!row) throw new AvanvuError('NOT_FOUND', 'Session not found.');
        if (row.state !== 'ready')
          throw new AvanvuError('VALIDATION_FAILED', 'Check-ins are for finished sessions.');
        const useful = body.useful ? await sealer.seal(checkinCtx(id, 'useful_enc'), body.useful) : null;
        const off = body.off ? await sealer.seal(checkinCtx(id, 'off_enc'), body.off) : null;
        await trx
          .insertInto('app.checkins')
          .values({
            user_id: userId,
            session_id: id,
            vividness: body.vividness,
            readiness: body.readiness,
            useful_enc: useful,
            off_enc: off,
          } as never)
          .onConflict((oc) =>
            oc.column('session_id').doUpdateSet({
              vividness: body.vividness,
              readiness: body.readiness,
              useful_enc: useful,
              off_enc: off,
            } as never),
          )
          .execute();
        return { status: 201, body: { recorded: true } };
      },
    ),
  );
}
