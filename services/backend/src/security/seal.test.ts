import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../testing/pglite';
import { withSystemTx } from '../db/tx';
import { DbDataKeyProvider } from './keys';
import { LocalKms } from './kms';
import { Sealer, type SealContext } from './seal';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
let t: TestDb;
let kms: LocalKms;

beforeAll(async () => {
  t = await createTestDb();
  kms = await LocalKms.create();
  await t.pg.exec(`insert into app.users (id) values ('${A}'), ('${B}')`);
});
afterAll(() => t.close());

const ctx = (userId: string, rowId = 'row-1'): SealContext => ({
  table: 'intake_turns',
  column: 'content_enc',
  rowId,
  userId,
  schemaVersion: 'v1',
});

describe('per-user data keys', () => {
  it('creates a key on first use, wraps it, and reuses it afterwards', async () => {
    const keys = new DbDataKeyProvider(t.api, kms);
    const sealer = new Sealer(keys);
    const env = await sealer.seal(ctx(A), { text: 'fictional athlete text' });
    expect(await sealer.open(ctx(A), env)).toEqual({ text: 'fictional athlete text' });

    const rows = await t.admin.kysely
      .selectFrom('app.user_data_keys')
      .selectAll()
      .where('user_id', '=', A)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key_version).toBe(1);
    expect(Buffer.from(rows[0]!.wrapped_key).includes(Buffer.from('fictional'))).toBe(false);
  });

  it('survives concurrent first writes with exactly one key row', async () => {
    const keys = new DbDataKeyProvider(t.api, kms);
    const sealer = new Sealer(keys);
    const envs = await Promise.all(Array.from({ length: 6 }, (_, i) => sealer.seal(ctx(B, `r${i}`), { i })));
    const fresh = new Sealer(new DbDataKeyProvider(t.api, kms));
    for (const [i, e] of envs.entries()) expect(await fresh.open(ctx(B, `r${i}`), e)).toEqual({ i });
    const rows = await t.admin.kysely
      .selectFrom('app.user_data_keys')
      .select('key_version')
      .where('user_id', '=', B)
      .execute();
    expect(rows).toHaveLength(1);
  });

  it('refuses to open a ciphertext moved to another row or another user', async () => {
    const sealer = new Sealer(new DbDataKeyProvider(t.api, kms));
    const env = await sealer.seal(ctx(A, 'row-x'), { secret: true });
    await expect(sealer.open(ctx(A, 'row-y'), env)).rejects.toThrow();
    await expect(sealer.open(ctx(B, 'row-x'), env)).rejects.toThrow();
    await expect(sealer.open({ ...ctx(A, 'row-x'), column: 'other' }, env)).rejects.toThrow();
  });

  it('refuses to unwrap a key with the wrong KMS key', async () => {
    const other = await LocalKms.create();
    const sealer = new Sealer(new DbDataKeyProvider(t.api, other));
    await expect(sealer.seal(ctx(A), { x: 1 })).rejects.toThrow();
  });

  it('expires cache entries after the TTL and evicts beyond the limit', async () => {
    let now = 0;
    const keys = new DbDataKeyProvider(t.api, kms, { ttlMs: 1000, maxEntries: 1, now: () => now });
    await keys.getKey(A);
    await keys.getKey(B);
    expect((keys as unknown as { cache: Map<string, unknown> }).cache.size).toBe(1);
    now = 5000;
    // Remove the key row: a cache hit would still work, a refresh must fail to find it.
    await withSystemTx(t.admin, 'system', (trx) =>
      trx.deleteFrom('app.user_data_keys').where('user_id', '=', B).execute(),
    );
    await expect(keys.getKey(B, 1)).rejects.toThrow(/not found/);
  });
});
