/**
 * ffmpeg wrapper (SPEC §6.2 steps 6 to 8): music bed ducked under the voice, two-pass loudness
 * normalisation to -16 LUFS (true peak <= -1.5 dBTP), AAC-LC .m4a at 96 kbps stereo 44.1 kHz, and a
 * measurement of the ENCODED file. The worker image pins its ffmpeg build; tests use ffmpeg-static.
 */
import { spawn } from 'node:child_process';

export interface Loudness {
  integrated: number;
  truePeak: number;
  lra: number;
  threshold: number;
  offset: number;
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'FfmpegError';
  }
}

export function runFfmpeg(bin: string, args: readonly string[], timeoutMs = 10 * 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ['-hide_banner', '-nostdin', '-y', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    p.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new FfmpegError('ffmpeg timed out', stderr.slice(-2000)));
    }, timeoutMs);
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(new FfmpegError(`ffmpeg failed to start: ${e.message}`, ''));
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stderr);
      else reject(new FfmpegError(`ffmpeg exited with ${code}`, stderr.slice(-2000)));
    });
  });
}

const TARGET = { i: -16, tp: -1.5, lra: 11 };

function parseLoudnormJson(stderr: string): Record<string, string> {
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start < 0 || end < start) throw new FfmpegError('no loudness report', stderr.slice(-500));
  return JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>;
}

export function parseDurationMs(stderr: string): number {
  const m = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(stderr);
  if (!m) throw new FfmpegError('no duration in ffmpeg output', stderr.slice(-300));
  return Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000);
}

/** Measures integrated loudness and true peak of a file (works on the encoded .m4a). */
export async function measureFile(bin: string, path: string): Promise<Loudness & { durationMs: number }> {
  const stderr = await runFfmpeg(bin, [
    '-i',
    path,
    '-af',
    `loudnorm=I=${TARGET.i}:TP=${TARGET.tp}:LRA=${TARGET.lra}:print_format=json`,
    '-f',
    'null',
    '-',
  ]);
  const j = parseLoudnormJson(stderr);
  return {
    integrated: Number(j.input_i),
    truePeak: Number(j.input_tp),
    lra: Number(j.input_lra),
    threshold: Number(j.input_thresh),
    offset: Number(j.target_offset),
    durationMs: parseDurationMs(stderr),
  };
}

export interface MixOptions {
  voicePath: string;
  /** Looped to the full length by the caller. Null for voice only. */
  musicPath: string | null;
  outPath: string;
  totalSeconds: number;
  context: 'training' | 'night_before' | 'primer';
}

/** The music bed sits about 20 dB under the voice and ducks further while the voice speaks. */
export function filterGraph(o: Pick<MixOptions, 'musicPath' | 'totalSeconds' | 'context'>): {
  graph: string;
  label: string;
} {
  const fmt = 'aformat=sample_rates=44100:channel_layouts=stereo';
  if (!o.musicPath) return { graph: `[0:a]${fmt}[mix]`, label: 'mix' };
  const fadeOut = o.context === 'night_before' ? Math.min(180, Math.max(6, o.totalSeconds / 4)) : 6;
  const st = Math.max(0, o.totalSeconds - fadeOut);
  return {
    graph: [
      `[0:a]${fmt},asplit=2[v][sc]`,
      `[1:a]${fmt},volume=-20dB,afade=t=in:st=0:d=3,afade=t=out:st=${st.toFixed(2)}:d=${fadeOut.toFixed(2)}[m]`,
      '[m][sc]sidechaincompress=threshold=0.02:ratio=6:attack=15:release=600:makeup=1[duck]',
      '[v][duck]amix=inputs=2:normalize=0:duration=longest[mix]',
    ].join(';'),
    label: 'mix',
  };
}

export interface MixResult {
  loudness: Loudness;
  /** Measured on the encoded file. */
  encoded: Loudness & { durationMs: number };
}

export async function mixAndEncode(bin: string, o: MixOptions): Promise<MixResult> {
  const { graph, label } = filterGraph(o);
  const inputs = ['-i', o.voicePath, ...(o.musicPath ? ['-i', o.musicPath] : [])];
  const ln = (extra = '') => `loudnorm=I=${TARGET.i}:TP=${TARGET.tp}:LRA=${TARGET.lra}${extra}`;

  // Pass 1: measure.
  const p1 = await runFfmpeg(bin, [
    ...inputs,
    '-filter_complex',
    `${graph};[${label}]${ln(':print_format=json')}[out]`,
    '-map',
    '[out]',
    '-f',
    'null',
    '-',
  ]);
  const m = parseLoudnormJson(p1);
  const loudness: Loudness = {
    integrated: Number(m.input_i),
    truePeak: Number(m.input_tp),
    lra: Number(m.input_lra),
    threshold: Number(m.input_thresh),
    offset: Number(m.target_offset),
  };

  // Pass 2: apply linear gain from the measurement, then encode.
  const apply = ln(
    `:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true:print_format=summary`,
  );
  await runFfmpeg(bin, [
    ...inputs,
    '-filter_complex',
    `${graph};[${label}]${apply}[out]`,
    '-map',
    '[out]',
    '-c:a',
    'aac',
    '-profile:a',
    'aac_low',
    '-b:a',
    '96k',
    '-ar',
    '44100',
    '-ac',
    '2',
    '-movflags',
    '+faststart',
    // Reproducible output: identical input gives identical bytes (and so an identical SHA-256).
    '-fflags',
    '+bitexact',
    '-flags:a',
    '+bitexact',
    '-map_metadata',
    '-1',
    o.outPath,
  ]);
  return { loudness, encoded: await measureFile(bin, o.outPath) };
}

export const LOUDNESS_TARGET = TARGET;
export const LOUDNESS_TOLERANCE_LU = 1;
