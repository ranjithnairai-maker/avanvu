import { config } from '@/lib/config';
import { getAccessToken, supabase } from '@/lib/auth/supabase';
import { createApiClient } from './client';

export * from './client';

/** The single API client. A signed-out response signs the athlete out locally. */
export const api = createApiClient({
  baseUrl: config.apiBaseUrl,
  getToken: getAccessToken,
  onUnauthenticated: () => {
    void supabase.auth.signOut();
  },
});
