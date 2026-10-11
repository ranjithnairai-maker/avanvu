import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Linking } from 'react-native';
import { Button } from '@/components/Button';
import { Notice } from '@/components/Notice';
import { Scaffold } from '@/components/Scaffold';
import { Text } from '@/components/Text';
import { api, ApiError } from '@/lib/api';

type ExportState = { id: string; state: 'queued' | 'running' | 'ready' | 'failed' | 'expired'; url?: string };

/** Data export (SPEC §12.7): request, wait, then open the short-lived link. The link is never logged or stored. */
export default function ExportData() {
  const router = useRouter();
  const [job, setJob] = useState<ExportState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(api.newKey());

  useEffect(() => {
    if (!job || job.state === 'ready' || job.state === 'failed' || job.state === 'expired') return;
    const t = setInterval(() => {
      api
        .get<ExportState>(`/v1/account/exports/${job.id}`)
        .then(setJob)
        .catch(() => undefined);
    }, 4000);
    return () => clearInterval(t);
  }, [job]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      setJob(await api.post<ExportState>('/v1/account/export', undefined, { idempotencyKey: key.current }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "We couldn't start the export. Try again.");
      key.current = api.newKey();
    } finally {
      setBusy(false);
    }
  };

  const waiting = job !== null && (job.state === 'queued' || job.state === 'running');
  return (
    <Scaffold
      title="Export your data"
      subtitle="You'll get a file with your profile, events, scripts and check-ins."
      footer={
        job?.state === 'ready' && job.url ? (
          <Button label="Download my data" onPress={() => Linking.openURL(job.url as string)} />
        ) : (
          <Button
            label={waiting ? 'Preparing your export' : 'Request export'}
            loading={busy || waiting}
            onPress={start}
          />
        )
      }
    >
      <Text variant="body" tone="secondary">
        Preparing takes a few minutes. The download link works for 15 minutes once it's ready; you can request
        a new export any time.
      </Text>
      {job?.state === 'failed' ? <Notice kind="error">The export didn't finish. Try again.</Notice> : null}
      {job?.state === 'expired' ? (
        <Notice kind="info">That export has expired. Request a new one.</Notice>
      ) : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
      <Button label="Back" kind="text" onPress={() => router.back()} />
    </Scaffold>
  );
}
