import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../testing/pglite';
import { withUserTx } from '../db/tx';
import { ensureUser } from './accounts';
import {
  allowanceSummary,
  commitReservation,
  loadEntitlement,
  reserveSession,
  reverseReservation,
  type EntitlementState,
} from './ledger';

const cfg = { PRO_MONTHLY_ALLOWANCE: 12, TRIAL_SESSION_ALLOWANCE: 3, FREE_TRAINING_GRANT: 1, FREE_PRIMER_GRANT: 1 };
const FREE = '11111111-1111-4111-8111-111111111111';
const PRO = '22222222-2222-4222-8222-222222222222';
const TRIAL = '33333333-3333-4333-8333-333333333333';
const now = new Date('2026-10-20T12:00:00Z');
let t: TestDb;
let n = 0;
const sid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

const proEnt = (type: 'normal' | 'trial'): EntitlementState => ({
  active: true,
  period_type: type,
  original_purchase_at: new Date('2026-10-01T09:00:00Z'),
  expires_at: new Date('2027-10-01T09:00:00Z'),
});

const pv = new Map<string, string>();
async function ensureSession(userId: string, sessionId: string): Promise<void> {
  if (!pv.has(userId)) {
    const id = sid();
    await t.pg.exec(`
      insert into app.voice_catalog (id, label, provider_voice_id, wpm, settings_version)
        values ('v1', 'V', 'p', 100, 's') on conflict do nothing;
      insert into app.athlete_profile_versions (id, user_id, version, source, profile_enc)
        values ('${id}', '${userId}', 1, 'intake', '\\x01');`);
    pv.set(userId, id);
  }
  await t.pg.exec(`
    insert into app.sessions (id, user_id, context, length_min, engine, profile_version_id, voice_id, creation_key)
      values ('${sessionId}', '${userId}', 'training', 15, 'endurance_v1', '${pv.get(userId)}', 'v1', 'k-${sessionId}')
      on conflict do nothing`);
}

const reserve = async (
  userId: string,
  context: 'training' | 'night_before' | 'primer',
  ent: EntitlementState | null,
  special = false,
  sessionId = sid(),
) => {
  await ensureSession(userId, sessionId);
  return withUserTx(t.api, userId, (trx) =>
    reserveSession(trx, { userId, sessionId, context, fromSpecialItem: special, now, ent, cfg }),
  );
};

const avail = async (userId: string, type: string) =>
  Number(
    (
      await t.admin.kysely
        .selectFrom('app.usage_ledger')
        .select((eb) => eb.fn.sum<string>('quantity').as('s'))
        .where('user_id', '=', userId)
        .where('allowance_type', '=', type as never)
        .executeTakeFirst()
    )?.s ?? 0,
  );

beforeAll(async () => {
  t = await createTestDb();
  for (const u of [FREE, PRO, TRIAL]) await ensureUser(t.api, u, cfg, new Date('2026-09-01T00:00:00Z'));
});
afterAll(() => t.close());

describe('account bootstrap', () => {
  it('writes the lifetime free grants exactly once', async () => {
    await ensureUser(t.api, FREE, cfg, new Date());
    await ensureUser(t.api, FREE, cfg, new Date());
    expect(await avail(FREE, 'free_training')).toBe(1);
    expect(await avail(FREE, 'free_primer')).toBe(1);
  });
});

describe('free allowance', () => {
  it('spends the free training session once, then reports the allowance as used', async () => {
    const id = sid();
    await reserve(FREE, 'training', null, false, id);
    expect(await avail(FREE, 'free_training')).toBe(0);
    await expect(reserve(FREE, 'training', null)).rejects.toMatchObject({ code: 'ALLOWANCE_EXHAUSTED' });
    // Same session id again is idempotent and does not spend twice.
    await reserve(FREE, 'training', null, false, id);
    expect(await avail(FREE, 'free_training')).toBe(0);
  });

  it('refuses night-before and on-demand primers for free users but lets the scheduled primer use its grant', async () => {
    await expect(reserve(FREE, 'night_before', null)).rejects.toMatchObject({ code: 'ENTITLEMENT_REQUIRED' });
    await expect(reserve(FREE, 'primer', null, false)).rejects.toMatchObject({ code: 'ENTITLEMENT_REQUIRED' });
    expect(await avail(FREE, 'free_primer')).toBe(1);
    await reserve(FREE, 'primer', null, true);
    expect(await avail(FREE, 'free_primer')).toBe(0);
  });
});

