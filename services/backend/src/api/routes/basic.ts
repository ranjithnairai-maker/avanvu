/** Bootstrap and small account endpoints: /me, /sports, /consents, /age-assurance, /waitlist, /devices. */
import type { Hono } from 'hono';
import {
  AvanvuError,
  SPORTS,
  ageAssuranceBodySchema,
  consentsBodySchema,
  deviceBodySchema,
  waitlistBodySchema,
} from '@avanvu/core';
import { withUserTx } from '../../db/tx';
import { allowanceSummary, loadEntitlement } from '../../domain/ledger';
import { LIMITS } from '../../http/ratelimit';
import { latestProfile } from '../../domain/profile';
import { mutate, type AppDeps, type AppEnv } from '../context';
import { presentEvent, selectEvent, type EventRow } from './events';

export function registerBasicRoutes(api: Hono<AppEnv>, deps: AppDeps): void {
  api.get('/me', async (c) => {
    const userId = c.get('userId');
    const now = deps.now();
    const sealer = await deps.sealer.forUser(userId); // before any transaction
    const out = await withUserTx(deps.db, userId, async (trx) => {
      const user = await trx
        .selectFrom('app.users')
        .select(['analytics_id', 'demo_account', 'time_zone', 'age_assurance_method', 'created_at'])
        .where('id', '=', userId)
        .executeTakeFirstOrThrow();
      const ent = await loadEntitlement(trx, userId);
      const allowance = await allowanceSummary(trx, userId, ent, now);
      // The soonest upcoming event, the live interview (if any) and whether a confirmed profile exists: this is
      // what the app needs on launch to decide where to send the athlete.
      const eventRow = await selectEvent(trx)
        .where('user_id', '=', userId)
        .where('status', '=', 'upcoming')
        .where('starts_at', '>', now)
        .orderBy('starts_at')
        .limit(1)
        .executeTakeFirst();
      const program = eventRow
        ? await trx
            .selectFrom('app.programs')
            .select('id')
            .where('event_id', '=', eventRow.id)
            .executeTakeFirst()
        : undefined;
      const upcoming_event = eventRow
        ? await presentEvent(sealer, eventRow as unknown as EventRow, program?.id ?? null)
        : null;
      const conversation = await trx
        .selectFrom('app.intake_conversations')
        .select(['id', 'event_id', 'state'])
        .where('user_id', '=', userId)
        .where('state', 'not in', ['SAFETY_INTERRUPTED', 'COMPLETE'])
        .orderBy('created_at', 'desc')
        .limit(1)
        .executeTakeFirst();
      // An event that has started but has not been debriefed yet: Home offers the debrief (SPEC §8.4).
      const pastRow = await selectEvent(trx)
        .where('user_id', '=', userId)
        .where('status', '=', 'upcoming')
        .where('starts_at', '<=', now)
        .where('starts_at', '>', new Date(now.getTime() - 14 * 86_400_000))
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('app.event_debriefs as d')
                .select('d.id')
                .whereRef('d.event_id', '=', 'app.events.id'),
            ),
          ),
        )
        .orderBy('starts_at', 'desc')
        .limit(1)
        .executeTakeFirst();
      const pending_debrief = pastRow
        ? await presentEvent(sealer, pastRow as unknown as EventRow, null)
        : null;
      const has_profile = !!(await latestProfile(trx, sealer, userId));
      return {
        upcoming_event,
        pending_debrief,
        active_intake: conversation ?? null,
        has_profile,
        user: {
          analytics_id: user.analytics_id,
          demo_account: user.demo_account,
          time_zone: user.time_zone,
          age_assured: user.age_assurance_method !== null,
        },
        entitlement: ent
          ? {
              active: ent.active,
              period_type: ent.period_type,
              expires_at: ent.expires_at?.toISOString() ?? null,
            }
          : null,
        allowance,
      };
    });
    return c.json(out);
  });

  // The three curated voices with a short licensed sample each (SPEC §6.1). Samples are served by signed URL.
  api.get('/voices', async (c) => {
    const rows = await withUserTx(deps.db, c.get('userId'), (trx) =>
      trx
        .selectFrom('app.voice_catalog')
        .select(['id', 'label', 'sample_path'])
        .where('active', '=', true)
        .orderBy('id')
        .execute(),
    );
    const voices = await Promise.all(
      rows.map(async (v) => ({
        id: v.id,
        label: v.label,
        sample_url: v.sample_path ? await deps.storage.signedUrl('music', v.sample_path, 15 * 60) : null,
      })),
    );
    return c.json({ voices });
  });

  api.get('/sports', (c) =>
    c.json({ sports: SPORTS.map((s) => ({ id: s.id, label: s.label, engine: s.engine })) }),
  );

  api.post('/consents', (c) =>
    mutate(
      c,
      deps,
      { endpoint: 'POST /v1/consents', schema: consentsBodySchema, limit: LIMITS.accountMutations },
      async ({ trx, body, userId }) => {
        await trx
          .insertInto('app.consent_records')
          .values(
            body.consents.map((x) => ({
              user_id: userId,
              kind: x.kind,
              version: x.version,
              accepted: x.accepted,
            })),
          )
          .execute();
        return { status: 201, body: { recorded: body.consents.length } };
      },
    ),
  );

  api.post('/age-assurance', (c) =>
    mutate(
      c,
      deps,
      { endpoint: 'POST /v1/age-assurance', schema: ageAssuranceBodySchema, limit: LIMITS.accountMutations },
      async ({ trx, body, userId, now }) => {
        await trx
          .updateTable('app.users')
          .set({ age_assurance_method: body.method, age_assured_at: now })
          .where('id', '=', userId)
          .execute();
        return { status: 200, body: { method: body.method } };
      },
    ),
  );

  api.post('/waitlist', (c) =>
    mutate(
      c,
      deps,
      { endpoint: 'POST /v1/waitlist', schema: waitlistBodySchema, limit: LIMITS.accountMutations },
      async ({ trx, body, userId }) => {
        await trx
          .insertInto('app.waitlist_entries')
          .values({ user_id: userId, sport_label: body.sport_label })
          .execute();
        return { status: 201, body: { joined: true } };
      },
    ),
  );

  api.post('/devices', (c) =>
    mutate(
      c,
      deps,
      { endpoint: 'POST /v1/devices', schema: deviceBodySchema, limit: LIMITS.accountMutations },
      async ({ trx, body, userId }) => {
        const row = await trx
          .insertInto('app.devices')
          .values({ user_id: userId, push_token: body.push_token, app_version: body.app_version ?? null })
          .onConflict((oc) =>
            oc.columns(['user_id', 'push_token']).doUpdateSet({ app_version: body.app_version ?? null }),
          )
          .returning('id')
          .executeTakeFirstOrThrow();
        return { status: 201, body: { id: row.id } };
      },
    ),
  );

  api.delete('/devices/:id', (c) =>
    mutate(
      c,
      deps,
      { endpoint: 'DELETE /v1/devices/:id', schema: null, limit: LIMITS.accountMutations },
      async ({ trx, userId }) => {
        const id = c.req.param('id');
        if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AvanvuError('VALIDATION_FAILED', 'Invalid device id.');
        const r = await trx
          .deleteFrom('app.devices')
          .where('id', '=', id)
          .where('user_id', '=', userId)
          .executeTakeFirst();
        if (Number(r.numDeletedRows) === 0) throw new AvanvuError('NOT_FOUND', 'Device not found.');
        return { status: 200, body: { deleted: true } };
      },
    ),
  );
}
