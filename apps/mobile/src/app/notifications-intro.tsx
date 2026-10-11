import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking } from 'react-native';
import { Button } from '@/components/Button';
import { Scaffold } from '@/components/Scaffold';
import { Text } from '@/components/Text';
import { api } from '@/lib/api';
import { useMe } from '@/lib/api/queries';
import {
  getPushToken,
  notificationPermission,
  requestNotificationPermission,
  scheduleEventReminders,
  type PermissionState,
} from '@/lib/native/notifications';

/** Notification education (SPEC §8.2): why reminders help on race day; the system prompt appears after the tap. */
export default function NotificationsIntro() {
  const router = useRouter();
  const me = useMe();
  const [perm, setPerm] = useState<PermissionState>('undetermined');
  useEffect(() => void notificationPermission().then(setPerm), []);

  const turnOn = async () => {
    if (perm === 'denied') {
      await Linking.openSettings();
      return;
    }
    if (!(await requestNotificationPermission())) {
      setPerm(await notificationPermission());
      return;
    }
    setPerm('granted');
    const ev = me.data?.upcoming_event;
    if (ev)
      await scheduleEventReminders({ id: ev.id, starts_local: ev.starts_local, time_zone: ev.time_zone });
    const token = await getPushToken();
    if (token) await api.post('/v1/devices', { push_token: token }).catch(() => undefined);
    router.back();
  };

  return (
    <Scaffold
      title="Reminders that help on race day"
      subtitle="A short reminder the evening before, one before you start, and one the morning after to capture what you learned."
      footer={
        perm === 'granted' ? (
          <Button label="Done" onPress={() => router.back()} />
        ) : (
          <>
            <Button label={perm === 'denied' ? 'Open Settings' : 'Turn on reminders'} onPress={turnOn} />
            <Button label="Not now" kind="text" onPress={() => router.back()} />
          </>
        )
      }
    >
      <Text variant="body" tone="secondary">
        They work without a connection and arrive in your event's time zone. We'll also tell you when a
        session is ready.
      </Text>
      {perm === 'denied' ? (
        <Text variant="callout" tone="tertiary">
          Notifications are off for Avanvu. You can turn them on in Settings.
        </Text>
      ) : null}
    </Scaffold>
  );
}
