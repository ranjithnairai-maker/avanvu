import { describe, expect, it } from 'vitest';
import { planProgram, recomputeGenerateAt } from './program';

const zone = 'America/Toronto';
const kinds = (items: ReturnType<typeof planProgram>, k: string) => items.filter((i) => i.kind === k);

describe('program proposal (SPEC §5.1)', () => {
  it('21+ days: two sessions a week on Tuesday and Saturday, then night before, primer, debrief', () => {
    const now = new Date('2026-10-20T15:00:00Z'); // Tuesday
    const startsAt = new Date('2026-12-13T13:00:00Z'); // Sunday 08:00 Toronto, 54 days away
    const items = planProgram({ startsAt, timeZone: zone, now });
    const training = kinds(items, 'training');
    expect(training.length).toBeGreaterThanOrEqual(14);
    for (const t of training) expect([2, 6]).toContain(new Date(`${t.target_date}T00:00:00Z`).getUTCDay());
    expect(training.every((t) => t.target_date > '2026-10-20' && t.target_date <= '2026-12-10')).toBe(true);
    expect(kinds(items, 'night_before')[0]).toMatchObject({ target_date: '2026-12-12' });
    expect(kinds(items, 'primer')[0]).toMatchObject({ target_date: '2026-12-13' });
    expect(kinds(items, 'debrief')[0]).toMatchObject({ target_date: '2026-12-14', generate_at: null });
  });

  it('honours custom training days', () => {
    const items = planProgram({
      startsAt: new Date('2026-12-13T13:00:00Z'),
      timeZone: zone,
      now: new Date('2026-10-20T15:00:00Z'),
      trainingDays: [1],
    });
    for (const t of kinds(items, 'training'))
      expect(new Date(`${t.target_date}T00:00:00Z`).getUTCDay()).toBe(1);
  });

  it('7-20 days: two to four evenly spread sessions', () => {
    const items = planProgram({
      startsAt: new Date('2026-11-03T13:00:00Z'),
      timeZone: zone,
      now: new Date('2026-10-20T15:00:00Z'),
    });
    const training = kinds(items, 'training');
    expect(training.length).toBeGreaterThanOrEqual(2);
    expect(training.length).toBeLessThanOrEqual(4);
    expect(new Set(training.map((t) => t.target_date)).size).toBe(training.length);
  });

  it('2-6 days: one or two sessions', () => {
    const six = planProgram({
      startsAt: new Date('2026-10-26T13:00:00Z'),
      timeZone: zone,
      now: new Date('2026-10-20T15:00:00Z'),
    });
    expect(kinds(six, 'training').length).toBe(2);
    const two = planProgram({
      startsAt: new Date('2026-10-22T20:00:00Z'),
      timeZone: zone,
      now: new Date('2026-10-20T15:00:00Z'),
    });
    expect(kinds(two, 'training').length).toBeLessThanOrEqual(1);
  });

  it('within a day: no training; special sessions are generated immediately', () => {
    const now = new Date('2026-10-20T15:00:00Z');
    const items = planProgram({ startsAt: new Date('2026-10-21T12:00:00Z'), timeZone: zone, now });
    expect(kinds(items, 'training')).toHaveLength(0);
    expect(kinds(items, 'primer')[0]?.generate_at).toEqual(now);
    expect(kinds(items, 'night_before')[0]?.generate_at).toEqual(now);
  });

  it('drops the night-before session once the evening before has passed', () => {
    const items = planProgram({
      startsAt: new Date('2026-10-21T12:00:00Z'), // 08:00 Toronto on the 21st
      timeZone: zone,
      now: new Date('2026-10-21T03:00:00Z'), // 23:00 on the 20th
    });
    expect(kinds(items, 'night_before')).toHaveLength(0);
    expect(kinds(items, 'primer')).toHaveLength(1);
  });

  it('generates special sessions 72 hours before the start when the event is further away', () => {
    const startsAt = new Date('2026-12-13T13:00:00Z');
    const items = planProgram({ startsAt, timeZone: zone, now: new Date('2026-10-20T15:00:00Z') });
    expect(kinds(items, 'primer')[0]?.generate_at).toEqual(new Date('2026-12-10T13:00:00Z'));
  });

  it('recomputes generate_at after an event change, only for special items', () => {
    const startsAt = new Date('2026-12-20T13:00:00Z');
    const now = new Date('2026-10-20T15:00:00Z');
    expect(recomputeGenerateAt('night_before', startsAt, now)).toEqual(new Date('2026-12-17T13:00:00Z'));
    expect(recomputeGenerateAt('training', startsAt, now)).toBeNull();
  });
});
