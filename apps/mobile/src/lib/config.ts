/**
 * Public configuration (SPEC §9.5). Everything here ships in the app binary, so it must never contain a secret:
 * only the Supabase URL and publishable key, the API base URL, and public SDK keys. Missing values fall back to
 * clearly marked placeholders, and `configured` tells the UI to show a setup notice instead of failing mysteriously.
 */
const env = (k: string): string | undefined => {
  const v = process.env[k];
  return v && v.trim() !== '' ? v : undefined;
};

export const config = {
  env: (env('EXPO_PUBLIC_ENV') ?? 'local') as 'local' | 'preview' | 'production',
  apiBaseUrl: env('EXPO_PUBLIC_API_BASE_URL') ?? 'http://localhost:8080',
  supabaseUrl: env('EXPO_PUBLIC_SUPABASE_URL') ?? 'http://127.0.0.1:54321',
  supabasePublishableKey: env('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY') ?? 'placeholder',
  revenueCatIosKey: env('EXPO_PUBLIC_REVENUECAT_IOS_KEY') ?? '',
  posthogKey: env('EXPO_PUBLIC_POSTHOG_KEY') ?? '',
  sentryDsn: env('EXPO_PUBLIC_SENTRY_DSN') ?? '',
  privacyUrl: 'https://avanvu.com/privacy',
  termsUrl: 'https://avanvu.com/terms',
  supportUrl: 'https://avanvu.com/support',
} as const;

export const configured = {
  supabase: config.supabasePublishableKey !== 'placeholder',
  purchases: config.revenueCatIosKey !== '',
  analytics: config.posthogKey !== '',
};

/** Versions of the documents the athlete accepts (recorded with POST /v1/consents). */
export const CONSENT_VERSION = '2026-10-11';
