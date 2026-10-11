/**
 * The render job (SPEC §5.4, §6.2, CONTRACTS §8): lease, generate (or reuse the checkpointed script),
 * synthesize, mix, upload, and the single final transition. Everything is safe to deliver twice.
 *
 *   attempt N: lease -> script checkpoint -> chunks cached -> m4a at a deterministic path -> one final tx
 *
 * Returns an HTTP status for the task: 2xx means "done with this task" (success, duplicate, or a permanent
 * failure that has already reversed the reservation); non-2xx asks Cloud Tasks to retry.
 */
import {
  AvanvuError,
  MAX_RENDER_ATTEMPTS,
  SESSION_STATES,
  canTransition,
  type SessionState,
  type SessionTimeline,
  type TtsProvider,
  type AthleteProfile,
} from '@avanvu/core';
import { withSystemTx, type Db, type Tx } from '../db/tx';
import { NonRetryableJobError, generateTimeline } from '../domain/generate';
import { commitReservation, reverseReservation } from '../domain/ledger';
import { addOutboxEvent, type OutboxDispatcher } from '../domain/outbox';
import { profileById } from '../domain/profile';
import type { Logger } from '../observability/logger';
import type { LlmClient, LlmUsage } from '../ports/llm';
import type { Storage } from '../ports/storage';
import { RenderFailure, RetryableRenderError, Renderer } from '../render/renderer';
import { parseWav, type Pcm } from '../render/wav';
import type { Sealer, UserSealer } from '../security/seal';
import { LeaseLostError, acquireLease, heartbeat, releaseLease } from './lease';

export interface WorkerConfig {
  LLM_MODEL_SCRIPT: string;
  LLM_MODEL_JUDGE: string;
  LLM_EFFORT_SCRIPT: string;
  TTS_MODEL_TRAINING: string;
  TTS_MODEL_NIGHT_BEFORE: string;
  TTS_MODEL_PRIMER: string;
  TTS_SPEED: number;
  TTS_STABILITY: number;
  /** Estimated cost used for the vendor_usage ledger and the daily cost breaker. */
  TTS_COST_PER_1K_CHARS: number;
}

export interface WorkerDeps {
  db: Db;
  sealer: Sealer;
  llm: LlmClient;
  tts: TtsProvider;
  storage: Storage;
  renderer: Renderer;
  logger: Logger;
  now: () => Date;
  config: WorkerConfig;
  /** Unique per process, recorded as the lease owner. */
  owner: string;
  /** Enqueues the push task right after the final transition; the sweeper is the fallback. */
  dispatcher?: OutboxDispatcher;
}

const scriptCtx = (sessionId: string) => ({
  table: 'session_scripts',
  column: 'timeline_enc',
  rowId: sessionId,
  schemaVersion: 'session_timeline_v1',
});

class CanceledError extends Error {}

export interface JobOutcome {
  status: number;
  result: 'ready' | 'duplicate' | 'failed' | 'retry' | 'canceled' | 'lease_held';
}

interface SessionRow {
  id: string;
  user_id: string;
  context: 'training' | 'night_before' | 'primer';
  length_min: number;
  state: SessionState;
  engine: string;
  profile_version_id: string;
  voice_id: string;
  track_id: string | null;
  render_version: number;
  program_item_id: string | null;
  created_at: Date;
}

export class RenderWorker {
  constructor(private readonly d: WorkerDeps) {}

