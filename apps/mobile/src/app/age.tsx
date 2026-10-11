import { isEligibleForAgeFeaturesAsync, requestAgeRangeAsync } from 'expo-age-range';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { MINIMUM_AGE, decideAgeOutcome, type AgeOutcome, type AgeRangeSignal } from '@avanvu/core';
import { Button } from '@/components/Button';
import { Notice } from '@/components/Notice';
import { Toggle } from '@/components/Row';
import { Scaffold } from '@/components/Scaffold';
import { Text } from '@/components/Text';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth/store';
import { useOnboarding } from '@/lib/onboarding';

/**
 * Age check (SPEC §12.5, D-06). Apple's Declared Age Range runs with a minimum age of 18. Under 18 leads to the block
 * screen and nothing is stored. A declined or unavailable answer blocks only where Apple says regulation applies;
 * otherwise the athlete confirms with a checkbox, recorded as self-attested. No birth date is ever held.
 */
export default function AgeCheck() {
  const router = useRouter();
  const signedIn = useAuth((s) => s.status === 'signedIn');
  const setAge = useOnboarding((s) => s.setAge);
  const [busy, setBusy] = useState(false);
  const [needsAttestation, setNeedsAttestation] = useState(false);
  const [attested, setAttested] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finish = async (outcome: Extract<AgeOutcome, { result: 'passed' | 'self_attest' }>) => {
    const method = outcome.result === 'passed' ? 'declared_age_range' : 'self_attested';
    if (signedIn) {
      try {
        await api.post('/v1/age-assurance', { method });
        router.replace('/');
      } catch {
        setError("We couldn't save that. Check your connection and try again.");
      }
      return;
    }
    setAge(outcome);
    router.push('/consent');
  };

  const check = async () => {
    setBusy(true);
    setError(null);
    let signal: AgeRangeSignal;
    try {
      const r = await requestAgeRangeAsync({ threshold1: MINIMUM_AGE });
      signal = { status: 'shared', lowerBound: r.lowerBound, upperBound: r.upperBound };
    } catch {
      signal = { status: 'declined' };
    }
    let regulation: boolean | null;
    try {
      regulation = await isEligibleForAgeFeaturesAsync();
    } catch {
      regulation = null;
    }
    const outcome = decideAgeOutcome(signal, regulation);
    setBusy(false);
    if (outcome.result === 'blocked') {
      router.replace({ pathname: '/age-block', params: { reason: outcome.reason } });
    } else if (outcome.result === 'self_attest') {
      setNeedsAttestation(true);
    } else {
      await finish(outcome);
    }
  };

  return (
    <Scaffold
      title="Before we begin"
      subtitle="Avanvu is for adults aged 18 or older. Your iPhone can confirm this without sharing your birth date."
      footer={
        needsAttestation ? (
          <Button
            label="Continue"
            disabled={!attested}
            onPress={() => finish({ result: 'self_attest', method: 'self_attested' })}
          />
        ) : (
          <Button label="Check my age" loading={busy} onPress={check} />
        )
      }
    >
      {needsAttestation ? (
        <>
          <Text variant="body" tone="secondary">
            We couldn't confirm your age from your device, so we need you to confirm it.
          </Text>
          <Toggle label="I confirm that I am 18 or older" value={attested} onChange={setAttested} />
        </>
      ) : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
    </Scaffold>
  );
}
