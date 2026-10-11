/**
 * Renderer (SPEC §6.2, CONTRACTS §6.2, §8.2): chunked synthesis with a retry-safe cache, chunk inspection,
 * duration fitting, music bed, loudness normalisation, encode and verification of the encoded file.
 *
 * Retries never pay twice: every synthesized chunk is stored at `jobs/{job_id}/chunks/{sha256(...)}.wav`
 * before use, so a retried job reuses them. Pauses stretch to fit the target; real-time `rehearse` silences
 * never change. A word-budget bug surfaces as DURATION_UNFITTABLE and is never "fixed" by re-synthesis.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fitDurations,
  type SessionContext,
  type SessionTimeline,
  type TtsProvider,
  type TtsSettings,
  TtsError,
} from '@avanvu/core';
import type { Storage } from '../ports/storage';
import { LOUDNESS_TARGET, LOUDNESS_TOLERANCE_LU, mixAndEncode, type Loudness } from './ffmpeg';
import {
  concat,
  durationMs,
  inspectChunk,
  loopWithCrossfade,
  parseWav,
  silence,
  writeWav,
  type Pcm,
} from './wav';

export class RenderFailure extends Error {
  constructor(
    readonly code: 'DURATION_UNFITTABLE' | 'AUDIO_OUT_OF_TOLERANCE',
    message: string,
  ) {
    super(message);
    this.name = 'RenderFailure';
  }
}

/** A failure that a retry may fix (vendor 429 or 5xx, timeouts, a bad chunk). */
export class RetryableRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableRenderError';
  }
}

export interface RenderVoice {
  providerVoiceId: string;
  modelId: string;
  settings: TtsSettings;
}

export interface RenderInput {
  jobId: string;
  timeline: SessionTimeline;
  voice: RenderVoice;
  /** Decoded music track, or null for voice only. */
  music: Pcm | null;
  context: SessionContext;
}

export interface RenderOutput {
  m4a: Uint8Array;
  durationMs: number;
  loudness: Loudness;
  encoded: Loudness & { durationMs: number };
  sha256: string;
  bytes: number;
  charactersBilled: number;
  requestIds: string[];
  chunksReused: number;
  chunksSynthesized: number;
  pauseFactor: number;
}

export interface RendererOptions {
  ffmpegBin: string;
  concurrency?: number;
  chunkRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Hooks the worker uses for heartbeats and stage changes. */
export interface RenderHooks {
  /** Called after each synthesized chunk is cached. */
  onProgress?: () => Promise<void> | void;
  onStage?: (stage: 'mixing') => Promise<void> | void;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export const chunkPath = (jobId: string, key: string) => `jobs/${jobId}/chunks/${key}.wav`;

export function chunkKey(text: string, voice: RenderVoice): string {
  const s = voice.settings;
  return sha([text, voice.providerVoiceId, voice.modelId, s.settingsVersion, s.speed, s.stability].join('|'));
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return out;
}

export class Renderer {
  constructor(
    private readonly tts: TtsProvider,
    private readonly storage: Storage,
    private readonly opts: RendererOptions,
  ) {}

