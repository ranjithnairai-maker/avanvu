/** End-to-end test harness: real migrations on PGlite, a local JWKS, fake vendors, an injectable clock. */
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from 'jose';
import type { Hono } from 'hono';
import { AccountGuard } from '../domain/accounts';
import { createApp } from '../api/app';
import type { AppDeps, AppEnv } from '../api/context';
import { createJwtAuthenticator } from '../http/auth';
import { Idempotency } from '../http/idempotency';
import { RateLimiter } from '../http/ratelimit';
import { Logger } from '../observability/logger';
import { FakeLlm } from '../ports/llm';
import { MemoryStorage } from '../ports/storage';
import { InProcessQueue } from '../ports/queue';
import { OutboxDispatcher } from '../domain/outbox';
import { CostGuard } from '../domain/sessions';
import { DbDataKeyProvider } from '../security/keys';
import { LocalKms } from '../security/kms';
import { Sealer } from '../security/seal';
import { createTestDb, type TestDb } from './pglite';

export const ISSUER = 'https://test.supabase.co/auth/v1';

export const USER_A = '11111111-1111-4111-8111-111111111111';
export const USER_B = '22222222-2222-4222-8222-222222222222';

export interface Harness {
  db: TestDb;
  app: Hono<AppEnv>;
  deps: AppDeps;
  llm: FakeLlm;
  kms: LocalKms;
  storage: MemoryStorage;
  queue: InProcessQueue;
  dispatcher: OutboxDispatcher;
  sealer: Sealer;
  clock: { now: Date };
  logs: string[];
  token(userId: string, opts?: { expiresIn?: string; audience?: string; issuer?: string }): Promise<string>;
  call(
    method: string,
    path: string,
    opts?: {
      userId?: string;
      token?: string;
      body?: unknown;
      key?: string;
      headers?: Record<string, string>;
    },
    // Test responses are loosely typed on purpose: assertions read nested JSON directly.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<{ status: number; json: any; headers: Headers }>;
  close(): Promise<void>;
}

let keyCounter = 0;
let ipCounter = 0;
export const newKey = () => `00000000-0000-4000-8000-${String(++keyCounter).padStart(12, '0')}`;

export async function createHarness(opts: { now?: Date } = {}): Promise<Harness> {
  const db = await createTestDb();
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'ES256', use: 'sig' };
  const clock = { now: opts.now ?? new Date('2026-10-20T12:00:00Z') };
  const logs: string[] = [];
  const logger = new Logger({ service: 'api-test' }, { write: (l) => logs.push(l) }, 'debug');
  const kms = await LocalKms.create();
  const sealer = new Sealer(new DbDataKeyProvider(db.api, kms));
  const config = {
    PRO_MONTHLY_ALLOWANCE: 12,
    TRIAL_SESSION_ALLOWANCE: 3,
    FREE_TRAINING_GRANT: 1,
    FREE_PRIMER_GRANT: 1,
  };
  const now = () => new Date(clock.now);
  const llm = new FakeLlm();
  const storage = new MemoryStorage(now);
  const queue = new InProcessQueue();
  const dispatcher = new OutboxDispatcher(db.api, queue, logger, now);
  const costGuard = new CostGuard(db.api, 50, now);
  const deps: AppDeps = {
    db: db.api,
    sealer,
    idem: new Idempotency(db.api, sealer, now),
    limiter: new RateLimiter(db.api, now),
    auth: createJwtAuthenticator({ issuer: ISSUER, keys: createLocalJWKSet({ keys: [jwk] }) }),
    accounts: new AccountGuard(db.api, config, now),
    logger,
    llm,
    storage,
    dispatcher,
    costGuard,
    intakeTimeoutMs: 40_000,
    config,
    now,
  };
  const app = createApp(deps);

  const token: Harness['token'] = async (userId, o = {}) =>
    new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
      .setSubject(userId)
      .setIssuer(o.issuer ?? ISSUER)
      .setAudience(o.audience ?? 'authenticated')
      .setIssuedAt()
      .setExpirationTime(o.expiresIn ?? '1h')
      .sign(privateKey);

  const call: Harness['call'] = async (method, path, o = {}) => {
    // Each call comes from a fresh address unless the test pins one, so IP limits stay out of the way.
    const headers: Record<string, string> = {
      'x-forwarded-for': `10.${(++ipCounter >> 8) & 255}.${ipCounter & 255}.1`,
      ...(o.headers ?? {}),
    };
    const tok = o.token ?? (o.userId ? await token(o.userId) : undefined);
    if (tok) headers.Authorization = `Bearer ${tok}`;
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && !headers['Idempotency-Key']) headers['Idempotency-Key'] = o.key ?? newKey();
    const res = await app.request(path, {
      method,
      headers,
      ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
  };

  return {
    db,
    app,
    deps,
    llm,
    kms,
    storage,
    queue,
    dispatcher,
    sealer,
    clock,
    logs,
    token,
    call,
    close: () => db.close(),
  };
}
