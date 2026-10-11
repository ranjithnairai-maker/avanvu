/** Session and render states (CONTRACTS §8). */
export const SESSION_STATES = [
  'reserved',
  'queued',
  'generating_script',
  'validating',
  'synthesizing',
  'mixing',
  'uploading',
  'ready',
  'failed',
  'canceled',
] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const TERMINAL_STATES: readonly SessionState[] = ['ready', 'failed', 'canceled'];
export const IN_PROGRESS_STATES: readonly SessionState[] = SESSION_STATES.filter(
  (s) => !TERMINAL_STATES.includes(s),
);

/** The pipeline order. `failed` is reachable from any non-terminal state; `canceled` only from the first two. */
const FORWARD: Partial<Record<SessionState, SessionState>> = {
  reserved: 'queued',
  queued: 'generating_script',
  generating_script: 'validating',
  validating: 'synthesizing',
  synthesizing: 'mixing',
  mixing: 'uploading',
  uploading: 'ready',
};

export function canTransition(from: SessionState, to: SessionState): boolean {
  if (TERMINAL_STATES.includes(from)) return false;
  if (to === 'failed') return true;
  if (to === 'canceled') return from === 'reserved' || from === 'queued';
  // A retried attempt may resume at an earlier or the same stage after a worker restart.
  const order = SESSION_STATES.indexOf(to);
  const current = SESSION_STATES.indexOf(from);
  if (FORWARD[from] === to) return true;
  return (
    to === 'generating_script' || (order <= current && order >= SESSION_STATES.indexOf('generating_script'))
  );
}

export type ClientSessionStatus = 'preparing' | 'voicing' | 'ready' | 'failed' | 'canceled';

/** The simplified status the app sees (CONTRACTS §8.1). */
export function clientStatus(state: SessionState): ClientSessionStatus {
  switch (state) {
    case 'reserved':
    case 'queued':
    case 'generating_script':
    case 'validating':
      return 'preparing';
    case 'synthesizing':
    case 'mixing':
    case 'uploading':
      return 'voicing';
    default:
      return state;
  }
}

/** Retryable and non-retryable job errors (CONTRACTS §8.2). */
export const NON_RETRYABLE_JOB_ERRORS = [
  'VALIDATION_FAILED_AFTER_REPAIR',
  'DURATION_UNFITTABLE',
  'ENTITLEMENT_REVOKED',
  'PROFILE_VERSION_MISSING',
  'AUDIO_OUT_OF_TOLERANCE',
] as const;
export type NonRetryableJobError = (typeof NON_RETRYABLE_JOB_ERRORS)[number];

export const MAX_RENDER_ATTEMPTS = 3;
export const LEASE_SECONDS = 120;
export const HEARTBEAT_SECONDS = 30;
