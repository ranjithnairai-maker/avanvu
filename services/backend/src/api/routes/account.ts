/** Account lifecycle, purchases and debrief endpoints (SPEC §11.1): Apple link, export, delete, refresh, debrief. */
import type { Hono } from 'hono';
import { z } from 'zod';
import {
  AvanvuError,
  debriefAnswersSchema,
  debriefConfirmBodySchema,
  debriefBodySchema,
  type DebriefAnswers,
} from '@avanvu/core';
import { withUserTx } from '../../db/tx';
import { confirmDebrief, proposeDebrief } from '../../domain/debrief';
import { requestDeletion } from '../../domain/deletion';
import { allowanceSummary, loadEntitlement } from '../../domain/ledger';
import { addOutboxEvent } from '../../domain/outbox';
import { syncEntitlement } from '../../domain/entitlements';
import { LIMITS } from '../../http/ratelimit';
import { mutate, type AppDeps, type AppEnv } from '../context';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const appleBody = z.object({ authorization_code: z.string().min(8).max(2000) });

export function registerAccountRoutes(api: Hono<AppEnv>, deps: AppDeps): void {
  // Sign in with Apple: exchange the code, store the refresh token sealed, revoke it at deletion.
  api.post('/auth/apple/link', (c) =>
    mutate(
      c,
      deps,
      { endpoint: 'POST /v1/auth/apple/link', schema: appleBody, limit: LIMITS.accountMutations },
      async ({ trx, body, userId, sealer }) => {
        const { refreshToken } = await deps.apple.exchangeCode(body.authorization_code);
        const enc = await sealer.seal(
          {
            table: 'apple_tokens',
            column: 'refresh_token_enc',
            rowId: userId,
            schemaVersion: 'apple_token_v1',
          },
          refreshToken,
        );
        await trx
          .insertInto('app.apple_tokens')
          .values({ user_id: userId, refresh_token_enc: enc })
          .onConflict((oc) => oc.column('user_id').doUpdateSet({ refresh_token_enc: enc }))
          .execute();
        return { status: 200, body: { linked: true } };
      },
    ),
  );

  api.post('/purchases/refresh', async (c) => {
    // Sync from RevenueCat after a purchase or restore, then report the new state.
    const userId = c.get('userId');
    await deps.limiter.enforce(userId, LIMITS.accountMutations);
    await syncEntitlement(deps.db, deps.revenuecat, userId);
    const now = deps.now();
    const out = await withUserTx(deps.db, userId, async (trx) => {
      const ent = await loadEntitlement(trx, userId);
      return {
        entitlement: ent
          ? {
              active: ent.active,
              period_type: ent.period_type,
              expires_at: ent.expires_at?.toISOString() ?? null,
            }
          : null,
        allowance: await allowanceSummary(trx, userId, ent, now),
      };
    });
    return c.json(out);
  });

  api.post('/account/export', async (c) => {
    let outboxId = '';
    const res = await mutate(
      c,
      deps,
      { endpoint: 'POST /v1/account/export', schema: null, limit: LIMITS.accountMutations },
      async ({ trx, userId }) => {
        const job = await trx
          .insertInto('app.export_jobs')
          .values({ user_id: userId })
          .returning('id')
          .executeTakeFirstOrThrow();
        outboxId = await addOutboxEvent(trx, { userId, kind: 'export', subjectId: job.id });
        return { status: 202, body: { id: job.id, state: 'queued' } };
      },
    );
    if (outboxId) await deps.dispatcher.dispatchAfterCommit([outboxId]);
    return res;
  });

  api.get('/account/exports/:id', async (c) => {
    const id = c.req.param('id');
    if (!UUID.test(id)) throw new AvanvuError('NOT_FOUND', 'Export not found.');
    const userId = c.get('userId');
    const now = deps.now();
    const job = await withUserTx(deps.db, userId, (trx) =>
      trx
        .selectFrom('app.export_jobs')
        .select(['id', 'state', 'storage_path', 'expires_at'])
        .where('id', '=', id)
        .where('user_id', '=', userId)
        .executeTakeFirst(),
    );
    if (!job) throw new AvanvuError('NOT_FOUND', 'Export not found.');
    const expired = job.expires_at ? new Date(job.expires_at) <= now : false;
    if (job.state !== 'ready' || !job.storage_path || expired) {
      return c.json({ id: job.id, state: expired ? 'expired' : job.state });
    }
    const url = await deps.storage.signedUrl('exports', job.storage_path, 15 * 60);
    return c.json({
      id: job.id,
      state: 'ready',
      url,
      expires_at: new Date(job.expires_at as Date).toISOString(),
    });
  });

  api.post('/account/delete', async (c) => {
    let outboxId = '';
    const res = await mutate(
      c,
      deps,
      { endpoint: 'POST /v1/account/delete', schema: null, limit: LIMITS.accountMutations },
      async ({ trx, userId, now }) => {
        const r = await requestDeletion(trx, userId, now);
        outboxId = r.outboxId;
        return { status: 202, body: { state: 'queued' } };
      },
    );
    deps.accounts.markDeleted(c.get('userId')); // this instance stops serving the account at once
    if (outboxId) await deps.dispatcher.dispatchAfterCommit([outboxId]);
    return res;
  });

  // Debrief (SPEC §8.4).
  api.post('/debriefs', async (c) => {
    let crisis: 'deterministic' | 'model' | null = null;
    const res = await mutate(
      c,
      deps,
      { endpoint: 'POST /v1/debriefs', schema: debriefBodySchema },
      async ({ trx, body, userId, sealer, now }) => {
        const answers: DebriefAnswers = debriefAnswersSchema.parse(body);
        const r = await proposeDebrief(
          trx,
          { llm: deps.llm, now, timeoutMs: deps.intakeTimeoutMs },
          sealer,
          userId,
          body.event_id,
          answers,
        );
        if (r.kind === 'crisis') {
          crisis = r.layer;
          await trx
            .insertInto('app.safety_events')
            .values({
              user_id: userId,
              conversation_id: null,
              layer: r.layer,
              outcome: 'crisis',
              lexicon_version: null,
            })
            .execute();
          return {
            status: 409,
            body: new AvanvuError('SAFETY_INTERRUPTED', 'Support is available.').toBody(c.get('requestId')),
          };
        }
        if (r.kind === 'clarify') return { status: 200, body: { state: 'clarify', message: r.message } };
        for (const u of r.usage) {
          await trx
            .insertInto('app.vendor_usage')
            .values({
              user_id: userId,
              vendor: 'anthropic',
              kind: 'debrief',
              model: u.model,
              tokens_in: u.tokensIn,
              tokens_out: u.tokensOut,
              characters: null,
              compute_seconds: null,
              est_cost_usd: u.estCostUsd,
            })
            .execute();
        }
        return { status: 201, body: { state: 'proposed', ...r.value } };
      },
    );
    void crisis;
    return res;
  });

  api.post('/debriefs/:id/confirm', (c) =>
    mutate(
      c,
      deps,
      { endpoint: 'POST /v1/debriefs/:id/confirm', schema: debriefConfirmBodySchema },
      async ({ trx, body, userId, sealer, now }) => {
        const id = c.req.param('id');
        if (!UUID.test(id)) throw new AvanvuError('NOT_FOUND', 'Debrief not found.');
        const r = await confirmDebrief(trx, sealer, userId, id, body.accepted_item_ids, now);
        return { status: 200, body: { profile_version: r.version, applied: r.applied } };
      },
    ),
  );
}
