import { api } from '@/lib/api';
import { CONSENT_VERSION } from '@/lib/config';
import { configurePurchases } from '@/lib/native/purchases';
import { useOnboarding } from '@/lib/onboarding';
import { useAuth } from './store';

/**
 * Runs right after a successful sign-in: records the age-check method and the consents collected before the
 * account existed, then configures purchases with the Supabase user id. If recording fails the onboarding state is
 * kept so the athlete can retry; nothing is lost and nothing is recorded twice (the server de-duplicates by key).
 */
export async function afterSignIn(): Promise<{ ok: true } | { ok: false; message: string }> {
  const ob = useOnboarding.getState();
  try {
    if (ob.age) {
      const method = ob.age.result === 'passed' ? 'declared_age_range' : 'self_attested';
      await api.post(
        '/v1/age-assurance',
        { method },
        { idempotencyKey: `age-${useAuth.getState().session?.user.id}` },
      );
    }
    if (ob.processingConsent) {
      await api.post(
        '/v1/consents',
        {
          consents: [
            { kind: 'processing', version: CONSENT_VERSION, accepted: true },
            { kind: 'analytics', version: CONSENT_VERSION, accepted: ob.analyticsConsent },
          ],
        },
        { idempotencyKey: `consent-${useAuth.getState().session?.user.id}-${CONSENT_VERSION}` },
      );
    }
  } catch {
    return {
      ok: false,
      message: "You're signed in, but we couldn't save your choices. Check your connection and try again.",
    };
  }
  useOnboarding.setState({ age: null, processingConsent: false, analyticsConsent: false });
  const id = useAuth.getState().session?.user.id;
  if (id) await configurePurchases(id).catch(() => undefined);
  return { ok: true };
}
