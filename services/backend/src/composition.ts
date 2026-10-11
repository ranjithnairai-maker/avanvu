/**
 * Process composition: turns validated configuration into the API and worker dependency graphs.
 *
 *  - local:        fake vendors (dev LLM, fake TTS, file storage, in-process queue). No keys needed.
 *  - preview/prod: real adapters are required. The vendor adapters (Anthropic, ElevenLabs, Supabase Storage,
 *    Cloud Tasks, Cloud KMS, Expo push, RevenueCat, Apple, PostHog) are external-API integrations that are
 *    still placeholders, so these environments REFUSE TO START and name exactly what is missing, rather than
 *    silently running against fakes or throwing at the first athlete request.
 */
import {
  AvanvuError,
  FakeTtsProvider,
  loadBackendConfig,
  type BackendConfig,
  type TtsProvider,
} from '@avanvu/core';
import { resolve } from 'node:path';
import { createDb } from './db/client';
import type { Db } from './db/tx';
import { AccountGuard } from './domain/accounts';
import { OutboxDispatcher } from './domain/outbox';
import { Scheduler } from './domain/scheduler';
import { CostGuard } from './domain/sessions';
import { DevLlm } from './dev/devLlm';
import { FileStorage } from './dev/fileStorage';
import { Idempotency } from './http/idempotency';
import { createJwtAuthenticator, remoteJwks } from './http/auth';
import { RateLimiter } from './http/ratelimit';
import { Logger } from './observability/logger';
import { UnconfiguredLlm, type LlmClient } from './ports/llm';
import { UnconfiguredPush, FakePush, type PushClient } from './ports/push';
import { InProcessQueue, UnconfiguredQueue, type TaskQueue } from './ports/queue';
import { UnconfiguredStorage, type Storage } from './ports/storage';
import {
  FakeAccountVendors,
  FakeApple,
  FakeRevenueCat,
  UnconfiguredAccountVendors,
  UnconfiguredApple,
  UnconfiguredRevenueCat,
  type AccountVendors,
  type AppleAuth,
  type RevenueCatClient,
} from './ports/vendors';
import { Renderer } from './render/renderer';
import { DbDataKeyProvider } from './security/keys';
import { GcpKms, LocalKms, type KmsClient } from './security/kms';
import { Sealer } from './security/seal';
import { createGoogleTaskAuth, createStaticTaskAuth, type TaskAuth } from './worker/taskauth';
import { RenderWorker, type WorkerConfig } from './worker/render';
import type { AppDeps } from './api/context';
import type { WorkerAppDeps } from './worker/app';

export class UnimplementedAdaptersError extends Error {
  constructor(readonly missing: string[]) {
    super(
      `Refusing to start: these production adapters are not implemented yet: ${missing.join(', ')}. ` +
        'Run with AVANVU_ENV=local, or implement the adapters (see docs/runbooks/go-live.md).',
    );
    this.name = 'UnimplementedAdaptersError';
  }
}

interface Adapters {
  llm: LlmClient;
  tts: TtsProvider;
  storage: Storage;
  queue: TaskQueue;
  push: PushClient;
  kms: KmsClient;
  revenuecat: RevenueCatClient;
  apple: AppleAuth;
  vendors: AccountVendors;
  /** Names of adapters that are placeholders in this environment. */
  placeholders: string[];
}

class UnconfiguredTts implements TtsProvider {
  readonly name = 'unconfigured';
  listVoices(): Promise<never> {
    return Promise.reject(new AvanvuError('UPSTREAM_UNAVAILABLE', 'Text to speech is not configured yet.'));
  }
  synthesize(): Promise<never> {
    return Promise.reject(new AvanvuError('UPSTREAM_UNAVAILABLE', 'Text to speech is not configured yet.'));
  }
}

async function buildAdapters(cfg: BackendConfig, env: NodeJS.ProcessEnv): Promise<Adapters> {
  if (cfg.AVANVU_ENV === 'local') {
    const base = env.DEV_PUBLIC_BASE ?? 'http://localhost:8080';
    return {
      llm: new DevLlm(),
      tts: new FakeTtsProvider(100),
      storage: new FileStorage(resolve(env.DEV_STORAGE_DIR ?? '.dev-storage'), base),
      queue: new InProcessQueue(),
      push: new FakePush(),
      kms: await LocalKms.create(env.LOCAL_KMS_MASTER_KEY),
      revenuecat: new FakeRevenueCat(),
      apple: new FakeApple(),
      vendors: new FakeAccountVendors(),
      placeholders: [],
    };
  }
  return {
    llm: new UnconfiguredLlm(),
    tts: new UnconfiguredTts(),
    storage: new UnconfiguredStorage(),
    queue: new UnconfiguredQueue(),
    push: new UnconfiguredPush(),
    kms: new GcpKms(cfg.KMS_KEY_NAME),
    revenuecat: new UnconfiguredRevenueCat(),
    apple: new UnconfiguredApple(),
    vendors: new UnconfiguredAccountVendors(),
    placeholders: [
      'anthropic',
      'elevenlabs',
      'supabase-storage',
      'cloud-tasks',
      'cloud-kms',
      'expo-push',
      'revenuecat',
      'apple-siwa',
      'posthog-and-auth-admin',
    ],
  };
}

