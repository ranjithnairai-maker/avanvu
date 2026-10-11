/** Shared request plumbing for the API: dependencies, validation and the idempotent-mutation helper. */
import type { Context } from 'hono';
import type { ZodType, z } from 'zod';
import { AvanvuError, type BackendConfig } from '@avanvu/core';
import type { AccountGuard } from '../domain/accounts';
import type { Db, Tx } from '../db/tx';
import type { Authenticator } from '../http/auth';
import { Idempotency, parseIdempotencyKey, requestHash, type IdempotentResult } from '../http/idempotency';
import type { LimitSpec, RateLimiter } from '../http/ratelimit';
import type { Logger } from '../observability/logger';
import type { LlmClient } from '../ports/llm';
import type { Sealer, UserSealer } from '../security/seal';

export interface AppDeps {
  db: Db;
  sealer: Sealer;
  idem: Idempotency;
  limiter: RateLimiter;
  auth: Authenticator;
  accounts: AccountGuard;
  logger: Logger;
  llm: LlmClient;
  /** Server-side timeout for one intake model call (CONTRACTS §4.3 step 6). */
  intakeTimeoutMs: number;
  config: Pick<
    BackendConfig,
    'PRO_MONTHLY_ALLOWANCE' | 'TRIAL_SESSION_ALLOWANCE' | 'FREE_TRAINING_GRANT' | 'FREE_PRIMER_GRANT'
  >;
  now: () => Date;
}

export interface AppEnv {
  Variables: { requestId: string; userId: string; logger: Logger };
}

export type Ctx = Context<AppEnv>;

/** Validation failures name the failing paths only, never the submitted values. */
export function parseWith<S extends ZodType>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const paths = [...new Set(r.error.issues.map((i) => i.path.join('.') || '(body)'))].slice(0, 6);
  throw new AvanvuError('VALIDATION_FAILED', `Check these fields: ${paths.join(', ')}.`);
}

export async function readJson(c: Ctx): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new AvanvuError('VALIDATION_FAILED', 'The request body must be valid JSON.');
  }
}

export interface MutationHandlerArgs<B> {
  trx: Tx;
  body: B;
  userId: string;
  sealer: UserSealer;
  now: Date;
}

/**
 * Run a mutating endpoint: Idempotency-Key required, body validated, handler executed once per key inside
 * a user transaction, result stored atomically (CONTRACTS §9, CLAUDE.md non-negotiable 5).
 */
export async function mutate<S extends ZodType | null>(
  c: Ctx,
  deps: AppDeps,
  opts: { endpoint: string; schema: S; limit?: LimitSpec },
  handler: (
    args: MutationHandlerArgs<S extends ZodType ? z.infer<S> : undefined>,
  ) => Promise<IdempotentResult>,
): Promise<Response> {
  const userId = c.get('userId');
  const key = parseIdempotencyKey(c.req.header('Idempotency-Key'));
  const raw = opts.schema ? await readJson(c) : undefined;
  const body = (opts.schema ? parseWith(opts.schema, raw) : undefined) as S extends ZodType
    ? z.infer<S>
    : undefined;
  if (opts.limit) await deps.limiter.enforce(userId, opts.limit);

  const result = await deps.idem.run(
    { userId, endpoint: opts.endpoint, key, hash: await requestHash(c.req.method, c.req.path, raw) },
    (trx, sealer) => handler({ trx, body, userId, sealer, now: deps.now() }),
  );
  return c.json(result.body as object, result.status as 200);
}

export type { Db };
