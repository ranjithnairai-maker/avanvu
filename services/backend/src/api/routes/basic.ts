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
import { mutate, type AppDeps, type AppEnv } from '../context';

export function registerBasicRoutes(api: Hono<AppEnv>, deps: AppDeps): void {
  api.get('/me', async (c) => {
    const userId = c.get('userId');
    const now = deps.now();
    const out = await withUserTx(deps.db, userId, async (trx) => {
      const user = await trx
        .selectFrom('app.users')
        .select(['analytics_id', 'demo_account', 'time_zone', 'age_assurance_method', 'created_at'])
        .where('id', '=', userId)
        .executeTakeFirstOrThrow();
      const ent = await loadEntitlement(trx, userId);
      const allowance = await allowanceSummary(trx, userId, ent, now);
      return {
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
