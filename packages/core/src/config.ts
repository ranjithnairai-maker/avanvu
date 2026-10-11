/**
 * Backend configuration, validated at startup (SPEC §9.5, CLAUDE.md non-negotiable 8: configuration,
 * not constants). Placeholders are accepted in local and test environments only.
 */
import { z } from 'zod';

const placeholder = (v: string) => v === 'placeholder' || v.startsWith('placeholder');

export const backendConfigSchema = z.object({
  AVANVU_ENV: z.enum(['local', 'preview', 'production']).default('local'),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SECRET_KEY: z.string().min(1),
  SUPABASE_JWKS_URL: z.string().url(),
  SUPABASE_JWT_ISSUER: z.string().url(),
  DATABASE_URL_API: z.string().min(1),
  DATABASE_URL_WORKER: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  LLM_MODEL_INTAKE: z.string().min(1),
  LLM_EFFORT_INTAKE: z.string().min(1),
  LLM_MODEL_SCRIPT: z.string().min(1),
  LLM_EFFORT_SCRIPT: z.string().min(1),
  LLM_MODEL_JUDGE: z.string().min(1),
  LLM_MODEL_DEBRIEF: z.string().min(1),
  ELEVENLABS_API_KEY: z.string().min(1),
  TTS_MODEL_TRAINING: z.string().min(1),
  TTS_MODEL_NIGHT_BEFORE: z.string().min(1),
  TTS_MODEL_PRIMER: z.string().min(1),
  KMS_KEY_NAME: z.string().min(1),
  TASKS_QUEUE_RENDER: z.string().min(1),
  TASKS_QUEUE_JOBS: z.string().min(1),
  TASKS_INVOKER_SA: z.string().min(1),
  WORKER_BASE_URL: z.string().url(),
  REVENUECAT_SECRET_API_KEY: z.string().min(1),
  REVENUECAT_WEBHOOK_AUTH: z.string().min(1),
  COST_CAP_DAILY_USD: z.coerce.number().positive(),
  PRO_MONTHLY_ALLOWANCE: z.coerce.number().int().positive().default(12),
  TRIAL_SESSION_ALLOWANCE: z.coerce.number().int().min(0),
  FREE_TRAINING_GRANT: z.coerce.number().int().min(0).default(1),
  FREE_PRIMER_GRANT: z.coerce.number().int().min(0).default(1),
});

export type BackendConfig = z.infer<typeof backendConfigSchema>;

export function loadBackendConfig(env: Record<string, string | undefined>): BackendConfig {
  const cfg = backendConfigSchema.parse(env);
  if (cfg.AVANVU_ENV !== 'local') {
    const bad = Object.entries(cfg)
      .filter(([, v]) => typeof v === 'string' && placeholder(v))
      .map(([k]) => k);
    if (bad.length > 0)
      throw new Error(`Placeholder values are not allowed outside local: ${bad.join(', ')}`);
  }
  return cfg;
}

/** Mobile public config (SPEC §9.5). Public by design: never put a secret key here. */
export const mobilePublicConfigSchema = z.object({
  EXPO_PUBLIC_ENV: z.enum(['local', 'preview', 'production']).default('local'),
  EXPO_PUBLIC_SUPABASE_URL: z.string().url(),
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  EXPO_PUBLIC_API_BASE_URL: z.string().url(),
});
export type MobilePublicConfig = z.infer<typeof mobilePublicConfigSchema>;