  async render(input: RenderInput, hooks: RenderHooks = {}): Promise<RenderOutput> {
    const { timeline, voice } = input;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const retries = this.opts.chunkRetries ?? 3;
    const items = timeline.items;
    const speech = items.map((it, i) => ({ it, i })).filter((x) => x.it.type === 'speech');
    let chars = 0;
    let reused = 0;
    let synthesized = 0;
    const requestIds: string[] = [];

    const chunks = await mapLimit(speech, this.opts.concurrency ?? 4, async ({ it, i }) => {
      const key = chunkKey(it.text, voice);
      const path = chunkPath(input.jobId, key);
      const cached = await this.storage.get('jobs', path);
      if (cached) {
        reused++;
        return parseWav(cached);
      }
      const prev = speech.find((s) => s.i < i && items.slice(s.i + 1, i).every((x) => x.type !== 'speech'))
        ?.it.text;
      let lastError: unknown;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const r = await this.tts.synthesize({
            text: it.text,
            voiceId: voice.providerVoiceId,
            modelId: voice.modelId,
            settings: voice.settings,
            ...(prev ? { previousText: prev } : {}),
            nextText: speech.find((s) => s.i > i)?.it.text ?? '',
          });
          const inspection = inspectChunk(parseWav(r.audio));
          if (!inspection.ok)
            throw new RetryableRenderError(`chunk rejected: ${inspection.issues.join(',')}`);
          chars += r.charactersBilled;
          requestIds.push(r.providerRequestId);
          synthesized++;
          await this.storage.put('jobs', path, writeWav(inspection.pcm), 'audio/wav');
          await hooks.onProgress?.();
          return inspection.pcm;
        } catch (e) {
          lastError = e;
          const retryable = !(e instanceof TtsError) || e.retryable;
          if (!retryable) break;
          if (attempt < retries) await sleep(500 * 2 ** attempt);
        }
      }
      throw new RetryableRenderError(
        lastError instanceof Error ? `synthesis failed: ${lastError.message}` : 'synthesis failed',
      );
    });

    const rate = chunks[0]?.sampleRate;
    if (!rate || chunks.some((c) => c.sampleRate !== rate || c.channels !== 1)) {
      throw new RetryableRenderError('chunks disagree on sample rate or channels');
    }

    // Duration fitting: stretch pauses only (CONTRACTS §6.2).
    const fit = fitDurations(items, chunks.map(durationMs), timeline.target_seconds);
    if (!fit.ok)
      throw new RenderFailure('DURATION_UNFITTABLE', 'The session cannot be fitted to its target length.');

    const parts: Int16Array[] = [];
    let speechIndex = 0;
    for (const it of fit.items) {
      if (it.type === 'speech') parts.push((chunks[speechIndex++] as Pcm).samples);
      else parts.push(silence(it.duration_ms, rate));
    }
    const voicePcm: Pcm = { sampleRate: rate, channels: 1, samples: concat(parts) };
    const totalMs = durationMs(voicePcm);

    const dir = await mkdtemp(join(tmpdir(), 'avanvu-render-'));
    try {
      const voicePath = join(dir, 'voice.wav');
      const outPath = join(dir, 'session.m4a');
      await writeFile(voicePath, writeWav(voicePcm));
      let musicPath: string | null = null;
      if (input.music) {
        const frames = Math.ceil((totalMs / 1000) * input.music.sampleRate);
        const looped = loopWithCrossfade(input.music, frames, input.music.sampleRate * 2);
        musicPath = join(dir, 'music.wav');
        await writeFile(musicPath, writeWav({ ...input.music, samples: looped }));
      }
      await hooks.onStage?.('mixing');
      const mixed = await mixAndEncode(this.opts.ffmpegBin, {
        voicePath,
        musicPath,
        outPath,
        totalSeconds: totalMs / 1000,
        context: input.context,
      });

      // Verify the ENCODED file (SPEC §6.2 step 8): out of tolerance is a renderer bug, not a vendor problem.
      const e = mixed.encoded;
      const loudOk = Math.abs(e.integrated - LOUDNESS_TARGET.i) <= LOUDNESS_TOLERANCE_LU;
      const peakOk = e.truePeak <= LOUDNESS_TARGET.tp + 0.1;
      const durOk = Math.abs(e.durationMs - totalMs) <= Math.max(100, totalMs * 0.005);
      if (!loudOk || !peakOk || !durOk) {
        throw new RenderFailure(
          'AUDIO_OUT_OF_TOLERANCE',
          'The rendered audio is outside loudness or duration tolerance.',
        );
      }
      const m4a = new Uint8Array(await readFile(outPath));
      return {
        m4a,
        durationMs: e.durationMs,
        loudness: mixed.loudness,
        encoded: e,
        sha256: createHash('sha256').update(m4a).digest('hex'),
        bytes: m4a.byteLength,
        charactersBilled: chars,
        requestIds,
        chunksReused: reused,
        chunksSynthesized: synthesized,
        pauseFactor: fit.factor,
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