  async process(jobId: string): Promise<JobOutcome> {
    const { d } = this;
    const job = await acquireLease(d.db, jobId, d.owner, d.now());
    if (!job) return { status: 200, result: 'lease_held' }; // held by another attempt, or finished
    const log = d.logger.child({ job_id: job.id, attempt: job.attempt });

    try {
      if (job.attempt > MAX_RENDER_ATTEMPTS) {
        await this.fail(job, 'ATTEMPTS_EXHAUSTED');
        return { status: 200, result: 'failed' };
      }
      const session = await this.loadSession(job.session_id);
      if (!session) {
        await this.fail(job, 'SESSION_MISSING');
        return { status: 200, result: 'failed' };
      }
      if (session.state === 'canceled') {
        await this.finishJob(job.id, 'canceled', null);
        return { status: 200, result: 'canceled' };
      }
      if (session.state === 'ready') {
        await this.finishJob(job.id, 'succeeded', null);
        return { status: 200, result: 'duplicate' };
      }

      const sealer = await d.sealer.forUser(session.user_id); // load the key before any transaction
      const profile = await withSystemTx(d.db, 'worker', (trx) =>
        profileById(trx, sealer, session.user_id, session.profile_version_id),
      );
      if (!profile) {
        await this.fail(job, 'PROFILE_VERSION_MISSING');
        return { status: 200, result: 'failed' };
      }

      const voice = await withSystemTx(d.db, 'worker', (trx) =>
        trx
          .selectFrom('app.voice_catalog')
          .selectAll()
          .where('id', '=', session.voice_id)
          .executeTakeFirstOrThrow(),
      );
      const wpm = Number(voice.wpm);

      // 1) Script: reuse the checkpoint when present; otherwise generate, validate, judge, then store.
      const timeline = await this.ensureScript(job, session, profile.profile, sealer, wpm);

      // 2) Synthesize and mix. Chunks are cached, so a retry never pays twice.
      await this.setState(job, session.id, 'synthesizing');
      const music = await this.loadMusic(session.track_id);
      const modelId =
        session.context === 'training'
          ? d.config.TTS_MODEL_TRAINING
          : session.context === 'night_before'
            ? d.config.TTS_MODEL_NIGHT_BEFORE
            : d.config.TTS_MODEL_PRIMER;
      const renderer = d.renderer;
      const beat = () => heartbeat(d.db, job.id, d.owner, d.now(), 'synthesizing');
      const out = await renderer.render(
        {
          jobId: job.id,
          timeline,
          voice: {
            providerVoiceId: voice.provider_voice_id,
            modelId,
            settings: {
              speed: d.config.TTS_SPEED,
              stability: d.config.TTS_STABILITY,
              settingsVersion: voice.settings_version,
            },
          },
          music,
          context: session.context,
        },
        { onProgress: beat, onStage: (s) => this.setState(job, session.id, s) },
      );

      // 3) Upload to the deterministic path.
      await this.setState(job, session.id, 'uploading');
      const audioPath = `audio/${session.user_id}/${session.id}/${session.render_version}.m4a`;
      await d.storage.put('audio', audioPath, out.m4a, 'audio/mp4');
      await heartbeat(d.db, job.id, d.owner, d.now(), 'uploading');

      // 4) The one final transition: ready + ledger commit + program item + vendor usage + push outbox.
      const { ready: readyNow, outboxId } = await this.markReady(
        job,
        session,
        audioPath,
        out,
        profile.profile,
      );
      if (outboxId) await d.dispatcher?.dispatchAfterCommit([outboxId]);
      await d.storage
        .deletePrefix('jobs', `jobs/${job.id}/`)
        .catch(() => log.warn('chunk_cleanup_deferred', {}));
      log.info('render_ready', {
        seconds: Math.round((d.now().getTime() - new Date(session.created_at).getTime()) / 1000),
        duplicate: !readyNow,
      });
      return { status: 200, result: readyNow ? 'ready' : 'duplicate' };
    } catch (e) {
      return this.handleError(job, e, log);
    }
  }

  private async handleError(
    job: { id: string; session_id: string; attempt: number },
    e: unknown,
    log: Logger,
  ): Promise<JobOutcome> {
    const { d } = this;
    if (e instanceof LeaseLostError) {
      log.warn('lease_lost', {});
      return { status: 503, result: 'retry' };
    }
    if (e instanceof CanceledError) {
      await this.finishJob(job.id, 'canceled', null);
      return { status: 200, result: 'canceled' };
    }
    const nonRetryable =
      e instanceof NonRetryableJobError
        ? e.code
        : e instanceof RenderFailure
          ? e.code
          : e instanceof AvanvuError && e.code === 'ENTITLEMENT_REQUIRED'
            ? 'ENTITLEMENT_REVOKED'
            : null;
    if (nonRetryable) {
      log.warn('render_failed_permanently', { error_code: nonRetryable });
      await this.fail(job, nonRetryable);
      return { status: 200, result: 'failed' };
    }
    // Retryable: vendor 429/5xx, timeouts, a bad chunk. Cloud Tasks retries; exhausted jobs fail for good.
    log.warn('render_retryable_error', {
      error_code: e instanceof RetryableRenderError ? 'CHUNK' : 'VENDOR',
    });
    if (job.attempt >= MAX_RENDER_ATTEMPTS) {
      await this.fail(job, 'ATTEMPTS_EXHAUSTED');
      return { status: 200, result: 'failed' };
    }
    await releaseLease(d.db, job.id, d.owner, 'RETRYABLE');
    return { status: 503, result: 'retry' };
  }

  private async loadSession(sessionId: string): Promise<SessionRow | null> {
    const row = await withSystemTx(this.d.db, 'worker', (trx) =>
      trx
        .selectFrom('app.sessions')
        .select([
          'id',
          'user_id',
          'context',
          'length_min',
          'state',
          'engine',
          'profile_version_id',
          'voice_id',
          'track_id',
          'render_version',
          'program_item_id',
          'created_at',
        ])
        .where('id', '=', sessionId)
        .executeTakeFirst(),
    );
    return (row as SessionRow | undefined) ?? null;
  }

