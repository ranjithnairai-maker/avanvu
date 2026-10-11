import { describe, expect, it } from 'vitest';
import { durationMs, inspectChunk, loopWithCrossfade, parseWav, silence, writeWav, type Pcm } from './wav';

const tone = (ms: number, rate = 22050, amp = 8000): Pcm => {
  const n = Math.round((ms / 1000) * rate);
  const s = new Int16Array(n);
  for (let i = 0; i < n; i++) s[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * amp);
  return { sampleRate: rate, channels: 1, samples: s };
};

describe('wav', () => {
  it('round-trips PCM and reports duration', () => {
    const p = tone(500);
    const back = parseWav(writeWav(p));
    expect(back.sampleRate).toBe(22050);
    expect(back.samples).toEqual(p.samples);
    expect(durationMs(back)).toBe(500);
  });

  it('rejects non-wav and compressed input', () => {
    expect(() => parseWav(new Uint8Array(10))).toThrow();
    expect(() => parseWav(new Uint8Array(64))).toThrow(/not a wav/);
  });
});

describe('chunk inspection', () => {
  it('rejects empty and silent audio', () => {
    expect(inspectChunk({ sampleRate: 22050, channels: 1, samples: new Int16Array(100) }).issues).toEqual([
      'empty',
    ]);
    expect(inspectChunk({ sampleRate: 22050, channels: 1, samples: new Int16Array(44100) }).issues).toEqual([
      'silent',
    ]);
  });

  it('flags clipping', () => {
    const p = tone(500, 22050, 32767);
    for (let i = 0; i < p.samples.length; i += 2) p.samples[i] = 32767;
    expect(inspectChunk(p)).toMatchObject({ ok: false, issues: ['clipping'] });
  });

  it('trims leading and trailing silence over 1.5 s down to 150 ms, and leaves shorter gaps alone', () => {
    const body = tone(1000);
    const long = {
      sampleRate: 22050,
      channels: 1,
      samples: new Int16Array([...silence(3000, 22050), ...body.samples, ...silence(2500, 22050)]),
    };
    const r = inspectChunk(long);
    expect(r.ok).toBe(true);
    expect(durationMs(r.pcm)).toBe(150 + 1000 + 150);
    const short = {
      sampleRate: 22050,
      channels: 1,
      samples: new Int16Array([...silence(1000, 22050), ...body.samples, ...silence(1000, 22050)]),
    };
    expect(durationMs(inspectChunk(short).pcm)).toBe(3000);
  });
});

describe('music loop', () => {
  it('fills the requested length exactly with continuous, bounded samples', () => {
    const music = tone(2000, 22050, 12000);
    const total = 22050 * 7;
    const out = loopWithCrossfade(music, total, 22050 / 2);
    expect(out.length).toBe(total);
    // No jump larger than the tone could produce between adjacent samples (no clicks at the joins).
    let maxStep = 0;
    for (let i = 1; i < out.length; i++)
      maxStep = Math.max(maxStep, Math.abs((out[i] as number) - (out[i - 1] as number)));
    expect(maxStep).toBeLessThan(3000);
    expect(Math.max(...out.slice(0, 5000))).toBeGreaterThan(1000);
  });
});
