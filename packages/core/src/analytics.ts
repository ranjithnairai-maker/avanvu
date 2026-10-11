/**
 * Analytics event allowlist (CONTRACTS §13). The typed map rejects anything else at compile time;
 * `sanitizeEvent` rejects it at runtime. Only bounded enums, booleans and integers are allowed.
 */
export type Context = 'training' | 'night_before' | 'primer';
export type EngineId = import('./sports').Engine;

export interface AnalyticsEvents {
  app_opened: { cold_start: boolean };
  age_check_completed: { result: 'passed' | 'blocked' | 'self_attested' };
  signup_completed: { method: 'apple' | 'email_otp' };
  sport_selected: { engine: EngineId; is_custom_endurance: boolean };
  unsupported_sport_waitlisted: Record<string, never>;
  intake_started: Record<string, never>;
  intake_phase_completed: { phase: string };
  intake_summary_shown: { turns: number; minutes: number };
  intake_summary_confirmed: { edits: number };
  safety_interrupt_shown: { layer: 'deterministic' | 'model' };
  session_generation_requested: { context: Context; engine: EngineId; length_min: number };
  session_ready: { context: Context; seconds_to_ready: number };
  session_failed: { context: Context; error_code: string };
  session_download_verified: { context: Context };
  playback_started: { context: Context; play_count: number };
  playback_80_percent: { context: Context };
  checkin_submitted: { vividness: 1 | 2 | 3 | 4 | 5; readiness: 1 | 2 | 3 | 4 | 5 };
  debrief_submitted: { learnings_confirmed: number };
  offline_ready_at_t24: { context: Context; ready: boolean };
  paywall_viewed: { trigger: 'allowance' | 'feature' | 'home_card' };
  trial_started: { product: 'monthly' | 'annual' };
  purchase_completed: { product: 'monthly' | 'annual' };
  restore_completed: { found: boolean };
  notification_opened: { kind: string };
  export_requested: Record<string, never>;
}

export type AnalyticsEventName = keyof AnalyticsEvents;

export const ANALYTICS_EVENT_NAMES: readonly AnalyticsEventName[] = [
  'app_opened',
  'age_check_completed',
  'signup_completed',
  'sport_selected',
  'unsupported_sport_waitlisted',
  'intake_started',
  'intake_phase_completed',
  'intake_summary_shown',
  'intake_summary_confirmed',
  'safety_interrupt_shown',
  'session_generation_requested',
  'session_ready',
  'session_failed',
  'session_download_verified',
  'playback_started',
  'playback_80_percent',
  'checkin_submitted',
  'debrief_submitted',
  'offline_ready_at_t24',
  'paywall_viewed',
  'trial_started',
  'purchase_completed',
  'restore_completed',
  'notification_opened',
  'export_requested',
];

/** Short snake_case tokens only: blocks free text from slipping into string properties. */
const SAFE_TOKEN = /^[a-z0-9_]{1,40}$/;

export function sanitizeEvent(
  name: string,
  props: Record<string, unknown>,
): { name: AnalyticsEventName; props: Record<string, string | number | boolean> } | null {
  if (!(ANALYTICS_EVENT_NAMES as readonly string[]).includes(name)) return null;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'number' && Number.isInteger(v)) out[k] = v;
    else if (typeof v === 'string' && SAFE_TOKEN.test(v)) out[k] = v;
    else return null;
  }
  return { name: name as AnalyticsEventName, props: out };
}
