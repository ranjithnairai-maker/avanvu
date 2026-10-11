import { isEligibleForAgeFeaturesAsync, requestAgeRangeAsync } from 'expo-age-range';
import { useState } from 'react';
import { MINIMUM_AGE, decideAgeOutcome, type AgeRangeSignal } from '@avanvu/core';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Screen } from '@/components/Screen';
import { Text } from '@/components/Text';

/**
 * Spike (c): Declared Age Range behaviour in sandbox (SPEC §12.5). Prints only the response shape and
 * the resulting decision; nothing is stored or sent anywhere.
 */
export default function AgeRangeSpike() {
  const [eligible, setEligible] = useState<boolean | null | 'error'>(null);
  const [lines, setLines] = useState<string[]>([]);
  const add = (l: string) => setLines((p) => [...p, l]);

  const checkEligibility = async () => {
    try {
      setEligible(await isEligibleForAgeFeaturesAsync());
    } catch {
      setEligible('error');
    }
  };

  const request = async () => {
    let signal: AgeRangeSignal;
    try {
      const r = await requestAgeRangeAsync({ threshold1: MINIMUM_AGE });
      signal = { status: 'shared', lowerBound: r.lowerBound, upperBound: r.upperBound };
      add(`Response: lowerBound=${String(r.lowerBound)} upperBound=${String(r.upperBound)}`);
    } catch (e) {
      signal = { status: 'declined' };
      add(`Rejected: ${e instanceof Error ? e.message.slice(0, 120) : 'unknown error'}`);
    }
    const regulation = eligible === 'error' ? null : eligible;
    add(`Decision: ${JSON.stringify(decideAgeOutcome(signal, regulation))}`);
  };

  return (
    <Screen>
      <Card>
        <Text variant="headline">Eligibility signal</Text>
        <Text variant="body" tone="secondary">
          {eligible === null
            ? 'Not checked'
            : eligible === 'error'
              ? 'Request failed (treated as unknown)'
              : String(eligible)}
        </Text>
      </Card>
      <Button label="Check eligibility" kind="secondary" onPress={checkEligibility} />
      <Button label="Request age range (minimum 18)" onPress={request} />
      {lines.map((l, i) => (
        <Text key={i} variant="callout" tone="secondary">
          {l}
        </Text>
      ))}
    </Screen>
  );
}
