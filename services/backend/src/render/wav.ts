/** Minimal PCM WAV helpers for the renderer: 16-bit little-endian, mono or stereo. */
export interface Pcm {
  sampleRate: number;
  channels: number;
  samples: Int16Array; // interleaved
}

export class WavError extends Error {}

export function parseWav(bytes: Uint8Array): Pcm {
  if (bytes.byteLength < 44) throw new WavError('wav too short');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) =>
    String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new WavError('not a wav file');
  let o = 12;
  let fmt: { channels: number; rate: number; bits: number } | null = null;
  while (o + 8 <= bytes.byteLength) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    if (id === 'fmt ') {
      if (v.getUint16(o + 8, true) !== 1) throw new WavError('only PCM wav is supported');
      fmt = {
        channels: v.getUint16(o + 10, true),
        rate: v.getUint32(o + 12, true),
        bits: v.getUint16(o + 22, true),
      };
    } else if (id === 'data') {
      if (!fmt) throw new WavError('fmt chunk missing');
      if (fmt.bits !== 16) throw new WavError('only 16-bit wav is supported');
      const end = Math.min(bytes.byteLength, o + 8 + size);
      const slice = bytes.slice(o + 8, end - ((end - o - 8) % 2));
      return {
        sampleRate: fmt.rate,
        channels: fmt.channels,
        samples: new Int16Array(slice.buffer, slice.byteOffset, slice.byteLength / 2),
      };
    }
    o += 8 + size + (size % 2);
  }
  throw new WavError('data chunk missing');
}

export function writeWav(pcm: Pcm): Uint8Array {
  const dataBytes = pcm.samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, pcm.channels, true);
  v.setUint32(24, pcm.sampleRate, true);
  v.setUint32(28, pcm.sampleRate * pcm.channels * 2, true);
  v.setUint16(32, pcm.channels * 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, dataBytes, true);
  new Int16Array(buf, 44).set(pcm.samples);
  return new Uint8Array(buf);
}

export const durationMs = (p: Pcm): number =>
  Math.round((p.samples.length / p.channels / p.sampleRate) * 1000);

export function silence(ms: number, sampleRate: number, channels = 1): Int16Array {
  return new Int16Array(Math.round((ms / 1000) * sampleRate) * channels);
}

export function concat(parts: readonly Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Equal-power loop with crossfades, trimmed to exactly `totalFrames` (CONTRACTS §6.2 music bed). */
export function loopWithCrossfade(music: Pcm, totalFrames: number, fadeFrames: number): Int16Array {
  const ch = music.channels;
  const frames = music.samples.length / ch;
  const fade = Math.min(fadeFrames, Math.floor(frames / 2));
  const out = new Int16Array(totalFrames * ch);
  let written = 0;
  let first = true;
  while (written < totalFrames) {
    // Each pass contributes `frames - fade` new frames after the first, overlapping the previous tail.
    const start = first ? 0 : written - fade;
    for (let f = 0; f < frames && start + f < totalFrames; f++) {
      const pos = start + f;
      for (let c = 0; c < ch; c++) {
        const s = music.samples[f * ch + c] as number;
        let gain = 1;
        if (!first && f < fade) gain = Math.sin((f / fade) * (Math.PI / 2));
        if (f >= frames - fade) gain *= Math.cos(((f - (frames - fade)) / fade) * (Math.PI / 2));
        const prev = out[pos * ch + c] as number;
        out[pos * ch + c] = Math.max(
          -32768,
          Math.min(32767, first || f >= fade ? Math.round(s * gain) : Math.round(prev + s * gain)),
        );
      }
    }
    written = Math.min(totalFrames, start + frames);
    first = false;
    if (frames - fade <= 0) break;
  }
  return out;
}

export interface Inspection {
  ok: boolean;
  issues: string[];
  pcm: Pcm;
}

const SILENT = 100; // about -50 dBFS
const CLIP = 32700;

/**
 * Chunk inspection (SPEC §6.2 step 4): reject empty audio and clipping; trim leading or trailing silence
 * over 1.5 s down to 150 ms.
 */
export function inspectChunk(pcm: Pcm): Inspection {
  const issues: string[] = [];
  const frames = pcm.samples.length / pcm.channels;
  if (frames / pcm.sampleRate < 0.05) return { ok: false, issues: ['empty'], pcm };
  let clipped = 0;
  let peak = 0;
  for (const s of pcm.samples) {
    const a = Math.abs(s);
    if (a >= CLIP) clipped++;
    if (a > peak) peak = a;
  }
  if (peak < SILENT) return { ok: false, issues: ['silent'], pcm };
  if (clipped / pcm.samples.length > 0.001) issues.push('clipping');

  const frameAbs = (f: number) => {
    let m = 0;
    for (let c = 0; c < pcm.channels; c++)
      m = Math.max(m, Math.abs(pcm.samples[f * pcm.channels + c] as number));
    return m;
  };
  let lead = 0;
  while (lead < frames && frameAbs(lead) < SILENT) lead++;
  let trail = 0;
  while (trail < frames - lead && frameAbs(frames - 1 - trail) < SILENT) trail++;
  const keep = Math.round(0.15 * pcm.sampleRate);
  const limit = Math.round(1.5 * pcm.sampleRate);
  const cutLead = lead > limit ? lead - keep : 0;
  const cutTrail = trail > limit ? trail - keep : 0;
  const trimmed =
    cutLead || cutTrail
      ? pcm.samples.slice(cutLead * pcm.channels, (frames - cutTrail) * pcm.channels)
      : pcm.samples;
  return { ok: !issues.includes('clipping'), issues, pcm: { ...pcm, samples: trimmed } };
}
