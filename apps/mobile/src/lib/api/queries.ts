/**
 * Server state with TanStack Query (SPEC §9.1). Reads only here; mutations live next to the screens that use
 * them so each one controls its own idempotency key and error copy.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth/store';
import { api } from './index';

export interface Me {
  upcoming_event: EventDto | null;
  pending_debrief: EventDto | null;
  active_intake: { id: string; event_id: string; state: string } | null;
  has_profile: boolean;
  user: { analytics_id: string; demo_account: boolean; time_zone: string | null; age_assured: boolean };
  entitlement: { active: boolean; period_type: string | null; expires_at: string | null } | null;
  allowance: {
    free_training: number;
    free_primer: number;
    pro: null | {
      available: number;
      held_for_events: number;
      available_for_on_demand: number;
      bucket_start: string;
      bucket_end: string;
    };
  };
}

export interface EventDto {
  id: string;
  name: string;
  sport_label: string | null;
  starts_local: string;
  time_zone: string;
  starts_at: string;
  status: string;
  supported_sport_id: string;
  engine: string;
  program_id: string | null;
}

export interface ProgramItemDto {
  id: string;
  kind: 'training' | 'night_before' | 'primer' | 'debrief';
  target_date: string;
  generate_at: string | null;
  state: string;
  session_id: string | null;
  locked: boolean;
}

export interface SessionDto {
  id: string;
  context: 'training' | 'night_before' | 'primer';
  length_min: number;
  status: 'preparing' | 'voicing' | 'ready' | 'failed' | 'canceled';
  state: string;
  engine: string;
  created_at: string;
  ready_at: string | null;
  duration_ms: number | null;
  failure_code: string | null;
  program_item_id: string | null;
  sha256?: string | null;
  bytes?: number | null;
}

const signedIn = () => useAuth.getState().status === 'signedIn';

export const useMe = (): UseQueryResult<Me> =>
  useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<Me>('/v1/me'),
    enabled: signedIn(),
    staleTime: 30_000,
  });

export const useEvent = (id: string | null | undefined): UseQueryResult<EventDto> =>
  useQuery({
    queryKey: ['event', id],
    queryFn: () => api.get<EventDto>(`/v1/events/${id}`),
    enabled: !!id && signedIn(),
  });

export const useProgram = (
  id: string | null | undefined,
): UseQueryResult<{ id: string; event_id: string; items: ProgramItemDto[] }> =>
  useQuery({
    queryKey: ['program', id],
    queryFn: () => api.get(`/v1/programs/${id}`),
    enabled: !!id && signedIn(),
  });

export const useSessions = (
  context?: string,
): UseQueryResult<{ sessions: SessionDto[]; next_cursor: string | null }> =>
  useQuery({
    queryKey: ['sessions', context ?? 'all'],
    queryFn: () => api.get('/v1/sessions', { query: { context, limit: 50 } }),
    enabled: signedIn(),
  });

/** Polls while the composing screen is visible: every 3 s, backing off to 10 s after 60 s (SPEC §11.1, D-08). */
export const useSession = (
  id: string | null | undefined,
  startedAt = Date.now(),
): UseQueryResult<SessionDto> =>
  useQuery({
    queryKey: ['session', id],
    queryFn: () => api.get<SessionDto>(`/v1/sessions/${id}`),
    enabled: !!id && signedIn(),
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      if (s === 'ready' || s === 'failed' || s === 'canceled') return false;
      return Date.now() - startedAt > 60_000 ? 10_000 : 3_000;
    },
  });

export interface ProfileDto {
  version: number;
  source: string;
  profile: import('@avanvu/core').AthleteProfile;
}

export const useProfile = (): UseQueryResult<ProfileDto> =>
  useQuery({ queryKey: ['profile'], queryFn: () => api.get<ProfileDto>('/v1/profile'), enabled: signedIn() });
