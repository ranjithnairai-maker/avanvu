import { describe, expect, it } from 'vitest';
import { FakeTtsProvider, TtsError, silenceWav } from './tts';
import { loadBackendConfig } from './config';
import { judgementSchema, JUDGE_CHECK_IDS } from './judge';

const settings = { speed: 0.92, stability: 0.8, settingsVersion: 'v1' };

describe('fake TTS provider', () => {
  it('computes duration from word count and is deterministic', async () => {
    const p = new FakeTtsProvider(100);
    const a = await p.synthesize({ text: 'one two three four five', voiceId: 'v', modelId: 'm', settings });
    const b = await p.synthesize({ text: 'one two three four five', voiceId: 'v', modelId: 'm', settings });
    expect(a.durationMs).toBe(3000);
    expect(a.audio).toEqual(b.audio);
    expect(a.charactersBilled).toBe(23);
    expect(String.fromCharCode(...a.audio.slice(0, 4))).toBe('RIFF');
  });
  it('rejects empty text as non-retryable', async () => {
    await expect(
      new FakeTtsProvider().synthesize({ text: '  ', voiceId: 'v', modelId: 'm', settings }),
    ).rejects.toBeInstanceOf(TtsError);
  });
  it('writes digital silence of the requested length', () => {
    expect(silenceWav(1000).byteLength).toBe(44 + 22_050 * 2);
  });
});

describe('config', () => {
  const env = {
    SUPABASE_URL: 'https://x.supabase.co',
    SUPABASE_SECRET_KEY: 'placeholder',
    SUPABASE_JWKS_URL: 'https://x.supabase.co/auth/v1/.well-known/jwks.json',
    SUPABASE_JWT_ISSUER: 'https://x.supabase.co/auth/v1',
    DATABASE_URL_API: 'placeholder',
    DATABASE_URL_WORKER: 'placeholder',
    ANTHROPIC_API_KEY: 'placeholder',
    LLM_MODEL_INTAKE: 'claude-sonnet-5-5',
    LLM_EFFORT_INTAKE: 'low',
    LLM_MODEL_SCRIPT: 'claude-sonnet-5-5',
    LLM_EFFORT_SCRIPT: 'medium',
    LLM_MODEL_JUDGE: 'claude-haiku-5-5',
    LLM_MODEL_DEBRIEF: 'claude-sonnet-5-5',
    ELEVENLABS_API_KEY: 'placeholder',
    TTS_MODEL_TRAINING: 'placeholder',
    TTS_MODEL_NIGHT_BEFORE: 'placeholder',
    TTS_MODEL_PRIMER: 'placeholder',
    KMS_KEY_NAME: 'placeholder',
    TASKS_QUEUE_RENDER: 'render',
    TASKS_QUEUE_JOBS: 'jobs',
    TASKS_INVOKER_SA: 'placeholder',
    WORKER_BASE_URL: 'http://localhost:8081',
    REVENUECAT_SECRET_API_KEY: 'placeholder',
    REVENUECAT_WEBHOOK_AUTH: 'placeholder',
    COST_CAP_DAILY_USD: '50',
    TRIAL_SESSION_ALLOWANCE: '3',
  };

  it('accepts placeholders locally and applies defaults', () => {
    const c = loadBackendConfig(env);
    expect(c.PRO_MONTHLY_ALLOWANCE).toBe(12);
    expect(c.COST_CAP_DAILY_USD).toBe(50);
  });
  it('refuses placeholders in preview and production', () => {
    expect(() => loadBackendConfig({ ...env, AVANVU_ENV: 'production' })).toThrow(/Placeholder/);
  });
  it('fails fast on missing values', () => {
    expect(() => loadBackendConfig({ ...env, ANTHROPIC_API_KEY: undefined })).toThrow();
  });
});

describe('judge contract', () => {
  const all = JUDGE_CHECK_IDS.map((id) => ({ id, pass: true, note: '' }));
  it('requires every check exactly once', () => {
    expect(judgementSchema.safeParse({ checks: all }).success).toBe(true);
    expect(judgementSchema.safeParse({ checks: all.slice(1) }).success).toBe(false);
    expect(judgementSchema.safeParse({ checks: [...all.slice(1), all[1]] }).success).toBe(false);
  });
});
