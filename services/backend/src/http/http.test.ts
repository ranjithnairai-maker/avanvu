import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AvanvuError } from '@avanvu/core';
import { createTestDb, type TestDb } from '../testing/pglite';
import { DbDataKeyProvider } from '../security/keys';
import { LocalKms } from '../security/kms';
import { Sealer } from '../security/seal';
import { Idempotency, parseIdempotencyKey, requestHash } from './idempotency';
import { LIMITS, RateLimiter } from './ratelimit';
import { withUserTx } from '../db/tx';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const KEY = '33333333-3333-4333-8333-333333333333';
let t: TestDb;
let idem: Idempotency;
let clock = new Date('2026-10-11T12:00:00Z');

beforeAll(async () => {
  t = await createTestDb();
  await t.pg.exec(`insert into app.users (id) values ('${A}'), ('${B}')`);
  const sealer = new Sealer(new DbDataKeyProvider(t.api, await LocalKms.create()));
  idem = new Idempotency(t.api, sealer, () => clock);
});
afterAll(() => t.close());

const req = async (body: unknown, userId = A, key = KEY) => ({
  userId,
  endpoint: 'POST /v1/waitlist',
  key,
  hash: await requestHash('POST', '/v1/waitlist', body),
});

const insertWaitlist = (userId: string, label: string) => (trx: import('../db/tx').Tx) =>
  trx.insertInto('app.waitlist_entries').values({ user_id: userId, sport_label: label }).execute();

describe('idempotency', () => {
  it('rejects missing or malformed keys', () => {
    expect(() => parseIdempotencyKey(undefined)).toThrow(AvanvuError);
    expect(() => parseIdempotencyKey('nope')).toThrow(/Idempotency-Key/);
    expect(parseIdempotencyKey(KEY.toUpperCase())).toBe(KEY);
  });

  it('hashes bodies independent of key order', async () => {
    expect(await requestHash('POST', '/x', { a: 1, b: { c: 2, d: 3 } })).toBe(
      await requestHash('POST', '/x', { b: { d: 3, c: 2 }, a: 1 }),
    );
    expect(await requestHash('POST', '/x', { a: 1 })).not.toBe(await requestHash('POST', '/x', { a: 2 }));
  });

  it('runs a mutation once and replays the stored response (same key, same body)', async () => {
    let calls = 0;
    const r = await req({ sport: 'Curling' });
    const handler = async (trx: import('../db/tx').Tx) => {
      calls++;
      await insertWaitlist(A, 'Curling')(trx);
      return { status: 201, body: { ok: true, note: 'fictional athlete text' } };
    };
    const first = await idem.run(r, handler);
    const second = await idem.run(r, handler);
    expect(calls).toBe(1);
    expect(second).toEqual(first);
    const rows = await t.admin.kysely
      .selectFrom('app.waitlist_entries')
      .selectAll()
      .where('user_id', '=', A)
      .execute();
    expect(rows).toHaveLength(1);
    // The stored response is sealed, not plaintext.
    const stored = await t.admin.kysely
      .selectFrom('app.idempotency_keys')
      .selectAll()
      .where('user_id', '=', A)
      .executeTakeFirstOrThrow();
    expect(Buffer.from(stored.response_enc!).includes(Buffer.from('fictional'))).toBe(false);
  });

  it('rejects the same key with a different body', async () => {
    await expect(
      idem.run(await req({ sport: 'Something else' }), async () => ({ status: 200, body: {} })),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
  });

  it('answers REQUEST_IN_PROGRESS while a request is still processing, and takes over a stale one', async () => {
    const k = '44444444-4444-4444-8444-444444444444';
    const r = await req({ sport: 'X' }, A, k);
    await idem.begin(r); // claimed, never completed
    await expect(idem.begin(r)).rejects.toMatchObject({ code: 'REQUEST_IN_PROGRESS', retryAfterMs: 1000 });
    clock = new Date(clock.getTime() + 3 * 60_000);
    expect((await idem.begin(r)).kind).toBe('new');
  });

  it('releases the claim when the handler fails so a retry succeeds', async () => {
    const k = '55555555-5555-4555-8555-555555555555';
    const r = await req({ sport: 'Y' }, A, k);
    await expect(
      idem.run(r, async (trx) => {
        await insertWaitlist(A, 'Y')(trx);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const rows = await t.admin.kysely
      .selectFrom('app.waitlist_entries')
      .select('sport_label')
      .where('sport_label', '=', 'Y')
      .execute();
    expect(rows).toHaveLength(0); // rolled back with the failed handler
    const ok = await idem.run(r, async () => ({ status: 200, body: { retried: true } }));
    expect(ok.body).toEqual({ retried: true });
  });

  it('keeps keys per user: the same key for another user is independent', async () => {
    const r = await req({ sport: 'Curling' }, B);
    const out = await idem.run(r, async (trx) => {
      await insertWaitlist(B, 'Curling')(trx);
      return { status: 201, body: { user: 'b' } };
    });
    expect(out.body).toEqual({ user: 'b' });
    const mine = await withUserTx(t.api, A, (trx) =>
      trx.selectFrom('app.idempotency_keys').select('user_id').execute(),
    );
    expect(new Set(mine.map((m) => m.user_id))).toEqual(new Set([A]));
  });
});

describe('rate limiter', () => {
  it('allows up to capacity then refuses with a retry delay, and refills over time', async () => {
    let now = new Date('2026-10-11T12:00:00Z');
    const rl = new RateLimiter(t.api, () => now);
    const spec = { name: 'test_burst', capacity: 3, windowSeconds: 30 }; // 0.1 token per second
    expect((await rl.consume('u1', spec)).allowed).toBe(true);
    expect((await rl.consume('u1', spec)).allowed).toBe(true);
    const third = await rl.consume('u1', spec);
    expect(third).toMatchObject({ allowed: true, remaining: 0 });
    const denied = await rl.consume('u1', spec);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(10_000);
    now = new Date(now.getTime() + 10_000);
    expect((await rl.consume('u1', spec)).allowed).toBe(true);
    expect((await rl.consume('u1', spec)).allowed).toBe(false);
  });

  it('isolates subjects and throws a retryable RATE_LIMITED error from enforce', async () => {
    const rl = new RateLimiter(t.api, () => new Date('2026-10-11T12:00:00Z'));
    const spec = { name: 'test_enforce', capacity: 1, windowSeconds: 60 };
    await rl.enforce('s1', spec);
    await rl.enforce('s2', spec);
    await expect(rl.enforce('s1', spec)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterMs: 60_000,
    });
  });

  it('is atomic under concurrency: never grants more than capacity', async () => {
    const rl = new RateLimiter(t.api, () => new Date('2026-10-11T12:00:00Z'));
    const spec = { name: 'test_conc', capacity: 5, windowSeconds: 3600 };
    const results = await Promise.all(Array.from({ length: 20 }, () => rl.consume('burst', spec)));
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
  });

  it('ships the documented default limits', () => {
    expect(LIMITS.intakeTurns).toMatchObject({ capacity: 60, windowSeconds: 3600 });
    expect(LIMITS.sessionCreations).toMatchObject({ capacity: 10, windowSeconds: 86_400 });
  });
});