describe('reverse and commit', () => {
  it('gives the session back once and never after a commit', async () => {
    const u = PRO;
    const ent = proEnt('normal');
    const a = sid();
    await reserve(u, 'training', ent, false, a);
    const before = await avail(u, 'pro');
    expect(await withUserTx(t.api, u, (trx) => reverseReservation(trx, u, a))).toBe(true);
    expect(await withUserTx(t.api, u, (trx) => reverseReservation(trx, u, a))).toBe(false);
    expect(await avail(u, 'pro')).toBe(before + 1);

    const b = sid();
    await reserve(u, 'training', ent, false, b);
    await withUserTx(t.api, u, (trx) => commitReservation(trx, u, b));
    await withUserTx(t.api, u, (trx) => commitReservation(trx, u, b));
    expect(await withUserTx(t.api, u, (trx) => reverseReservation(trx, u, b))).toBe(false);
  });
});

describe('pro allowance buckets and holds', () => {
  it('grants the monthly allowance lazily on first need', async () => {
    const before = await avail(PRO, 'pro');
    expect(before).toBeGreaterThan(0); // written by the earlier tests
    const ledger = await t.admin.kysely
      .selectFrom('app.usage_ledger')
      .select(['idempotency_key', 'quantity'])
      .where('user_id', '=', PRO)
      .where('entry_type', '=', 'grant')
      .where('allowance_type', '=', 'pro')
      .execute();
    expect(ledger).toEqual([{ idempotency_key: `grant:${PRO}:2026-10-01T09:00:00.000Z`, quantity: 12 }]);
  });

  it('keeps allowance held for upcoming special items out of reach of on-demand sessions', async () => {
    // Hold every remaining session for three scheduled special items, then watch on-demand run dry first.
    const ent = proEnt('normal');
    const remaining = await avail(PRO, 'pro');
    await t.pg.exec(`
      insert into app.events (id, user_id, name_enc, starts_local, time_zone, starts_at, supported_sport_id, engine)
        values ('e0000000-0000-4000-8000-000000000001', '${PRO}', '\\x01', '2026-10-30 08:00', 'UTC', '2026-10-30 08:00+00', 'golf', 'closed_skill_v1');
      insert into app.programs (id, user_id, event_id) values ('f0000000-0000-4000-8000-000000000001', '${PRO}', 'e0000000-0000-4000-8000-000000000001');
      insert into app.program_items (user_id, program_id, kind, target_date, generate_at, state) values
        ('${PRO}', 'f0000000-0000-4000-8000-000000000001', 'night_before', '2026-10-29', '2026-10-27 08:00+00', 'planned'),
        ('${PRO}', 'f0000000-0000-4000-8000-000000000001', 'primer', '2026-10-30', '2026-10-27 08:00+00', 'planned');
    `);
    const summary = await withUserTx(t.api, PRO, (trx) => allowanceSummary(trx, PRO, ent, now));
    expect(summary.pro).toMatchObject({ available: remaining, held_for_events: 2, available_for_on_demand: remaining - 2 });

    for (let i = 0; i < remaining - 2; i++) await reserve(PRO, 'training', ent);
    await expect(reserve(PRO, 'training', ent)).rejects.toMatchObject({ code: 'ALLOWANCE_EXHAUSTED' });
    // The held sessions are still there for the special items themselves.
    await reserve(PRO, 'night_before', ent, true);
    await reserve(PRO, 'primer', ent, true);
    await expect(reserve(PRO, 'primer', ent, true)).rejects.toMatchObject({ code: 'ALLOWANCE_EXHAUSTED' });
  });

  it('never goes negative under concurrent reservations', async () => {
    const u = '44444444-4444-4444-8444-444444444444';
    await ensureUser(t.api, u, cfg, new Date('2026-09-01T00:00:00Z'));
    const ent = proEnt('normal');
    await reserve(u, 'training', ent); // creates the grant
    // Drain down to exactly one left.
    for (let i = 0; i < 10; i++) await reserve(u, 'training', ent);
    expect(await avail(u, 'pro')).toBe(1);
    const results = await Promise.allSettled([reserve(u, 'training', ent), reserve(u, 'training', ent), reserve(u, 'training', ent)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await avail(u, 'pro')).toBe(0);
  });
});

describe('trial allowance', () => {
  it('grants the trial allowance, then tops up to the full allowance on conversion', async () => {
    await reserve(TRIAL, 'training', proEnt('trial'));
    expect(await avail(TRIAL, 'pro')).toBe(2); // 3 trial sessions minus one
    await reserve(TRIAL, 'training', proEnt('normal'));
    // After conversion the bucket holds 12 in total, two of which are spent.
    expect(await avail(TRIAL, 'pro')).toBe(12 - 2);
    await reserve(TRIAL, 'training', proEnt('normal'));
    expect(await avail(TRIAL, 'pro')).toBe(12 - 3); // the top-up is written once only
  });

  it('loads and evaluates entitlement state', async () => {
    expect(await withUserTx(t.api, FREE, (trx) => loadEntitlement(trx, FREE))).toBeNull();
  });
});
