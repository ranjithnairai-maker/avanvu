/**
 * Local notifications (SPEC §9.6, D-09): scheduled on the device from the pure plan in core, so they fire offline
 * and in the event's time zone with no server involvement. Deterministic ids mean rescheduling replaces. Copy is
 * fixed and contains no athlete text. Permission is requested only from the education screen.
 */
import * as Notifications from 'expo-notifications';
import { allNotificationIds, planLocalNotifications } from '@avanvu/core';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

export type PermissionState = 'granted' | 'denied' | 'undetermined';

export async function notificationPermission(): Promise<PermissionState> {
  const p = await Notifications.getPermissionsAsync();
  return p.granted ? 'granted' : p.canAskAgain ? 'undetermined' : 'denied';
}

/** Called after the athlete taps "Turn on reminders" on the education screen. */
export async function requestNotificationPermission(): Promise<boolean> {
  const p = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowSound: false, allowBadge: false },
  });
  return p.granted;
}

export interface ScheduledEvent {
  id: string;
  starts_local: string;
  time_zone: string;
}

/** Replace all of an event's reminders with the current plan (also used after an event edit). */
export async function scheduleEventReminders(
  event: ScheduledEvent | null,
  previousEventId?: string,
): Promise<number> {
  for (const id of [
    ...allNotificationIds(event?.id ?? ''),
    ...(previousEventId ? allNotificationIds(previousEventId) : []),
  ]) {
    await Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined);
  }
  if (!event) return 0;
  if ((await notificationPermission()) !== 'granted') return 0;
  const plan = planLocalNotifications({
    eventId: event.id,
    startsLocal: event.starts_local,
    timeZone: event.time_zone,
    now: new Date(),
  });
  for (const n of plan) {
    await Notifications.scheduleNotificationAsync({
      identifier: n.id,
      content: { title: n.title, body: n.body, data: { kind: n.kind, event_id: event.id } },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: n.fireAt },
    });
  }
  return plan.length;
}

/** Push token for the ready and readiness pushes; registered with POST /v1/devices. */
export async function getPushToken(): Promise<string | null> {
  try {
    if ((await notificationPermission()) !== 'granted') return null;
    return (await Notifications.getExpoPushTokenAsync()).data;
  } catch {
    return null;
  }
}
