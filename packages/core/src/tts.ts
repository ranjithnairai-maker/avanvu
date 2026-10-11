/**
 * Provider-neutral text-to-speech interface (SPEC §6.3). ElevenLabs is the v1 provider and lives in the
 * backend; voice ids and model ids are configuration, never code. The fake adapter below produces
 * deterministic speech-like audio of computed length for CI (EVALS §5.1) and local development.
 */
export interface TtsVoice {
  id: string;
  label: string;
}

export interface TtsSettings {
  /** Slower than provider default; fixed per voice. */
  speed: number;
  stability: number;
  settingsVersion: string;
}

export interface TtsRequest {
  text: string;
  voiceId: string;
  modelId: string;
  settings: TtsSettings;
  /** Neighbouring speech text for prosody continuity where the provider supports it. */
  previousText?: string;
  nextText?: string;
}

export interface TtsResult {
  /** 16-bit PCM mono WAV. */
  audio: Uint8Array;
  durationMs: number;
  charactersBilled: number;
  providerRequestId: string;
}

export class TtsError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'TtsError';
  }
}

export interface TtsProvider {
  readonly name: string;
  listVoices(): Promise<TtsVoice[]>;
  synthesize(req: TtsRequest): Promise<TtsResult>;
}

const SAMPLE_RATE = 22_050;

/** Minimal 16-bit PCM mono WAV writer. */
export function pcmToWav(samples: Int16Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, dataBytes, true);
  new Int16Array(buf, 44).set(samples);
  return new Uint8Array(buf);
}

export function silenceWav(ms: number): Uint8Array {
  return pcmToWav(new Int16Array(Math.round((ms / 1000) * SAMPLE_RATE)));
}

/** Deterministic fake: duration = words / wpm, filled with a low-level tone (no network, no cost). */
export class FakeTtsProvider implements TtsProvider {
  readonly name = 'fake';
  private n = 0;

  constructor(private readonly wpm = 100) {}

  async listVoices(): Promise<TtsVoice[]> {
    return [
      { id: 'fake_voice_a', label: 'Fake voice A' },
      { id: 'fake_voice_b', label: 'Fake voice B' },
      { id: 'fake_voice_c', label: 'Fake voice C' },
    ];
  }

  async synthesize(req: TtsRequest): Promise<TtsResult> {
    if (!req.text.trim()) throw new TtsError('empty text', false);
    const words = req.text.trim().split(/\s+/).length;
    const durationMs = Math.round((words / this.wpm) * 60_000);
    const count = Math.round((durationMs / 1000) * SAMPLE_RATE);
    const samples = new Int16Array(count);
    for (let i = 0; i < count; i++)
      samples[i] = Math.round(Math.sin((2 * Math.PI * 180 * i) / SAMPLE_RATE) * 3000);
    return {
      audio: pcmToWav(samples),
      durationMs,
      charactersBilled: req.text.length,
      providerRequestId: `fake_${++this.n}`,
    };
  }
}
