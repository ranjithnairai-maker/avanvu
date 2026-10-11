import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  FakeTtsProvider,
  TtsError,
  buildFictionalTimeline,
  fictionalProfile,
  type TtsProvider,
  type TtsRequest,
  type TtsResult,
} from '@avanvu/core';
import { MemoryStorage } from '../ports/storage';
import { LOUDNESS_TARGET } from './ffmpeg';
import { RenderFailure, Renderer, RetryableRenderError, chunkKey, chunkPath } from './renderer';
import { parseWav, type Pcm } from './wav';

const require_ = createRequire(import.meta.url);
const ffmpegBin: string = require_('ffmpeg-static');
const haveFfmpeg = !!ffmpegBin && existsSync(ffmpegBin);

const settings = { speed: 0.92, stability: 0.8, settingsVersion: 'v1' };
const voice = { providerVoiceId: 'fake_voice_a', modelId: 'fake-model', settings };
const profile = fictionalProfile({ fearedSelf: false });

const music = (): Pcm => {
  const rate = 22050;
  const s = new Int16Array(rate * 4);
  for (let i = 0; i < s.length; i++)
    s[i] = Math.round(
      Math.sin((2 * Math.PI * 110 * i) / rate) * 6000 + Math.sin((2 * Math.PI * 165 * i) / rate) * 3000,
    );
  return { sampleRate: rate, channels: 1, samples: s };
};

class CountingTts implements TtsProvider {
  readonly name = 'counting';
  calls = 0;
  failures: Error[] = [];
  private readonly inner = new FakeTtsProvider(100);
  listVoices = () => this.inner.listVoices();
  async synthesize(req: TtsRequest): Promise<TtsResult> {
    this.calls++;
    const f = this.failures.shift();
    if (f) throw f;
    return this.inner.synthesize(req);
  }
}

const noSleep = async () => {};

