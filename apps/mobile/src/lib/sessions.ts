import type { QueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import type { SessionDto } from '@/lib/api/queries';

export type StartResult =
  { ok: true; session: SessionDto } | { ok: false; reason: 'paywall' | 'paused' | 'error'; message: string };

/**
 * Create a session (SPEC §5.3). Paid-action failures lead to the paywall (D-32); the cost breaker and other
 * failures get honest copy. The key is stable per attempt so a double tap never spends allowance twice.
 */
export async function startSession(
  qc: QueryClient,
  body: {
    program_item_id: string | null;
    context: 'training' | 'night_before' | 'primer';
    length_min: 3 | 5 | 10 | 15;
  },
  key: string,
): Promise<StartResult> {
  try {
    const session = await api.post<SessionDto>('/v1/sessions', body, { idempotencyKey: key });
    void qc.invalidateQueries({ queryKey: ['me'] });
    void qc.invalidateQueries({ queryKey: ['sessions'] });
    void qc.invalidateQueries({ queryKey: ['program'] });
    return { ok: true, session };
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.code === 'ENTITLEMENT_REQUIRED' || e.code === 'ALLOWANCE_EXHAUSTED')
        return { ok: false, reason: 'paywall', message: e.message };
      if (e.code === 'GENERATION_PAUSED') return { ok: false, reason: 'paused', message: e.message };
      return { ok: false, reason: 'error', message: e.message };
    }
    return { ok: false, reason: 'error', message: 'Something went wrong. Try again.' };
  }
}

export const CONTEXT_LABEL = {
  training: 'Training session',
  night_before: 'Night before',
  primer: 'Pre-event primer',
} as const;
export const CONTEXT_ICON = {
  training: 'figure.run',
  night_before: 'moon.stars.fill',
  primer: 'bolt.fill',
} as const;
