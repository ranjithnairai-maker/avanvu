/** Interview endpoints (SPEC §11.1, CONTRACTS §4) plus the confirmed profile and delivery preferences. */
import type { Hono } from 'hono';
import {
  AvanvuError,
  applyProfileUpdates,
  generationMinimumMissing,
  intakeConversationBodySchema,
  intakeTurnRequestSchema,
  preferencesBodySchema,
  profilePatchBodySchema,
  recomputeStatuses,
  type ProfileUpdate,
} from '@avanvu/core';
import { z } from 'zod';
import { withUserTx } from '../../db/tx';
import {
  IntakeTurns,
  conversationView,
  saveDraft,
  setPaused,
  startConversation,
  type IntakeEnv,
} from '../../domain/intake';
import { createProfileVersion, latestProfile } from '../../domain/profile';
import { parseIdempotencyKey, requestHash } from '../../http/idempotency';
import { LIMITS } from '../../http/ratelimit';
import { mutate, parseWith, readJson, type AppDeps, type AppEnv } from '../context';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idParam = (id: string, what: string) => {
  if (!UUID.test(id)) throw new AvanvuError('NOT_FOUND', `${what} not found.`);
  return id;
};

const editsBodySchema = z.object({
  expected_revision: z.number().int().min(0),
  updates: profilePatchBodySchema.shape.updates,
});

