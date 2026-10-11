/**
 * Audio evaluation, CI part (EVALS §5.1): fixed timelines x three voice profiles through the real renderer and
 * ffmpeg with a fake speech provider. Vendor audio (§5.2) and human listening (§5.3) are separate.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { FakeTtsProvider, buildFictionalTimeline, fictionalProfile, type SessionContext } from '@avanvu/core';
import { LOUDNESS_TARGET, MemoryStorage, Renderer, type Pcm } from '@avanvu/backend/evals';
import { gate, metric, pct, skipped, type SuiteResult } from '../types';

const require_ = createRequire(import.meta.url);

function ffmpegPath(): string | null {
  try {
    const p = require_('ffmpeg-static') as string | null;
    return p && existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/** Three voice profiles: calibrated words per minute differ per voice. */
const VOICES = [
  { id: 'fake_voice_a', wpm: 92 },
  { id: 'fake_voice_b', wpm: 100 },
  { id: 'fake_voice_c', wpm: 108 },
];
const SETTINGS = { speed: 0.92, stability: 0.8, settingsVersion: 'v1' };

const TIMELINES: { context: SessionContext; seconds: number }[] = [
  { context: 'primer', seconds: 180 },
  { context: 'training', seconds: 600 },
  { context: 'night_before', seconds: 900 },
];

function music(): Pcm {
  const rate = 22050;
  const s = new Int16Array(rate * 4);
  for (let i = 0; i < s.length; i++)
    s[i] = Math.round(
      Math.sin((2 * Math.PI * 110 * i) / rate) * 6000 + Math.sin((2 * Math.PI * 165 * i) / rate) * 3000,
    );
  return { sampleRate: rate, channels: 1, samples: s };
}

export async function runAudioSuite(profile: 'smoke' | 'full'): Promise<SuiteResult> {
  const bin = ffmpegPath();
  if (!bin)
    return skipped(
      'audio',
      'the ffmpeg binary is not installed (run: node node_modules/ffmpeg-static/install.js)',
    );

  const athlete = fictionalProfile({ fearedSelf: false });
  const timelines = profile === 'smoke' ? TIMELINES.slice(0, 1) : TIMELINES; // smoke stays quick
  const bad = {
    duration: [] as string[],
    loudness: [] as string[],
    peak: [] as string[],
    container: [] as string[],
  };
  const shas = new Map<string, string>();
  let n = 0;
  let worstLufs = 0;
  let worstPeak = -99;

  for (const t of timelines) {
    for (const v of VOICES) {
      const id = `${t.context}_${t.seconds}_${v.id}`;
      const renderer = new Renderer(new FakeTtsProvider(v.wpm), new MemoryStorage(), {
        ffmpegBin: bin,
        sleep: async () => {},
      });
      const out = await renderer.render({
        jobId: `eval-${id}`,
        timeline: buildFictionalTimeline(athlete, {
          context: t.context,
          targetSeconds: t.seconds,
          wpm: v.wpm,
        }),
        voice: { providerVoiceId: v.id, modelId: 'fake-model', settings: SETTINGS },
        music: music(),
        context: t.context,
      });
      n++;
      shas.set(id, out.sha256);
      const target = t.seconds * 1000;
      if (Math.abs(out.durationMs - target) / target > 0.02) bad.duration.push(id);
      const dl = Math.abs(out.encoded.integrated - LOUDNESS_TARGET.i);
      worstLufs = Math.max(worstLufs, dl);
      if (dl > 1) bad.loudness.push(id);
      worstPeak = Math.max(worstPeak, out.encoded.truePeak);
      if (out.encoded.truePeak > LOUDNESS_TARGET.tp) bad.peak.push(id);
      if (Buffer.from(out.m4a.slice(4, 8)).toString() !== 'ftyp') bad.container.push(id);
    }
  }

  // Determinism: the same input renders to the same bytes.
  const first = timelines[0]!;
  const again = new Renderer(new FakeTtsProvider(VOICES[0]!.wpm), new MemoryStorage(), {
    ffmpegBin: bin,
    sleep: async () => {},
  });
  const repeat = await again.render({
    jobId: 'eval-repeat',
    timeline: buildFictionalTimeline(athlete, {
      context: first.context,
      targetSeconds: first.seconds,
      wpm: VOICES[0]!.wpm,
    }),
    voice: { providerVoiceId: VOICES[0]!.id, modelId: 'fake-model', settings: SETTINGS },
    music: music(),
    context: first.context,
  });
  const deterministic = repeat.sha256 === shas.get(`${first.context}_${first.seconds}_${VOICES[0]!.id}`);

  // Forced-unfittable: speech alone overshoots, the render must fail cleanly rather than distort.
  let unfittableClean = false;
  try {
    await new Renderer(new FakeTtsProvider(25), new MemoryStorage(), {
      ffmpegBin: bin,
      sleep: async () => {},
    }).render({
      jobId: 'eval-unfittable',
      timeline: buildFictionalTimeline(athlete, { context: 'primer', targetSeconds: 180 }),
      voice: { providerVoiceId: 'fake_voice_a', modelId: 'fake-model', settings: SETTINGS },
      music: null,
      context: 'primer',
    });
  } catch (e) {
    unfittableClean = (e as { code?: string }).code === 'DURATION_UNFITTABLE';
  }

  return {
    suite: 'audio',
    mode: 'replay',
    status: 'ran',
    costUsd: 0,
    notes: [
      `${n} renders (${timelines.length} timelines x ${VOICES.length} voice profiles) with a fake speech provider and real ffmpeg.`,
      `Worst loudness error ${worstLufs.toFixed(2)} LU, highest true peak ${worstPeak.toFixed(2)} dBTP.`,
      'Vendor audio and human listening are not part of this run (EVALS §5.2, §5.3).',
    ],
    metrics: [
      metric({
        id: 'duration_within_2pct',
        label: 'Renders within ±2 % of target duration',
        value: pct(n - bad.duration.length, n),
        unit: '%',
        n,
        gate: gate('==', 100),
        failing: bad.duration,
      }),
      metric({
        id: 'loudness_within_1lu',
        label: 'Renders within ±1 LU of -16 LUFS',
        value: pct(n - bad.loudness.length, n),
        unit: '%',
        n,
        gate: gate('==', 100),
        failing: bad.loudness,
      }),
      metric({
        id: 'true_peak',
        label: 'Renders at or below -1.5 dBTP',
        value: pct(n - bad.peak.length, n),
        unit: '%',
        n,
        gate: gate('==', 100),
        failing: bad.peak,
      }),
      metric({
        id: 'valid_container',
        label: 'Renders that are a valid .m4a container',
        value: pct(n - bad.container.length, n),
        unit: '%',
        n,
        gate: gate('==', 100),
        failing: bad.container,
      }),
      metric({
        id: 'deterministic',
        label: 'Identical input gives identical bytes',
        value: deterministic ? 100 : 0,
        unit: '%',
        n: 1,
        gate: gate('==', 100),
      }),
      metric({
        id: 'unfittable_fails_cleanly',
        label: 'Unfittable timeline fails with DURATION_UNFITTABLE',
        value: unfittableClean ? 100 : 0,
        unit: '%',
        n: 1,
        gate: gate('==', 100),
      }),
    ],
  };
}
