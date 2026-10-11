/**
 * Postgres token buckets (D-16, SPEC §11.3): atomic, work across instances, no new vendor.
 * `consume` takes `cost` tokens if available. Refill is continuous at capacity / window.
 */
import { sql } from 'kysely';
import { AvanvuError } from '@avanvu/core';
import { withSystemTx, type Db } from '../db/tx';

export interface LimitSpec {
  name: string;
  capacity: number;
  windowSeconds: number;
}

/** Default limits (SPEC §11.3). */
export const LIMITS = {
  intakeTurns: { name: 'intake_turns', capacity: 60, windowSeconds: 3600 },
  sessionCreations: { name: 'session_creations', capacity: 10, windowSeconds: 86_400 },
  accountMutations: { name: 'account_mutations', capacity: 20, windowSeconds: 3600 },
  ipRequests: { name: 'ip_requests', capacity: 60, windowSeconds: 60 },
} as const satisfies Record<string, LimitSpec>;

export interface ConsumeResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export class RateLimiter {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async consume(subject: string, spec: LimitSpec, cost = 1): Promise<ConsumeResult> {
    const refill = spec.capacity / spec.windowSeconds; // tokens per second
    const now = this.now();
    return withSystemTx(this.db, 'api_system', async (trx) => {
      // One atomic statement: refill since last update, then take `cost` only if enough remain.
      const taken = await sql<{ tokens: number }>`
        insert into app.rate_limit_buckets (subject, limit_name, tokens, updated_at)
        values (${subject}, ${spec.name}, ${spec.capacity - cost}, ${now})
        on conflict (subject, limit_name) do update
          set tokens = least(${spec.capacity}::float8,
                             app.rate_limit_buckets.tokens
                               + greatest(0, extract(epoch from (${now}::timestamptz - app.rate_limit_buckets.updated_at))) * ${refill}::float8)
                       - ${cost}::float8,
              updated_at = ${now}
          where least(${spec.capacity}::float8,
                      app.rate_limit_buckets.tokens
                        + greatest(0, extract(epoch from (${now}::timestamptz - app.rate_limit_buckets.updated_at))) * ${refill}::float8)
                >= ${cost}::float8
        returning tokens`.execute(trx);
      const row = taken.rows[0];
      if (row) return { allowed: true, remaining: Math.floor(row.tokens), retryAfterMs: 0 };

      const cur = await trx
        .selectFrom('app.rate_limit_buckets')
        .select(['tokens', 'updated_at'])
        .where('subject', '=', subject)
        .where('limit_name', '=', spec.name)
        .executeTakeFirstOrThrow();
      const elapsed = Math.max(0, (now.getTime() - new Date(cur.updated_at).getTime()) / 1000);
      const have = Math.min(spec.capacity, cur.tokens + elapsed * refill);
      return { allowed: false, remaining: 0, retryAfterMs: Math.ceil(((cost - have) / refill) * 1000) };
    });
  }

  /** Throws RATE_LIMITED with `retry_after_ms` when the bucket is empty. */
  async enforce(subject: string, spec: LimitSpec, cost = 1): Promise<void> {
    const r = await this.consume(subject, spec, cost);
    if (!r.allowed)
      throw new AvanvuError('RATE_LIMITED', 'Too many requests. Try again shortly.', {
        retryAfterMs: r.retryAfterMs,
      });
  }
}
