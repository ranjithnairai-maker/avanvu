/**
 * Idempotency (CONTRACTS §9). Every mutating endpoint requires an `Idempotency-Key` (UUID).
 *
 *   new key                            -> process and store the result
 *   same key, same body, completed     -> return the stored response
 *   same key, same body, processing    -> 409 REQUEST_IN_PROGRESS (retryable)
 *   same key, different body           -> 409 IDEMPOTENCY_KEY_REUSED
 *
 * The stored response may contain athlete text, so it is sealed (🔒). The result is written in the same
 * transaction as the mutation, so "committed" and "recorded" cannot diverge. Database unique constraints
 * remain the final defence (usage_ledger.idempotency_key, sessions.creation_key, ...).
 */
import { AvanvuError } from '@avanvu/core';
import { withUserTx, type Db, type Tx } from '../db/tx';
import type { Sealer, UserSealer } from '../security/seal';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A request that never finished (crashed process) can be taken over after this long. */
const STALE_PROCESSING_MS = 2 * 60_000;

export function parseIdempotencyKey(header: string | null | undefined): string {
  if (!header || !UUID.test(header)) {
    throw new AvanvuError('VALIDATION_FAILED', 'A valid Idempotency-Key header is required.');
  }
  return header.toLowerCase();
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export async function requestHash(method: string, path: string, body: unknown): Promise<string> {
  const data = new TextEncoder().encode(`${method} ${path} ${canonical(body)}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface IdempotentResult {
  status: number;
  body: unknown;
}

export interface IdempotentRequest {
  userId: string;
  endpoint: string;
  key: string;
  hash: string;
}

type Begin = { kind: 'new' } | { kind: 'replay'; result: IdempotentResult };

const sealCtx = (req: IdempotentRequest) => ({
  table: 'idempotency_keys',
  column: 'response_enc',
  rowId: `${req.endpoint}:${req.key}`,
  schemaVersion: 'response_v1',
});

export class Idempotency {
  constructor(
    private readonly db: Db,
    private readonly sealer: Sealer,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Claim the key in its own committed transaction so concurrent duplicates see it. */
  async begin(req: IdempotentRequest, sealer?: UserSealer): Promise<Begin> {
    const s = sealer ?? (await this.sealer.forUser(req.userId)); // load the key before any transaction
    const now = this.now();
    return withUserTx(this.db, req.userId, async (trx) => {
      const inserted = await trx
        .insertInto('app.idempotency_keys')
        .values({
          user_id: req.userId,
          endpoint: req.endpoint,
          key: req.key,
          request_hash: req.hash,
          status: 'processing',
          response_code: null,
          response_enc: null,
          created_at: now,
          expires_at: new Date(now.getTime() + 7 * 86_400_000),
        })
        .onConflict((oc) => oc.columns(['user_id', 'endpoint', 'key']).doNothing())
        .returning('key')
        .executeTakeFirst();
      if (inserted) return { kind: 'new' } as const;

      const row = await trx
        .selectFrom('app.idempotency_keys')
        .selectAll()
        .where('user_id', '=', req.userId)
        .where('endpoint', '=', req.endpoint)
        .where('key', '=', req.key)
        .executeTakeFirstOrThrow();
      if (row.request_hash !== req.hash) {
        throw new AvanvuError(
          'IDEMPOTENCY_KEY_REUSED',
          'This request key was already used for a different request.',
        );
      }
      if (row.status === 'completed' && row.response_enc && row.response_code !== null) {
        const body = await s.open<unknown>(sealCtx(req), row.response_enc);
        return { kind: 'replay', result: { status: row.response_code, body } } as const;
      }
      if (now.getTime() - new Date(row.created_at).getTime() < STALE_PROCESSING_MS) {
        throw new AvanvuError('REQUEST_IN_PROGRESS', 'This request is still being processed.', {
          retryAfterMs: 1000,
        });
      }
      // Stale: the earlier attempt died. Take it over.
      await trx
        .updateTable('app.idempotency_keys')
        .set({ created_at: now })
        .where('user_id', '=', req.userId)
        .where('endpoint', '=', req.endpoint)
        .where('key', '=', req.key)
        .execute();
      return { kind: 'new' } as const;
    });
  }

  /** Record the result inside the caller's transaction (atomic with the mutation). */
  async completeInTx(
    trx: Tx,
    req: IdempotentRequest,
    result: IdempotentResult,
    sealer: UserSealer,
  ): Promise<void> {
    const sealed = await sealer.seal(sealCtx(req), result.body);
    await trx
      .updateTable('app.idempotency_keys')
      .set({ status: 'completed', response_code: result.status, response_enc: sealed })
      .where('user_id', '=', req.userId)
      .where('endpoint', '=', req.endpoint)
      .where('key', '=', req.key)
      .execute();
  }

  /** Release a claim after a failure so the client can retry with the same key. */
  async release(req: IdempotentRequest): Promise<void> {
    await withUserTx(this.db, req.userId, (trx) =>
      trx
        .deleteFrom('app.idempotency_keys')
        .where('user_id', '=', req.userId)
        .where('endpoint', '=', req.endpoint)
        .where('key', '=', req.key)
        .where('status', '=', 'processing')
        .execute(),
    );
  }

  /**
   * Run a mutation exactly once per key. The handler runs in a user transaction and its result is stored
   * in that same transaction. On error the claim is released so a retry can proceed.
   */
  async run(
    req: IdempotentRequest,
    handler: (trx: Tx, sealer: UserSealer) => Promise<IdempotentResult>,
  ): Promise<IdempotentResult> {
    const sealer = await this.sealer.forUser(req.userId);
    const started = await this.begin(req, sealer);
    if (started.kind === 'replay') return started.result;
    try {
      return await withUserTx(this.db, req.userId, async (trx) => {
        const result = await handler(trx, sealer);
        await this.completeInTx(trx, req, result, sealer);
        return result;
      });
    } catch (e) {
      await this.release(req).catch(() => undefined);
      throw e;
    }
  }
}
