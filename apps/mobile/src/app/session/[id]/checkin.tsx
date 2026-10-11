import { useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Button } from '@/components/Button';
import { Notice } from '@/components/Notice';
import { Scaffold } from '@/components/Scaffold';
import { Slider } from '@/components/Slider';
import { TextField } from '@/components/TextField';
import { api, ApiError } from '@/lib/api';

/** Post-session check-in (SPEC §5.5): two sliders and two optional notes. Check-ins never change the profile. */
export default function Checkin() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [vividness, setVividness] = useState(3);
  const [readiness, setReadiness] = useState(3);
  const [useful, setUseful] = useState('');
  const [off, setOff] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(api.newKey());

  const done = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(
        `/v1/sessions/${id}/checkin`,
        {
          vividness,
          readiness,
          ...(useful.trim() ? { useful: useful.trim() } : {}),
          ...(off.trim() ? { off: off.trim() } : {}),
        },
        { idempotencyKey: key.current },
      );
      router.replace('/');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Scaffold
      title="How was that?"
      subtitle="Two quick questions help the next session fit you better."
      footer={
        <>
          <Button label="Done" loading={busy} onPress={done} />
          <Button label="Skip" kind="text" onPress={() => router.replace('/')} />
        </>
      }
    >
      <Slider label="How vivid was it? (1 faint, 5 very clear)" value={vividness} onChange={setVividness} />
      <Slider label="How ready do you feel? (1 not yet, 5 ready)" value={readiness} onChange={setReadiness} />
      <TextField
        label="What felt most useful? (optional)"
        value={useful}
        onChangeText={(t) => setUseful(t.slice(0, 280))}
        multiline
      />
      <TextField
        label="Anything feel off? (optional)"
        value={off}
        onChangeText={(t) => setOff(t.slice(0, 280))}
        multiline
      />
      {error ? <Notice kind="error">{error}</Notice> : null}
    </Scaffold>
  );
}
