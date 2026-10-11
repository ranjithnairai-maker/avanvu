import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Linking } from 'react-native';
import { Button } from '@/components/Button';
import { Notice } from '@/components/Notice';
import { Row, Toggle } from '@/components/Row';
import { Scaffold } from '@/components/Scaffold';
import { Text } from '@/components/Text';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth/store';
import { CONSENT_VERSION, config } from '@/lib/config';
import { useOnboarding } from '@/lib/onboarding';

/**
 * Privacy and consent summary (SPEC §8.1 step 3, §12.4). Plain language about what is collected, where it is stored,
 * who it is sent to and for how long. Processing consent is required; analytics is a separate, optional choice.
 */
export default function Consent() {
  const router = useRouter();
  const signedIn = useAuth((s) => s.status === 'signedIn');
  const setConsent = useOnboarding((s) => s.setConsent);
  const [processing, setProcessing] = useState(false);
  const [analytics, setAnalytics] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const next = async () => {
    if (signedIn) {
      try {
        await api.post('/v1/consents', {
          consents: [
            { kind: 'processing', version: CONSENT_VERSION, accepted: true },
            { kind: 'analytics', version: CONSENT_VERSION, accepted: analytics },
          ],
        });
        router.replace('/');
      } catch {
        setError("We couldn't save that. Check your connection and try again.");
      }
      return;
    }
    setConsent(processing, analytics);
    router.push('/sign-in');
  };

  return (
    <Scaffold
      title="Your data, plainly"
      subtitle="Avanvu helps you prepare. It isn't therapy or medical care."
      footer={<Button label="Continue" disabled={!processing} onPress={next} />}
    >
      <Text variant="body">
        What we collect: the event you tell us about and your answers to the interview. We use them to write
        your sessions.
      </Text>
      <Text variant="body">
        Where it goes: your answers are stored in the United States, encrypted. Your profile text is sent to
        Anthropic to write your sessions, and session text is sent to ElevenLabs to voice them.
      </Text>
      <Text variant="body">
        How long: your data stays until you delete it. Deleting your account removes it, and you can export it
        first.
      </Text>
      <Row
        title="Privacy Policy"
        onPress={() => Linking.openURL(config.privacyUrl)}
        accessory={<Text tone="accent">Open</Text>}
      />
      <Row
        title="Terms of Use"
        onPress={() => Linking.openURL(config.termsUrl)}
        accessory={<Text tone="accent">Open</Text>}
      />
      <Toggle
        label="I agree to this use of my data"
        description="Required to use Avanvu."
        value={processing}
        onChange={setProcessing}
      />
      <Toggle
        label="Share anonymous usage"
        description="Optional. Counts and timings only, never your words."
        value={analytics}
        onChange={setAnalytics}
      />
      {error ? <Notice kind="error">{error}</Notice> : null}
    </Scaffold>
  );
}