export function registerIntakeRoutes(api: Hono<AppEnv>, deps: AppDeps, env: IntakeEnv): void {
  const turns = new IntakeTurns(env);

  api.post('/intake/conversations', (c) =>
    mutate(
      c,
      deps,
      {
        endpoint: 'POST /v1/intake/conversations',
        schema: intakeConversationBodySchema,
        limit: LIMITS.accountMutations,
      },
      async ({ trx, body, userId, sealer, now }) => {
        const { created, view } = await startConversation(trx, sealer, userId, body.event_id, now);
        return { status: created ? 201 : 200, body: view };
      },
    ),
  );

  api.get('/intake/conversations/:id', async (c) => {
    const id = idParam(c.req.param('id'), 'Conversation');
    const userId = c.get('userId');
    const sealer = await deps.sealer.forUser(userId);
    return c.json(await withUserTx(deps.db, userId, (trx) => conversationView(trx, sealer, userId, id)));
  });

  api.post('/intake/turns', async (c) => {
    const userId = c.get('userId');
    const key = parseIdempotencyKey(c.req.header('Idempotency-Key'));
    const raw = await readJson(c);
    const body = parseWith(intakeTurnRequestSchema, raw);
    await deps.limiter.enforce(userId, LIMITS.intakeTurns);
    const result = await turns.run(
      userId,
      body,
      {
        userId,
        endpoint: 'POST /v1/intake/turns',
        key,
        hash: await requestHash('POST', '/v1/intake/turns', raw),
      },
      c.get('requestId'),
    );
    return c.json(result.body as object, result.status as 200);
  });

  for (const action of ['pause', 'resume'] as const) {
    api.post(`/intake/conversations/:id/${action}`, (c) =>
      mutate(
        c,
        deps,
        { endpoint: `POST /v1/intake/conversations/:id/${action}`, schema: null },
        async ({ trx, userId, sealer, now }) => {
          const id = idParam(c.req.param('id'), 'Conversation');
          await setPaused(trx, userId, id, action === 'pause', now);
          return { status: 200, body: await conversationView(trx, sealer, userId, id) };
        },
      ),
    );
  }

  // Summary edits before confirmation: the athlete corrects the draft (source "edited").
  api.post('/intake/conversations/:id/edits', (c) =>
    mutate(
      c,
      deps,
      { endpoint: 'POST /v1/intake/conversations/:id/edits', schema: editsBodySchema },
      async ({ trx, body, userId, sealer, now }) => {
        const id = idParam(c.req.param('id'), 'Conversation');
        const view = await conversationView(trx, sealer, userId, id);
        if (view.revision !== body.expected_revision) {
          throw new AvanvuError('PROFILE_REVISION_CONFLICT', 'This summary changed on another device.', {
            latest: { revision: view.revision, state: view.state },
          });
        }
        if (view.state !== 'READY_FOR_SUMMARY') {
          throw new AvanvuError('VALIDATION_FAILED', 'Edits are available on the summary.');
        }
        const r = applyProfileUpdates(view.profile, body.updates as ProfileUpdate[], {
          source: 'edited',
          allowSkippedOverride: true,
        });
        if (r.rejected.length > 0 && r.accepted === 0) {
          throw new AvanvuError('VALIDATION_FAILED', 'That change is not allowed.');
        }
        r.profile.field_status = recomputeStatuses(r.profile);
        await saveDraft(trx, sealer, id, r.profile, now);
        await trx
          .updateTable('app.intake_conversations')
          .set({ revision: view.revision + 1, updated_at: now })
          .where('id', '=', id)
          .execute();
        return { status: 200, body: await conversationView(trx, sealer, userId, id) };
      },
    ),
  );

  api.post('/intake/conversations/:id/confirm', (c) =>
    mutate(
      c,
      deps,
      { endpoint: 'POST /v1/intake/conversations/:id/confirm', schema: null },
      async ({ trx, userId, sealer, now }) => {
        const id = idParam(c.req.param('id'), 'Conversation');
        const view = await conversationView(trx, sealer, userId, id);
        if (view.state === 'SAFETY_INTERRUPTED') {
          throw new AvanvuError('SAFETY_INTERRUPTED', 'This conversation has ended.');
        }
        if (view.state !== 'READY_FOR_SUMMARY') {
          throw new AvanvuError('VALIDATION_FAILED', 'The summary is not ready to confirm yet.');
        }
        if (generationMinimumMissing(view.profile, true).length > 0) {
          throw new AvanvuError('MINIMUM_PROFILE_INCOMPLETE', 'A few essentials are still missing.');
        }
        const stored = await createProfileVersion(trx, sealer, userId, view.profile, 'intake', view.event_id);
        await trx
          .updateTable('app.intake_conversations')
          .set({
            state: 'SUMMARY_CONFIRMED',
            summary_confirmed_at: now,
            revision: view.revision + 1,
            updated_at: now,
          })
          .where('id', '=', id)
          .execute();
        return { status: 200, body: { profile_version: stored.version, profile: stored.profile } };
      },
    ),
  );

  api.get('/profile', async (c) => {
    const userId = c.get('userId');
    const sealer = await deps.sealer.forUser(userId);
    const stored = await withUserTx(deps.db, userId, (trx) => latestProfile(trx, sealer, userId));
    if (!stored) throw new AvanvuError('NOT_FOUND', 'No confirmed profile yet.');
    return c.json({ version: stored.version, source: stored.source, profile: stored.profile });
  });

  api.patch('/profile', (c) =>
    mutate(
      c,
      deps,
      { endpoint: 'PATCH /v1/profile', schema: profilePatchBodySchema, limit: LIMITS.accountMutations },
      async ({ trx, body, userId, sealer }) => {
        const current = await latestProfile(trx, sealer, userId);
        if (!current) throw new AvanvuError('NOT_FOUND', 'No confirmed profile yet.');
        if (current.version !== body.base_version) {
          throw new AvanvuError('PROFILE_REVISION_CONFLICT', 'Your profile changed on another device.', {
            latest: { version: current.version },
          });
        }
        const r = applyProfileUpdates(current.profile, body.updates as ProfileUpdate[], {
          source: 'edited',
          allowSkippedOverride: true,
        });
        if (r.accepted === 0) throw new AvanvuError('VALIDATION_FAILED', 'That change is not allowed.');
        if (generationMinimumMissing(r.profile, true).length > 0) {
          throw new AvanvuError(
            'MINIMUM_PROFILE_INCOMPLETE',
            'That change would remove something essential.',
          );
        }
        const stored = await createProfileVersion(trx, sealer, userId, r.profile, 'edit', current.event_id);
        return { status: 200, body: { version: stored.version, profile: stored.profile } };
      },
    ),
  );

  api.put('/profile/preferences', (c) =>
    mutate(
      c,
      deps,
      {
        endpoint: 'PUT /v1/profile/preferences',
        schema: preferencesBodySchema,
        limit: LIMITS.accountMutations,
      },
      async ({ trx, body, userId, sealer, now }) => {
        const current = await latestProfile(trx, sealer, userId);
        if (!current) throw new AvanvuError('NOT_FOUND', 'No confirmed profile yet.');
        const voice = await trx
          .selectFrom('app.voice_catalog')
          .select('id')
          .where('id', '=', body.voice_id)
          .where('active', '=', true)
          .executeTakeFirst();
        if (!voice) throw new AvanvuError('VALIDATION_FAILED', 'Check these fields: voice_id.');
        const next = structuredClone(current.profile);
        next.preferences = {
          perspective: body.perspective,
          voice_id: body.voice_id,
          music_style: body.music_style,
          training_length_min: body.training_length_min,
          primer_length_min: body.primer_length_min,
          feared_self_enabled: body.feared_self_enabled,
        };
        if (body.outcome_anchor) next.outcome.anchor = body.outcome_anchor;
        if (body.level) next.sport.level = body.level;
        const stored = await createProfileVersion(trx, sealer, userId, next, 'edit', current.event_id);
        // First-run delivery step completes the interview.
        await trx
          .updateTable('app.intake_conversations')
          .set({ state: 'COMPLETE', updated_at: now })
          .where('user_id', '=', userId)
          .where('state', '=', 'SUMMARY_CONFIRMED')
          .execute();
        return { status: 200, body: { version: stored.version, preferences: stored.profile.preferences } };
      },
    ),
  );
}
