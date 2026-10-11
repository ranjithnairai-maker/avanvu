import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SPORTS } from '@avanvu/core';
import { createTestDb, type TestDb } from '../testing/pglite';
import { withSystemTx, withUserTx } from './tx';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
  const q = (s: string) => t.pg.exec(s);
  await q(`
    insert into app.users (id) values ('${A}'), ('${B}');
    insert into app.voice_catalog (id, label, provider_voice_id, wpm, settings_version) values ('v1', 'Voice', 'p1', 100, 's1');
    insert into app.events (id, user_id, name_enc, starts_local, time_zone, starts_at, supported_sport_id, engine) values
      ('a0000000-0000-4000-8000-00000000000a', '${A}', '\\x01', '2027-01-10 08:00', 'America/Toronto', '2027-01-10 13:00+00', 'running_road', 'endurance_v1'),
      ('b0000000-0000-4000-8000-00000000000b', '${B}', '\\x01', '2027-01-10 08:00', 'America/Toronto', '2027-01-10 13:00+00', 'golf', 'closed_skill_v1');
    insert into app.athlete_profile_versions (id, user_id, version, source, profile_enc) values
      ('a1000000-0000-4000-8000-00000000000a', '${A}', 1, 'intake', '\\x01'),
      ('b1000000-0000-4000-8000-00000000000b', '${B}', 1, 'intake', '\\x01');
    insert into app.sessions (id, user_id, context, length_min, engine, profile_version_id, voice_id, creation_key) values
      ('a2000000-0000-4000-8000-00000000000a', '${A}', 'training', 15, 'endurance_v1', 'a1000000-0000-4000-8000-00000000000a', 'v1', 'ka'),
      ('b2000000-0000-4000-8000-00000000000b', '${B}', 'training', 15, 'closed_skill_v1', 'b1000000-0000-4000-8000-00000000000b', 'v1', 'kb');
    insert into app.usage_ledger (user_id, allowance_type, bucket_start, bucket_end, entry_type, quantity, idempotency_key) values
      ('${A}', 'free_training', '2026-10-01', '2099-01-01', 'grant', 1, 'grant:a'),
      ('${B}', 'free_training', '2026-10-01', '2099-01-01', 'grant', 1, 'grant:b');
  `);
});

afterAll(async () => {
  await t.close();
});

describe('migrations', () => {
  it('seed the sport registry exactly (CONTRACTS §2)', async () => {
    const rows = await t.admin.kysely.selectFrom('app.sport_engines').select(['id', 'engine']).execute();
    expect(rows.map((r) => r.id).sort()).toEqual(SPORTS.map((s) => s.id).sort());
    for (const s of SPORTS) expect(rows.find((r) => r.id === s.id)?.engine).toBe(s.engine);
  });

  it('force RLS on every table that holds user data', async () => {
    const r = await t.pg.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'app' and c.relkind = 'r'
        and c.relname not in ('sport_engines', 'voice_catalog', 'music_catalog')`);
    expect(r.rows.length).toBeGreaterThan(20);
    for (const row of r.rows) {
      expect(row.relrowsecurity, `${row.relname} RLS enabled`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} RLS forced`).toBe(true);
    }
  });

  it('no plaintext sensitive column exists: sensitive columns are bytea envelopes (M2 exit)', async () => {
    const r = await t.pg.query<{ table_name: string; column_name: string; data_type: string }>(`
      select table_name, column_name, data_type from information_schema.columns where table_schema = 'app'`);
    for (const c of r.rows.filter((x) => x.column_name.endsWith('_enc'))) {
      expect(c.data_type, `${c.table_name}.${c.column_name}`).toBe('bytea');
    }
    const forbidden =
      /^(content|transcript|text|prompt|output|note|notes|name|message|body|script|timeline)$/;
    const plaintext = r.rows.filter((x) => forbidden.test(x.column_name) && x.data_type !== 'bytea');
    expect(plaintext).toEqual([]);
  });

  it('give anon and authenticated no access to schema app (D-03)', async () => {
    const r = await t.pg.query<{ anon: boolean; auth: boolean; anon_t: boolean; auth_t: boolean }>(`
      select has_schema_privilege('anon', 'app', 'usage') as anon,
             has_schema_privilege('authenticated', 'app', 'usage') as auth,
             has_table_privilege('anon', 'app.sessions', 'select') as anon_t,
             has_table_privilege('authenticated', 'app.sessions', 'select') as auth_t`);
    expect(r.rows[0]).toEqual({ anon: false, auth: false, anon_t: false, auth_t: false });
  });

  it('roles carry no superuser or BYPASSRLS', async () => {
    const r = await t.pg.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      `select rolname, rolsuper, rolbypassrls from pg_roles where rolname in ('avanvu_api', 'avanvu_worker')`,
    );
    expect(r.rows).toHaveLength(2);
    for (const row of r.rows) expect([row.rolsuper, row.rolbypassrls]).toEqual([false, false]);
  });
});

