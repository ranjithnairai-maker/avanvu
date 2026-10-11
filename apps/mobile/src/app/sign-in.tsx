import * as AppleAuthentication from 'expo-apple-authentication';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Linking, View } from 'react-native';
import { Button } from '@/components/Button';
import { Notice } from '@/components/Notice';
import { Scaffold } from '@/components/Scaffold';
import { Text } from '@/components/Text';
import { afterSignIn } from '@/lib/auth/postSignIn';
import { signInWithApple } from '@/lib/auth/signIn';
import { config, configured } from '@/lib/config';
import { useTheme } from '@/theme/theme';

export default function SignIn() {
  const router = useRouter();
  const { scheme } = useTheme();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apple = async () => {
    setBusy(true);
    setError(null);
    const r = await signInWithApple();
    if (!r.ok) {
      setBusy(false);
      if (!r.cancelled) setError(r.message);
      return;
    }
    const after = await afterSignIn();
    setBusy(false);
    if (!after.ok) setError(after.message);
    else router.replace('/');
  };

  return (
    <Scaffold
      title="Create your account"
      subtitle="So your sessions are saved and you can listen on any of your devices."
      footer={
        <>
          <View
            accessible
            accessibilityRole="button"
            accessibilityLabel="Continue with Apple"
            pointerEvents={busy ? 'none' : 'auto'}
          >
            <AppleAuthentication.AppleAuthenticationButton
              buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
              buttonStyle={
                scheme === 'dark'
                  ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE
                  : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK
              }
              cornerRadius={16}
              style={{ height: 56, width: '100%' }}
              onPress={apple}
            />
          </View>
          <Button label="Continue with email" kind="text" onPress={() => router.push('/email')} />
          <Text variant="caption" tone="tertiary" style={{ textAlign: 'center' }}>
            By continuing you agree to the{' '}
            <Text variant="caption" tone="accent" onPress={() => Linking.openURL(config.termsUrl)}>
              Terms
            </Text>{' '}
            and{' '}
            <Text variant="caption" tone="accent" onPress={() => Linking.openURL(config.privacyUrl)}>
              Privacy Policy
            </Text>
            .
          </Text>
        </>
      }
    >
      {!configured.supabase ? (
        <Notice kind="warning">Sign-in isn't configured in this build yet.</Notice>
      ) : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
    </Scaffold>
  );
}
