/** Worker test harness: shares the API harness database, keys and storage, with its own role and fakes. */
import { createRequire } from 'node:module';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import {
  FakeTtsProvider,
  buildFictionalTimeline,
  JUDGE_CHECK_IDS,
  type SessionContext,
  type TtsProvider,
  type AthleteProfile,
} from '@avanvu/core';
import { DbDataKeyProvider } from '../security/keys';
import { Sealer } from '../security/seal';
import { FakePush } from '../ports/push';
import { OutboxDispatcher } from '../domain/outbox';
import { Renderer } from '../render/renderer';
import { createWorkerApp } from '../worker/app';
import { RenderWorker, type WorkerConfig } from '../worker/render';
import { createGoogleTaskAuth } from '../worker/taskauth';
import type { Harness } from './harness';

const require_ = createRequire(import.meta.url);
export const ffmpegBin: string = require_('ffmpeg-static');

export const WORKER_URL = 'https://worker.example.test';
export const INVOKER = 'tasks-invoker@avanvu-test.iam.gserviceaccount.com';

export const workerConfig: WorkerConfig = {
  LLM_MODEL_SCRIPT: 'script-model',
  LLM_MODEL_JUDGE: 'judge-model',
  LLM_EFFORT_SCRIPT: 'medium',
  TTS_MODEL_TRAINING: 'tts-training',
  TTS_MODEL_NIGHT_BEFORE: 'tts-night',
  TTS_MODEL_PRIMER: 'tts-primer',
  TTS_SPEED: 0.92,
  TTS_STABILITY: 0.8,
  TTS_COST_PER_1K_CHARS: 0.1,
};

export interface WorkerHarness {
  worker: RenderWorker;
  app: ReturnType<typeof createWorkerApp>;
  push: FakePush;
  tts: TtsProvider;
  /** Deliver a task to the worker app with a valid OIDC token. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deliver(path: string, body: unknown, token?: string | null): Promise<{ status: number; json: any }>;
  /** Drain the in-process queue into the worker app. Returns the statuses seen. */
  drain(opts?: { duplicate?: boolean; maxAttempts?: number }): Promise<number[]>;
  scriptFor(profile: AthleteProfile): void;
}

export async function createWorkerHarness(
  h: Harness,
  o: { tts?: TtsProvider; chunkRetries?: number } = {},
): Promise<WorkerHarness> {
  const tts = o.tts ?? new FakeTtsProvider(100);
  const sealer = new Sealer(new DbDataKeyProvider(h.db.worker, h.kms));
  const renderer = new Renderer(tts, h.storage, {
    ffmpegBin,
    sleep: async () => {},
    chunkRetries: o.chunkRetries ?? 3,
  });
  const worker = new RenderWorker({
    db: h.db.worker,
    sealer,
    llm: h.llm,
    tts,
    storage: h.storage,
    renderer,
    logger: h.deps.logger,
    now: h.deps.now,
    config: workerConfig,
    owner: 'test-worker',
    dispatcher: new OutboxDispatcher(h.db.worker, h.queue, h.deps.logger, h.deps.now),
  });
  const push = new FakePush();

  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'task-key', alg: 'RS256', use: 'sig' };
  const auth = createGoogleTaskAuth({
    audience: WORKER_URL,
    serviceAccountEmail: INVOKER,
    keys: createLocalJWKSet({ keys: [jwk] }),
  });
  const app = createWorkerApp({
    auth,
    worker,
    db: h.db.worker,
    push,
    logger: h.deps.logger,
    now: h.deps.now,
  });

  const oidc = async (email = INVOKER, audience = WORKER_URL) =>
    new SignJWT({ email, email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid: 'task-key' })
      .setIssuer('https://accounts.google.com')
      .setAudience(audience)
      .setExpirationTime('10m')
      .setIssuedAt()
      .sign(privateKey);

  const deliver: WorkerHarness['deliver'] = async (path, body, token) => {
    const t = token === undefined ? await oidc() : token;
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };

  const drain: WorkerHarness['drain'] = async (opts = {}) => {
    const statuses: number[] = [];
    await h.queue.drain(async (task) => {
      const r = await deliver(task.path, task.body);
      statuses.push(r.status);
      return { status: r.status };
    }, opts);
    return statuses;
  };

  /** Make the fake model write a valid script and an all-pass judgement for this profile. */
  const scriptFor = (profile: AthleteProfile) => {
    h.llm.fallback('script', (req) => {
      const m = /Target length: (\d+) seconds/.exec(req.userPayload);
      const ctx = (/Context: (training|night before|pre-event primer)/.exec(req.userPayload)?.[1] ??
        'training') as string;
      const context: SessionContext =
        ctx === 'night before' ? 'night_before' : ctx === 'pre-event primer' ? 'primer' : 'training';
      return buildFictionalTimeline(profile, { context, targetSeconds: Number(m?.[1] ?? 900) });
    });
    h.llm.fallback('judge', () => ({ checks: JUDGE_CHECK_IDS.map((id) => ({ id, pass: true, note: '' })) }));
  };

  return { worker, app, push, tts, deliver, drain, scriptFor };
}
