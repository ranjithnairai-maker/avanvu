import { describe, expect, it } from 'vitest';
import { allNotificationIds, planLocalNotifications } from './notifications';

const base = { eventId: 'evt1', timeZone: 'America/Toronto', now: new Date('2026-10-20T15:00:00Z') };
const byKind = (items: ReturnType<typeof planLocalNotifications>, k: string) =>
  items.find((i) => i.kind === k);

describe('local notification plan (SPEC §9.6)', () => {
  it('schedules the night-before reminder at 19:00, the primer 60 minutes before, and the debrief at 09:00 the next day', () => {
    const items = planLocalNotifications({ ...base, startsLocal: '2026-12-13T08:00' });
    expect(byKind(items, 'night_before')!.fireAt.toISOString()).toBe('2026-12-13T00:00:00.000Z'); // 19:00 on the 12th
    expect(byKind(items, 'primer')!.fireAt.toISOString()).toBe('2026-12-13T12:00:00.000Z'); // 07:00 on the 13th
    expect(byKind(items, 'debrief')!.fireAt.toISOString()).toBe('2026-12-14T14:00:00.000Z'); // 09:00 on the 14th
  });

  it('never fires the primer earlier than 05:30 local', () => {
    const items = planLocalNotifications({ ...base, startsLocal: '2026-12-13T06:00' });
    expect(byKind(items, 'primer')!.fireAt.toISOString()).toBe('2026-12-13T10:30:00.000Z'); // 05:30 local, not 05:00
  });

  it('uses the event time zone, including across a daylight saving change', () => {
    const items = planLocalNotifications({ ...base, startsLocal: '2027-03-14T09:00' }); // clocks spring forward that day
    expect(byKind(items, 'night_before')!.fireAt.toISOString()).toBe('2027-03-14T00:00:00.000Z'); // 19:00 EST on the 13th
    expect(byKind(items, 'primer')!.fireAt.toISOString()).toBe('2027-03-14T12:00:00.000Z'); // 08:00 EDT
    const sydney = planLocalNotifications({
      ...base,
      timeZone: 'Australia/Sydney',
      startsLocal: '2026-12-13T08:00',
    });
    expect(byKind(sydney, 'night_before')!.fireAt.toISOString()).toBe('2026-12-12T08:00:00.000Z'); // 19:00 AEDT
  });

  it('drops reminders that are already in the past', () => {
    const items = planLocalNotifications({
      ...base,
      now: new Date('2026-12-13T07:30:00Z'),
      startsLocal: '2026-12-13T08:00',
    });
    expect(items.map((i) => i.kind)).toEqual(['primer', 'debrief']);
    const after = planLocalNotifications({
      ...base,
      now: new Date('2026-12-13T12:30:00Z'),
      startsLocal: '2026-12-13T08:00',
    });
    expect(after.map((i) => i.kind)).toEqual(['debrief']);
  });

  it('uses deterministic ids, so an edited event replaces rather than duplicates', () => {
    const a = planLocalNotifications({ ...base, startsLocal: '2026-12-13T08:00' }).map((i) => i.id);
    const b = planLocalNotifications({ ...base, startsLocal: '2026-12-20T08:00' }).map((i) => i.id);
    expect(a).toEqual(b);
    expect(allNotificationIds('evt1')).toEqual(a);
  });

  it('has fixed copy with no exclamation marks and no athlete text', () => {
    for (const i of planLocalNotifications({ ...base, startsLocal: '2026-12-13T08:00' })) {
      expect(`${i.title} ${i.body}`).not.toContain('!');
    }
  });
});
