import type { Session } from '@supabase/supabase-js';
import { create } from 'zustand';
import { supabase } from './supabase';

type Status = 'loading' | 'signedOut' | 'signedIn';

interface AuthState {
  status: Status;
  session: Session | null;
}

export const useAuth = create<AuthState>(() => ({ status: 'loading', session: null }));

let started = false;

/** Subscribe once at app start. Never stores tokens anywhere but the keychain-backed Supabase storage. */
export function startAuthListener(): void {
  if (started) return;
  started = true;
  void supabase.auth.getSession().then(({ data }) => {
    useAuth.setState({ session: data.session, status: data.session ? 'signedIn' : 'signedOut' });
  });
  supabase.auth.onAuthStateChange((_event, session) => {
    useAuth.setState({ session, status: session ? 'signedIn' : 'signedOut' });
  });
}
