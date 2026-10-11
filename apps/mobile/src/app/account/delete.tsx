import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Linking } from 'react-native';
import { Button } from '@/components/Button';
import { Notice } from '@/components/Notice';
import { Scaffold } from '@/components/Scaffold';
import { Text } from '@/components/Text';
import { api, ApiError } from '@/lib/api';
import { signOut } from '@/lib/auth/signIn';
import { logOutPurchases } from '@/lib/native/purchases';
import { removeAllSessions } from '@/lib/native/sessionFiles';

/** Account deletion (SPEC §12.7): states plainly what is removed and that the App Store subscription is not cancelled. */
export default function DeleteAccount() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(api.newKey());

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/v1/account/delete', undefined, { idempotencyKey: key.current });
      removeAllSessions();
      await logOutPurchases();
      await signOut();
      router.replace('/welcome');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "We couldn't start the deletion. Try again.");
      key.current = api.newKey();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Scaffold
      title="Delete your account"
      subtitle="This permanently removes your profile, events, sessions, audio and check-ins from Avanvu."
      footer={
        <>
          <Button label="Delete my account" kind="secondary" loading={busy} onPress={confirm} />
          <Button label="Keep my account" kind="text" onPress={() => router.back()} />
        </>
      }
    >
      <Text variant="body">
        Deletion starts right away and finishes within a short time. It can't be undone.
      </Text>
      <Notice kind="warning">
        Deleting your account does not cancel your App Store subscription. Cancel it in your Apple ID settings
        so you aren't charged again.
      </Notice>
      <Button
        label="Manage subscription"
        kind="secondary"
        onPress={() => Linking.openURL('https://apps.apple.com/account/subscriptions')}
      />
      {error ? <Notice kind="error">{error}</Notice> : null}
    </Scaffold>
  );
}
