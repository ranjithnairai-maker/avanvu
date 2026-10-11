/**
 * Per-user data keys (CONTRACTS §12): one 256-bit key per user, generated on first sensitive write,
 * wrapped by KMS, stored in app.user_data_keys. Unwrapped keys live only in process memory for at most
 * 5 minutes (LRU, max 500 entries) and are never logged or serialised.
 */
import { generateRawDataKey, importDataKey, type DataKeyProvider } from '@avanvu/core';
import { withSystemTx, type Db } from '../db/tx';
import { keyWrapAad, type KmsClient } from './kms';

interface CacheEntry {
  key: CryptoKey;
  keyVersion: number;
  expires: number;
}

export interface KeyProviderOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export class DbDataKeyProvider implements DataKeyProvider {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttl: number;
  private readonly max: number;
  private readonly now: () => number;

  constructor(
    private readonly db: Db,
    private readonly kms: KmsClient,
    opts: KeyProviderOptions = {},
  ) {
    this.ttl = opts.ttlMs ?? 5 * 60_000;
    this.max = opts.maxEntries ?? 500;
    this.now = opts.now ?? Date.now;
  }

  async getKey(userId: string, keyVersion?: number): Promise<{ key: CryptoKey; keyVersion: number }> {
    const cacheKey = `${userId}:${keyVersion ?? 'latest'}`;
    const hit = this.cache.get(cacheKey);
    if (hit && hit.expires > this.now()) {
      // LRU: re-insert to mark as recently used.
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, hit);
      return { key: hit.key, keyVersion: hit.keyVersion };
    }
    this.cache.delete(cacheKey);

    const loaded = await this.load(userId, keyVersion);
    this.cache.set(cacheKey, { ...loaded, expires: this.now() + this.ttl });
    while (this.cache.size > this.max) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return loaded;
  }

  private async load(userId: string, keyVersion?: number): Promise<{ key: CryptoKey; keyVersion: number }> {
    const read = () =>
      withSystemTx(this.db, 'system', async (trx) => {
        let q = trx.selectFrom('app.user_data_keys').selectAll().where('user_id', '=', userId);
        q =
          keyVersion === undefined
            ? q.orderBy('key_version', 'desc').limit(1)
            : q.where('key_version', '=', keyVersion);
        return q.executeTakeFirst();
      });

    let row = await read();
    if (!row && keyVersion === undefined) {
      // First sensitive write for this user: create version 1. Concurrent creators race on the primary key.
      const raw = await generateRawDataKey();
      const { wrapped, kmsKeyVersion } = await this.kms.wrap(raw, keyWrapAad(userId));
      await withSystemTx(this.db, 'system', (trx) =>
        trx
          .insertInto('app.user_data_keys')
          .values({ user_id: userId, key_version: 1, wrapped_key: wrapped, kms_key_version: kmsKeyVersion })
          .onConflict((oc) => oc.columns(['user_id', 'key_version']).doNothing())
          .execute(),
      );
      row = await read();
    }
    if (!row) throw new Error('data key not found');
    const raw = await this.kms.unwrap(
      new Uint8Array(row.wrapped_key),
      keyWrapAad(userId),
      row.kms_key_version,
    );
    return { key: await importDataKey(raw), keyVersion: row.key_version };
  }

  /** Drop everything, for example after account deletion or in tests. */
  clear(): void {
    this.cache.clear();
  }
}