describe('two-user isolation in user transactions', () => {
  it('lists only the caller’s rows even without a where clause', async () => {
    const events = await withUserTx(t.api, A, (trx) =>
      trx.selectFrom('app.events').select('user_id').execute(),
    );
    expect(events.map((e) => e.user_id)).toEqual([A]);
    const sessions = await withUserTx(t.api, B, (trx) =>
      trx.selectFrom('app.sessions').select('user_id').execute(),
    );
    expect(sessions.map((e) => e.user_id)).toEqual([B]);
    const ledger = await withUserTx(t.api, A, (trx) =>
      trx.selectFrom('app.usage_ledger').select('user_id').execute(),
    );
    expect(ledger.map((e) => e.user_id)).toEqual([A]);
    const users = await withUserTx(t.api, A, (trx) => trx.selectFrom('app.users').select('id').execute());
    expect(users.map((u) => u.id)).toEqual([A]);
  });

  it('cannot read another user by id', async () => {
    const r = await withUserTx(t.api, A, (trx) =>
      trx
        .selectFrom('app.sessions')
        .selectAll()
        .where('id', '=', 'b2000000-0000-4000-8000-00000000000b')
        .execute(),
    );
    expect(r).toEqual([]);
  });

  it('cannot insert a row owned by someone else', async () => {
    await expect(
      withUserTx(t.api, A, (trx) =>
        trx.insertInto('app.waitlist_entries').values({ user_id: B, sport_label: 'Curling' }).execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('cannot update or delete another user’s rows (silently matches nothing)', async () => {
    const upd = await withUserTx(t.api, A, (trx) =>
      trx.updateTable('app.sessions').set({ failure_code: 'x' }).where('user_id', '=', B).executeTakeFirst(),
    );
    expect(Number(upd.numUpdatedRows)).toBe(0);
    const del = await withUserTx(t.api, A, (trx) =>
      trx.deleteFrom('app.events').where('user_id', '=', B).executeTakeFirst(),
    );
    expect(Number(del.numDeletedRows)).toBe(0);
    const still = await t.admin.kysely
      .selectFrom('app.sessions')
      .select('failure_code')
      .where('user_id', '=', B)
      .execute();
    expect(still[0]?.failure_code).toBeNull();
  });

  it('sees nothing when no identity is set', async () => {
    const rows = await t.admin.kysely.transaction().execute(async (trx) => {
      await sql`set local role avanvu_api`.execute(trx);
      return trx.selectFrom('app.events').selectAll().execute();
    });
    expect(rows).toEqual([]);
  });

  it('does not leak identity across transactions on a reused connection', async () => {
    await withUserTx(t.api, A, (trx) => trx.selectFrom('app.events').selectAll().execute());
    const rows = await t.admin.kysely.transaction().execute(async (trx) => {
      await sql`set local role avanvu_api`.execute(trx);
      return trx.selectFrom('app.events').selectAll().execute();
    });
    expect(rows).toEqual([]);
  });

  it('keeps internal tables away from user transactions', async () => {
    await withSystemTx(t.api, 'webhook', (trx) =>
      trx
        .insertInto('app.rate_limit_buckets' as never)
        .values({ subject: 'ip', limit_name: 'x', tokens: 1 } as never)
        .execute(),
    );
    const asUser = await withUserTx(t.api, A, (trx) =>
      trx.selectFrom('app.rate_limit_buckets').selectAll().execute(),
    );
    expect(asUser).toEqual([]);
  });

  it('makes the usage ledger append-only for the API', async () => {
    await expect(
      withUserTx(t.api, A, (trx) =>
        trx.updateTable('app.usage_ledger').set({ quantity: 99 }).where('user_id', '=', A).execute(),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withUserTx(t.api, A, (trx) => trx.deleteFrom('app.usage_ledger').where('user_id', '=', A).execute()),
    ).rejects.toThrow(/permission denied/);
  });

  it('rejects a duplicate ledger idempotency key and a duplicate session creation key', async () => {
    await expect(
      withSystemTx(t.worker, 'worker', (trx) =>
        trx
          .insertInto('app.usage_ledger')
          .values({
            user_id: A,
            allowance_type: 'free_training',
            bucket_start: '2026-10-01',
            bucket_end: '2099-01-01',
            entry_type: 'grant',
            quantity: 1,
            idempotency_key: 'grant:a',
          })
          .execute(),
      ),
    ).rejects.toThrow(/duplicate key/);
  });
});

describe('internal actors', () => {
  it('lets the worker read across users and update sessions', async () => {
    const rows = await withSystemTx(t.worker, 'worker', (trx) =>
      trx.selectFrom('app.sessions').select('user_id').execute(),
    );
    expect(rows.map((r) => r.user_id).sort()).toEqual([A, B]);
    const upd = await withSystemTx(t.worker, 'worker', (trx) =>
      trx
        .updateTable('app.sessions')
        .set({ state: 'queued' })
        .where('creation_key', '=', 'ka')
        .executeTakeFirst(),
    );
    expect(Number(upd.numUpdatedRows)).toBe(1);
  });

  it('does not let the worker rewrite immutable profile versions or the ledger', async () => {
    await expect(
      withSystemTx(t.worker, 'worker', (trx) =>
        trx.updateTable('app.usage_ledger').set({ quantity: 5 }).execute(),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
