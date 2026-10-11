import { useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Button } from '@/components/Button';
import { Notice } from '@/components/Notice';
import { Scaffold } from '@/components/Scaffold';
import { Text } from '@/components/Text';
import { TextField } from '@/components/TextField';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth/store';

/** Respectful waitlist for unsupported sports (SPEC §2.2). Joining needs an account; leaving costs nothing. */
export default function Waitlist() {
  const router = useRouter();
  const { label: initial } = useLocalSearchParams<{ label?: string }>();
  const signedIn = useAuth((s) => s.status === 'signedIn');
  const [label, setLabel] = useState(initial ?? '');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(api.newKey());

  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/v1/waitlist', { sport_label: label.trim() }, { idempotencyKey: key.current });
      setDone(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Scaffold
      title={done ? "You're on the list" : "We're not there yet"}
      subtitle={
        done
          ? "We'll let you know when we can build sessions for your sport."
          : "Avanvu doesn't support that sport yet. Tell us what you do and we'll use it to decide what to build next."
      }
      footer={
        done ? (
          <Button label="Done" onPress={() => router.replace('/')} />
        ) : signedIn ? (
          <Button
            label="Join the waitlist"
            loading={busy}
            disabled={label.trim().length === 0}
            onPress={join}
          />
        ) : (
          <Button label="Back" kind="secondary" onPress={() => router.back()} />
        )
      }
    >
      {!done ? (
        <>
          <TextField
            label="Your sport"
            value={label}
            onChangeText={(t) => setLabel(t.slice(0, 60))}
            maxLength={60}
          />
          {!signedIn ? (
            <Text variant="callout" tone="secondary">
              To join the waitlist you'll need an account. You can also simply come back later.
            </Text>
          ) : null}
        </>
      ) : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
    </Scaffold>
  );
}