describe.skipIf(!haveFfmpeg)('renderer with ffmpeg (EVALS §5.1)', () => {
  let storage: MemoryStorage;
  let tts: CountingTts;
  const make = (extra = {}) => new Renderer(tts, storage, { ffmpegBin, sleep: noSleep, ...extra });

  beforeAll(() => {
    storage = new MemoryStorage();
    tts = new CountingTts();
  });

  it('renders a primer with a ducked music bed within loudness, peak and duration tolerance', async () => {
    const timeline = buildFictionalTimeline(profile, { context: 'primer', targetSeconds: 180 });
    const out = await make().render({
      jobId: 'job-primer',
      timeline,
      voice,
      music: music(),
      context: 'primer',
    });
    expect(Math.abs(out.encoded.integrated - LOUDNESS_TARGET.i)).toBeLessThanOrEqual(1);
    expect(out.encoded.truePeak).toBeLessThanOrEqual(LOUDNESS_TARGET.tp + 0.1);
    expect(Math.abs(out.durationMs - 180_000) / 180_000).toBeLessThanOrEqual(0.02);
    expect(out.bytes).toBeGreaterThan(100_000);
    expect(out.charactersBilled).toBeGreaterThan(500);
    expect(out.requestIds.length).toBe(out.chunksSynthesized);
    expect(out.pauseFactor).toBeGreaterThanOrEqual(0.6);
    expect(out.pauseFactor).toBeLessThanOrEqual(1.5);
    // A valid AAC .m4a container.
    expect(Buffer.from(out.m4a.slice(4, 8)).toString()).toBe('ftyp');
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 120_000);

  it('renders voice only (no music) and night-before with a slow music fade', async () => {
    const t1 = buildFictionalTimeline(profile, { context: 'training', targetSeconds: 180 });
    const voiceOnly = await make().render({
      jobId: 'job-voice',
      timeline: t1,
      voice,
      music: null,
      context: 'training',
    });
    expect(Math.abs(voiceOnly.encoded.integrated + 16)).toBeLessThanOrEqual(1);
    const t2 = buildFictionalTimeline(profile, { context: 'night_before', targetSeconds: 600 });
    const night = await make().render({
      jobId: 'job-night',
      timeline: t2,
      voice,
      music: music(),
      context: 'night_before',
    });
    expect(Math.abs(night.encoded.integrated + 16)).toBeLessThanOrEqual(1);
    expect(Math.abs(night.durationMs - 600_000) / 600_000).toBeLessThanOrEqual(0.02);
  }, 240_000);

  it('is deterministic: identical input gives identical bytes', async () => {
    const timeline = buildFictionalTimeline(profile, { context: 'primer', targetSeconds: 180 });
    const a = await make().render({ jobId: 'job-det-a', timeline, voice, music: music(), context: 'primer' });
    const b = await make().render({ jobId: 'job-det-b', timeline, voice, music: music(), context: 'primer' });
    expect(a.sha256).toBe(b.sha256);
  }, 240_000);

  it('reuses cached chunks on a retry: no second synthesis, no second charge', async () => {
    const timeline = buildFictionalTimeline(profile, { context: 'primer', targetSeconds: 180 });
    const before = tts.calls;
    const first = await make().render({
      jobId: 'job-retry',
      timeline,
      voice,
      music: null,
      context: 'primer',
    });
    const afterFirst = tts.calls;
    expect(afterFirst - before).toBe(first.chunksSynthesized);
    const second = await make().render({
      jobId: 'job-retry',
      timeline,
      voice,
      music: null,
      context: 'primer',
    });
    expect(tts.calls).toBe(afterFirst);
    expect(second).toMatchObject({
      chunksSynthesized: 0,
      charactersBilled: 0,
      chunksReused: first.chunksSynthesized + first.chunksReused,
    });
    expect(second.sha256).toBe(first.sha256);
    // The cache lives at the deterministic path.
    const speech = timeline.items.find((i) => i.type === 'speech')!;
    const cached = await storage.get('jobs', chunkPath('job-retry', chunkKey(speech.text, voice)));
    expect(parseWav(cached!).sampleRate).toBe(22050);
  }, 240_000);

  it('retries a failing chunk with backoff, then succeeds', async () => {
    const timeline = buildFictionalTimeline(profile, { context: 'primer', targetSeconds: 180 });
    tts.failures = [new TtsError('429', true), new TtsError('503', true)];
    const out = await make({ concurrency: 1 }).render({
      jobId: 'job-flaky',
      timeline,
      voice,
      music: null,
      context: 'primer',
    });
    expect(out.chunksSynthesized).toBeGreaterThan(0);
  }, 240_000);

  it('gives up after the retry budget with a retryable error, and fails fast on a non-retryable one', async () => {
    const timeline = buildFictionalTimeline(profile, { context: 'primer', targetSeconds: 180 });
    tts.failures = Array.from({ length: 10 }, () => new TtsError('503', true));
    await expect(
      make({ concurrency: 1, chunkRetries: 2 }).render({
        jobId: 'job-down',
        timeline,
        voice,
        music: null,
        context: 'primer',
      }),
    ).rejects.toBeInstanceOf(RetryableRenderError);
    tts.failures = [new TtsError('bad request', false)];
    const before = tts.calls;
    await expect(
      make({ concurrency: 1 }).render({ jobId: 'job-bad', timeline, voice, music: null, context: 'primer' }),
    ).rejects.toBeInstanceOf(RetryableRenderError);
    expect(tts.calls - before).toBeLessThanOrEqual(2); // not retried
    tts.failures = [];
  }, 240_000);

  it('fails cleanly with DURATION_UNFITTABLE when speech alone overshoots the target', async () => {
    const timeline = buildFictionalTimeline(profile, { context: 'primer', targetSeconds: 180 });
    const slow = new Renderer(new FakeTtsProvider(25), new MemoryStorage(), { ffmpegBin, sleep: noSleep });
    await expect(
      slow.render({ jobId: 'job-slow', timeline, voice, music: null, context: 'primer' }),
    ).rejects.toMatchObject({ code: 'DURATION_UNFITTABLE' });
    expect(RenderFailure).toBeDefined();
  }, 240_000);
});
