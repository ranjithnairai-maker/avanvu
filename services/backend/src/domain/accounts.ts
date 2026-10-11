/**
 * Account bootstrap and deletion checks. The first authenticated request creates the `app.users` row
 * (id = Supabase auth user id) and writes the lifetime free grants (CONTRACTS §11).
 */
import { AvanvuError } from '@avanvu/core';
import { withUserTx, type Db, type Tx } from '../db/tx';

export interface FreeGrantConfig {
  FREE_TRAINING_GRANT: number;
  FREE_PRIMER_GRANT: number;
}

/** Free grants live in one lifetime bucket from account creation. */
export const FREE_BUCKET_END = new Date('9999-12-31T00:00:00Z');

export async function writeFreeGrants(trx: Tx, userId: string, createdAt: Date, cfg: FreeGrantConfig): Promise<void> {
  const grants = [
    ['free_training', cfg.FREE_TRAINING_GRANT],
    ['free_primer', cfg.FREE_PRIMER_GRANT],
  ] as const;
  for (const [type, quantity] of grants) {
    if (quantity <= 0) continue;
    await trx
      .insertInto('app.usage_ledger')
      .values({
        user_id: userId,
        allowance_type: type,
        bucket_start: createdAt,
        bucket_end: FREE_BUCKET_END,
        entry_type: 'grant',
        quantity,
        idempotency_key: `grant:${userId}:${type}`,
      })
      .onConflict((oc) => oc.column('idempotency_key').doNothing())
      .execute();
  }
}

export interface AccountRow {
  id: string;
  analytics_id: string;
  demo_account: boolean;
  time_zone: string | null;
  deleted_at: Date | null;
  created_at: Date;
}

export async function ensureUser(db: Db, userId: string, cfg: FreeGrantConfig, now: Date): Promise<AccountRow> {
  return withUserTx(db, userId, async (trx) => {
    await trx
      .insertInto('app.users')
      .values({ id: userId, created_at: now, updated_at: now, age_assurance_method: null, age_assured_at: null, deleted_at: null, time_zone: null })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
    const row = await trx
      .selectFrom('app.users')
      .select(['id', 'analytics_id', 'demo_account', 'time_zone', 'deleted_at', 'created_at'])
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    if (!row.deleted_at) await writeFreeGrants(trx, userId, new Date(row.created_at), cfg);
    return {
      ...row,
      deleted_at: row.deleted_at ? new Date(row.deleted_at) : null,
      created_at: new Date(row.created_at),
    };
  });
}

/** Deleted accounts get ACCOUNT_DELETED even with an unexpired token; the lookup is cached up to 60 s. */
export class AccountGuard {
  private readonly cache = new Map<string, { deleted: boolean; at: number }>();

  constructor(
    private readonly db: Db,
    private readonly cfg: FreeGrantConfig,
    private readonly now: () => Date = () => new Date(),
    private readonly ttlMs = 60_000,
  ) {}

  async check(userId: string): Promise<AccountRow | null> {
    const hit = this.cache.get(userId);
    if (hit && this.now().getTime() - hit.at < this.ttlMs) {
      if (hit.deleted) throw new AvanvuError('ACCOUNT_DELETED', 'This account has been deleted.');
      return null; // cached healthy: the row was loaded on an earlier request
    }
    const row = await ensureUser(this.db, userId, this.cfg, this.now());
    this.cache.set(userId, { deleted: row.deleted_at !== null, at: this.now().getTime() });
    if (row.deleted_at) throw new AvanvuError('ACCOUNT_DELETED', 'This account has been deleted.');
    return row;
  }

  /** Called when a deletion starts so this instance stops serving the account at once. */
  markDeleted(userId: string): void {
    this.cache.set(userId, { deleted: true, at: this.now().getTime() });
  }
}
