import { describe, expect, it } from 'vitest';
import { UnimplementedAdaptersError, compose } from './composition';

const base: NodeJS.ProcessEnv = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEY: 'k',
  SUPABASE_JWKS_URL: 'https://example.supabase.co/auth/v1/.well-known/jwks.json',
  SUPABASE_JWT_ISSUER: 'https://example.supabase.co/auth/v1',
  DATABASE_URL_API: 'postgres://u:p@127.0.0.1:5432/db',
  DATABASE_URL_WORKER: 'postgres://u:p@127.0.0.1:5432/db',
  ANTHROPIC_API_KEY: 'k',
  LLM_MODEL_INTAKE: 'm',
  LLM_EFFORT_INTAKE: 'low',
  LLM_MODEL_SCRIPT: 'm',
  LLM_EFFORT_SCRIPT: 'medium',
  LLM_MODEL_JUDGE: 'm',
  LLM_MODEL_DEBRIEF: 'm',
  ELEVENLABS_API_KEY: 'k',
  TTS_MODEL_TRAINING: 'm',
  TTS_MODEL_NIGHT_BEFORE: 'm',
  TTS_MODEL_PRIMER: 'm',
  KMS_KEY_NAME: 'projects/p/locations/us-east4/keyRings/r/cryptoKeys/k',
  TASKS_QUEUE_RENDER: 'render',
  TASKS_QUEUE_JOBS: 'jobs',
  TASKS_INVOKER_SA: 'sa@p.iam.gserviceaccount.com',
  WORKER_BASE_URL: 'https://worker.example',
  REVENUECAT_SECRET_API_KEY: 'k',
  REVENUECAT_WEBHOOK_AUTH: 'Bearer x',
  COST_CAP_DAILY_USD: '50',
  TRIAL_SESSION_ALLOWANCE: '3',
};

describe('process composition', () => {
  it('refuses to start in preview and production while vendor adapters are placeholders, naming them', async () => {
    for (const env of ['preview', 'production']) {
      const err = await compose('api', { ...base, AVANVU_ENV: env }).catch((e) => e);
      expect(err).toBeInstanceOf(UnimplementedAdaptersError);
      expect(err.missing).toEqual(
        expect.arrayContaining(['anthropic', 'elevenlabs', 'cloud-kms', 'cloud-tasks']),
      );
      expect(err.message).toContain('Refusing to start');
    }
  });

  it('assembles the api and worker graphs locally with fake vendors and no keys', async () => {
    const rt = await compose('both', { ...base, AVANVU_ENV: 'local', SUPABASE_SECRET_KEY: 'placeholder' });
    expect(rt.api?.deps.llm.constructor.name).toBe('DevLlm');
    expect(rt.worker?.deps.account).toBeDefined();
    expect(rt.adapters.placeholders).toEqual([]);
  });
});