export interface Runtime {
  cfg: BackendConfig;
  logger: Logger;
  api?: { deps: AppDeps; scheduler: Scheduler; db: Db };
  worker?: { deps: WorkerAppDeps; db: Db };
  adapters: Adapters;
}

const workerConfig = (cfg: BackendConfig, env: NodeJS.ProcessEnv): WorkerConfig => ({
  LLM_MODEL_SCRIPT: cfg.LLM_MODEL_SCRIPT,
  LLM_MODEL_JUDGE: cfg.LLM_MODEL_JUDGE,
  LLM_EFFORT_SCRIPT: cfg.LLM_EFFORT_SCRIPT,
  TTS_MODEL_TRAINING: cfg.TTS_MODEL_TRAINING,
  TTS_MODEL_NIGHT_BEFORE: cfg.TTS_MODEL_NIGHT_BEFORE,
  TTS_MODEL_PRIMER: cfg.TTS_MODEL_PRIMER,
  TTS_SPEED: Number(env.TTS_SPEED ?? 0.92),
  TTS_STABILITY: Number(env.TTS_STABILITY ?? 0.8),
  TTS_COST_PER_1K_CHARS: Number(env.TTS_COST_PER_1K_CHARS ?? 0.1),
});

export async function compose(
  role: 'api' | 'worker' | 'both',
  env: NodeJS.ProcessEnv = process.env,
): Promise<Runtime> {
  const cfg = loadBackendConfig(env as Record<string, string | undefined>);
  const logger = new Logger({ service: role, env: cfg.AVANVU_ENV });
  const adapters = await buildAdapters(cfg, env);
  if (adapters.placeholders.length > 0) throw new UnimplementedAdaptersError(adapters.placeholders);

  const now = () => new Date();
  const rt: Runtime = { cfg, logger, adapters };
  const taskAuth = (audience: string, sa: string): TaskAuth =>
    cfg.AVANVU_ENV === 'local'
      ? createStaticTaskAuth(env.LOCAL_TASK_TOKEN ?? 'local-task-token')
      : createGoogleTaskAuth({ audience, serviceAccountEmail: sa });

  if (role === 'api' || role === 'both') {
    const db = createDb(cfg.DATABASE_URL_API);
    const sealer = new Sealer(new DbDataKeyProvider(db, adapters.kms));
    const dispatcher = new OutboxDispatcher(db, adapters.queue, logger, now);
    const costGuard = new CostGuard(db, cfg.COST_CAP_DAILY_USD, now);
    const allowance = {
      PRO_MONTHLY_ALLOWANCE: cfg.PRO_MONTHLY_ALLOWANCE,
      TRIAL_SESSION_ALLOWANCE: cfg.TRIAL_SESSION_ALLOWANCE,
      FREE_TRAINING_GRANT: cfg.FREE_TRAINING_GRANT,
      FREE_PRIMER_GRANT: cfg.FREE_PRIMER_GRANT,
    };
    const scheduler = new Scheduler({
      db,
      sealer,
      dispatcher,
      costGuard,
      storage: adapters.storage,
      logger,
      now,
      config: allowance,
    });
    const deps: AppDeps = {
      db,
      sealer,
      idem: new Idempotency(db, sealer, now),
      limiter: new RateLimiter(db, now),
      auth: createJwtAuthenticator({
        issuer: cfg.SUPABASE_JWT_ISSUER,
        keys: remoteJwks(cfg.SUPABASE_JWKS_URL),
      }),
      accounts: new AccountGuard(db, allowance, now),
      logger,
      llm: adapters.llm,
      storage: adapters.storage,
      apple: adapters.apple,
      revenuecat: adapters.revenuecat,
      webhookAuth: cfg.REVENUECAT_WEBHOOK_AUTH,
      dispatcher,
      costGuard,
      intakeTimeoutMs: 40_000,
      config: allowance,
      now,
      internal: {
        auth: taskAuth(env.API_BASE_URL ?? 'http://localhost:8080', env.SCHEDULER_SA ?? cfg.TASKS_INVOKER_SA),
        scheduler,
      },
    };
    rt.api = { deps, scheduler, db };
  }

  if (role === 'worker' || role === 'both') {
    const db = createDb(cfg.DATABASE_URL_WORKER);
    const sealer = new Sealer(new DbDataKeyProvider(db, adapters.kms));
    const dispatcher = new OutboxDispatcher(db, adapters.queue, logger, now);
    const renderer = new Renderer(adapters.tts, adapters.storage, { ffmpegBin: env.FFMPEG_PATH ?? 'ffmpeg' });
    const worker = new RenderWorker({
      db,
      sealer,
      llm: adapters.llm,
      tts: adapters.tts,
      storage: adapters.storage,
      renderer,
      logger,
      now,
      config: workerConfig(cfg, env),
      owner: `${role}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`,
      dispatcher,
    });
    rt.worker = {
      db,
      deps: {
        auth: taskAuth(cfg.WORKER_BASE_URL, cfg.TASKS_INVOKER_SA),
        worker,
        db,
        push: adapters.push,
        logger,
        now,
        account: {
          revenuecat: adapters.revenuecat,
          deletion: {
            db,
            sealer,
            storage: adapters.storage,
            apple: adapters.apple,
            revenuecat: adapters.revenuecat,
            vendors: adapters.vendors,
            logger,
            now,
          },
          export: { db, sealer, storage: adapters.storage, dispatcher, logger, now },
        },
      },
    };
  }
  return rt;
}
