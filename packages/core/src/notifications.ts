/**
 * Local notification plan (SPEC §9.6, D-09). Reminders are scheduled on the device so they fire offline and in the
 * event's time zone, with deterministic ids per event so rescheduling never duplicates. The copy is fixed and
 * contains no athlete text.
 */
import { localDateIn, zonedLocalToUtc } from './time';

export type LocalNotificationKind = 'night_before' | 'primer' | 'debrief';

export interface PlannedNotification {
  /** Deterministic: rescheduling replaces rather than duplicates. */
  id: string;
  kind: LocalNotificationKind;
  fireAt: Date;
  title: string;
  body: string;
}

const COPY: Record<LocalNotificationKind, { title: string; body: string }> = {
  night_before: { title: "Tonight's session", body: 'Your night-before session is ready when you are.' },
  primer: { title: 'Your pre-event primer', body: 'A few minutes to get ready.' },
  debrief: { title: 'How did it go?', body: 'Take three minutes to capture what you learned.' },
};

export const notificationId = (eventId: string, kind: LocalNotificationKind): string =>
  `avanvu:${eventId}:${kind}`;

const shiftDays = (isoDate: string, n: number): string => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export interface PlanInput {
  eventId: string;
  /** Event start as stored: local wall time plus zone. */
  startsLocal: string;
  timeZone: string;
  now: Date;
}

/**
 * Night-before reminder at 19:00 local the evening before; primer reminder 60 minutes before the start but not
 * earlier than 05:30 local; debrief prompt at 09:00 local the day after. Items already in the past are dropped.
 */
export function planLocalNotifications(i: PlanInput): PlannedNotification[] {
  const startsAt = zonedLocalToUtc(i.startsLocal, i.timeZone);
  const eventDate = localDateIn(startsAt, i.timeZone);
  const items: PlannedNotification[] = [];

  items.push({
    id: notificationId(i.eventId, 'night_before'),
    kind: 'night_before',
    fireAt: zonedLocalToUtc(`${shiftDays(eventDate, -1)}T19:00`, i.timeZone),
    ...COPY.night_before,
  });

  const sixty = new Date(startsAt.getTime() - 60 * 60_000);
  const earliest = zonedLocalToUtc(`${eventDate}T05:30`, i.timeZone);
  items.push({
    id: notificationId(i.eventId, 'primer'),
    kind: 'primer',
    fireAt: sixty < earliest ? earliest : sixty,
    ...COPY.primer,
  });

  items.push({
    id: notificationId(i.eventId, 'debrief'),
    kind: 'debrief',
    fireAt: zonedLocalToUtc(`${shiftDays(eventDate, 1)}T09:00`, i.timeZone),
    ...COPY.debrief,
  });

  // A primer before the start would be pointless once the event has begun.
  return items.filter((n) => n.fireAt > i.now && (n.kind !== 'primer' || n.fireAt < startsAt));
}

/** Ids to cancel when an event changes or is removed: all three kinds, planned or not. */
export const allNotificationIds = (eventId: string): string[] =>
  (['night_before', 'primer', 'debrief'] as const).map((k) => notificationId(eventId, k));