  /** CAS transition to `to` from any state that may legally precede it; a canceled session aborts. */
  private async setState(
    job: { id: string; attempt: number },
    sessionId: string,
    to: SessionState,
  ): Promise<void> {
    const from = SESSION_STATES.filter((s) => canTransition(s, to));
    await withSystemTx(this.d.db, 'worker', async (trx) => {
      const r = await trx
        .updateTable('app.sessions')
        .set({ state: to, attempt: job.attempt })
        .where('id', '=', sessionId)
        .where('state', 'in', from)
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) !== 1) {
        const cur = await trx
          .selectFrom('app.sessions')
          .select('state')
          .where('id', '=', sessionId)
          .executeTakeFirst();
        if (cur?.state === 'canceled') throw new CanceledError();
        if (cur?.state === to) return;
        throw new Error('unexpected session state');
      }
    });
    await heartbeat(this.d.db, job.id, this.d.owner, this.d.now(), to);
  }

  private async ensureScript(
    job: { id: string; user_id: string; session_id: string; attempt: number },
    session: SessionRow,
    profile: AthleteProfile,
    sealer: UserSealer,
    wpm: number,
  ): Promise<SessionTimeline> {
    const { d } = this;
    const existing = await withSystemTx(d.db, 'worker', (trx) =>
      trx
        .selectFrom('app.session_scripts')
        .select('timeline_enc')
        .where('session_id', '=', session.id)
        .executeTakeFirst(),
    );
    if (existing) return sealer.open<SessionTimeline>(scriptCtx(session.id), existing.timeline_enc);

    await this.setState(job, session.id, 'generating_script');
    const { checkins, coreScene } = await withSystemTx(d.db, 'worker', async (trx) => ({
      checkins: await trx
        .selectFrom('app.checkins')
        .select(['vividness', 'readiness'])
        .where('user_id', '=', session.user_id)
        .orderBy('created_at', 'desc')
        .limit(3)
        .execute(),
      coreScene: await this.loadCoreScene(trx, session),
    }));
    const gen = await generateTimeline(
      d.llm,
      {
        script: d.config.LLM_MODEL_SCRIPT,
        judge: d.config.LLM_MODEL_JUDGE,
        effort: d.config.LLM_EFFORT_SCRIPT,
      },
      {
        profile,
        context: session.context,
        lengthMin: session.length_min,
        wpm,
        coreScene,
        recentCheckins: checkins,
      },
    );
    await this.setState(job, session.id, 'validating');
    const sealed = await sealer.seal(scriptCtx(session.id), gen.timeline);
    await withSystemTx(d.db, 'worker', async (trx) => {
      // The checkpoint: stored before synthesis so a retry skips generation and validation entirely.
      await trx
        .insertInto('app.session_scripts')
        .values({
          session_id: session.id,
          user_id: session.user_id,
          timeline_enc: sealed,
          versions: JSON.stringify(gen.versions) as never,
        })
        .onConflict((oc) => oc.column('session_id').doNothing())
        .execute();
      for (const u of gen.usages) await this.recordUsage(trx, session.user_id, u.kind, u.usage);
    });
    return gen.timeline;
  }

  private async loadCoreScene(trx: Tx, session: SessionRow): Promise<unknown | null> {
    if (!session.program_item_id) return null;
    const row = await trx
      .selectFrom('app.program_items as me')
      .innerJoin('app.program_items as sibling', 'sibling.program_id', 'me.program_id')
      .select('sibling.core_scene')
      .where('me.id', '=', session.program_item_id)
      .where('sibling.core_scene', 'is not', null)
      .limit(1)
      .executeTakeFirst();
    return row?.core_scene ?? null;
  }

  private async recordUsage(trx: Tx, userId: string, kind: string, u: LlmUsage): Promise<void> {
    await trx
      .insertInto('app.vendor_usage')
      .values({
        user_id: userId,
        vendor: 'anthropic',
        kind,
        model: u.model,
        tokens_in: u.tokensIn,
        tokens_out: u.tokensOut,
        characters: null,
        compute_seconds: null,
        est_cost_usd: u.estCostUsd,
      })
      .execute();
  }

  private async loadMusic(trackId: string | null): Promise<Pcm | null> {
    if (!trackId) return null;
    const track = await withSystemTx(this.d.db, 'worker', (trx) =>
      trx.selectFrom('app.music_catalog').select('storage_path').where('id', '=', trackId).executeTakeFirst(),
    );
    if (!track) return null;
    const bytes = await this.d.storage.get('music', track.storage_path);
    return bytes ? parseWav(bytes) : null; // a missing track degrades to voice only rather than failing the session
  }

  /** The final transition. Returns false when the session was already ready (duplicate delivery). */
  private async markReady(
    job: { id: string; user_id: string; session_id: string },
    session: SessionRow,
    audioPath: string,
    out: { durationMs: number; sha256: string; bytes: number; charactersBilled: number },
    profile: AthleteProfile,
  ): Promise<{ ready: boolean; outboxId: string | null }> {
    const { d } = this;
    const now = d.now();
    return withSystemTx(d.db, 'worker', async (trx) => {
      const r = await trx
        .updateTable('app.sessions')
        .set({
          state: 'ready',
          audio_path: audioPath,
          duration_ms: out.durationMs,
          sha256: out.sha256,
          bytes: out.bytes,
          ready_at: now,
        })
        .where('id', '=', session.id)
        .where('state', 'in', ['uploading', 'mixing', 'synthesizing'])
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) !== 1) return { ready: false, outboxId: null };
      await commitReservation(trx, session.user_id, session.id);
      await trx
        .updateTable('app.render_jobs')
        .set({ state: 'succeeded', lease_owner: null, lease_expires_at: null, stage: 'ready' })
        .where('id', '=', job.id)
        .execute();
      if (session.program_item_id) {
        await trx
          .updateTable('app.program_items')
          .set({ state: 'ready', session_id: session.id })
          .where('id', '=', session.program_item_id)
          .execute();
        await this.maybeStoreCoreScene(trx, session, profile);
      }
      if (out.charactersBilled > 0) {
        await trx
          .insertInto('app.vendor_usage')
          .values({
            user_id: session.user_id,
            vendor: d.tts.name,
            kind: 'tts',
            model: null,
            tokens_in: null,
            tokens_out: null,
            characters: out.charactersBilled,
            compute_seconds: null,
            est_cost_usd: (out.charactersBilled / 1000) * d.config.TTS_COST_PER_1K_CHARS,
          })
          .execute();
      }
      // The ready push is sent only on this first transition (unique key per session).
      const delivery = await trx
        .insertInto('app.notification_deliveries')
        .values({ user_id: session.user_id, kind: 'session_ready', subject_id: session.id } as never)
        .onConflict((oc) => oc.columns(['user_id', 'kind', 'subject_id']).doNothing())
        .returning('id')
        .executeTakeFirst();
      const outboxId = delivery
        ? await addOutboxEvent(trx, { userId: session.user_id, kind: 'push', subjectId: delivery.id })
        : null;
      return { ready: true, outboxId };
    });
  }

  /** The first training session establishes the core scene (item ids only, no text). */
  private async maybeStoreCoreScene(trx: Tx, session: SessionRow, profile: AthleteProfile): Promise<void> {
    if (session.context !== 'training' || !session.program_item_id) return;
    const existing = await this.loadCoreScene(trx, session);
    if (existing) return;
    const coreScene = {
      key_moment_ids: profile.performance.key_moments.map((m) => m.item_id),
      if_then_ids: profile.responses.if_then.map((i) => i.item_id),
      has_obstacle: !!profile.obstacles.hardest_moment,
      visual_ids: profile.scene.visual.slice(0, 3).map((v) => v.item_id),
    };
    await trx
      .updateTable('app.program_items')
      .set({ core_scene: JSON.stringify(coreScene) as never })
      .where('id', '=', session.program_item_id)
      .execute();
  }

  /** Permanent failure: session failed, reservation reversed, job closed, chunks removed. */
  private async fail(job: { id: string; session_id: string }, code: string): Promise<void> {
    const { d } = this;
    await withSystemTx(d.db, 'worker', async (trx) => {
      const s = await trx
        .selectFrom('app.sessions')
        .select(['id', 'user_id', 'state', 'program_item_id'])
        .where('id', '=', job.session_id)
        .executeTakeFirst();
      if (s && s.state !== 'ready' && s.state !== 'canceled') {
        await trx
          .updateTable('app.sessions')
          .set({ state: 'failed', failure_code: code })
          .where('id', '=', s.id)
          .execute();
        await reverseReservation(trx, s.user_id, s.id);
        if (s.program_item_id) {
          await trx
            .updateTable('app.program_items')
            .set({ state: 'planned', session_id: null })
            .where('id', '=', s.program_item_id)
            .execute();
        }
      }
      await trx
        .updateTable('app.render_jobs')
        .set({ state: 'failed', last_error_code: code, lease_owner: null, lease_expires_at: null })
        .where('id', '=', job.id)
        .execute();
    });
    await d.storage.deletePrefix('jobs', `jobs/${job.id}/`).catch(() => undefined);
  }

  private async finishJob(
    jobId: string,
    state: 'succeeded' | 'canceled',
    code: string | null,
  ): Promise<void> {
    await withSystemTx(this.d.db, 'worker', (trx) =>
      trx
        .updateTable('app.render_jobs')
        .set({ state, last_error_code: code, lease_owner: null, lease_expires_at: null })
        .where('id', '=', jobId)
        .execute(),
    );
    await this.d.storage.deletePrefix('jobs', `jobs/${jobId}/`).catch(() => undefined);
  }
}
