import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Button } from '@/components/Button';
import { Notice } from '@/components/Notice';
import { Scaffold } from '@/components/Scaffold';
import { TextField } from '@/components/TextField';
import { afterSignIn } from '@/lib/auth/postSignIn';
import { requestEmailCode, verifyEmailCode } from '@/lib/auth/signIn';

const RESEND_SECONDS = 30;

/** Email one-time code (D-05): a 6-digit code that Mail can auto-fill. Resend is offered after 30 seconds. */
export default function EmailSignIn() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wait, setWait] = useState(0);

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const send = async () => {
    setBusy(true);
    setError(null);
    const r = await requestEmailCode(email);
    setBusy(false);
    if (r.ok) {
      setSent(true);
      setWait(RESEND_SECONDS);
    } else setError(r.message);
  };

  const verify = async () => {
    setBusy(true);
    setError(null);
    const r = await verifyEmailCode(email, code);
    if (!r.ok) {
      setBusy(false);
      setError(r.message);
      return;
    }
    const after = await afterSignIn();
    setBusy(false);
    if (!after.ok) setError(after.message);
    else router.replace('/');
  };

  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  return (
    <Scaffold
      title={sent ? 'Enter your code' : 'Continue with email'}
      subtitle={
        sent
          ? `We sent a 6-digit code to ${email.trim()}.`
          : "We'll email you a one-time code. No password to remember."
      }
      footer={
        sent ? (
          <>
            <Button label="Verify" loading={busy} disabled={code.trim().length < 6} onPress={verify} />
            <Button
              label={wait > 0 ? `Resend code in ${wait}` : 'Resend code'}
              kind="text"
              disabled={wait > 0 || busy}
              onPress={send}
            />
          </>
        ) : (
          <Button label="Send code" loading={busy} disabled={!validEmail} onPress={send} />
        )
      }
    >
      {sent ? (
        <TextField
          label="Code"
          value={code}
          onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))}
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          autoComplete="one-time-code"
          autoFocus
          maxLength={6}
        />
      ) : (
        <TextField
          label="Email"
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          textContentType="emailAddress"
          autoComplete="email"
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
        />
      )}
      {error ? <Notice kind="error">{error}</Notice> : null}
    </Scaffold>
  );
}
