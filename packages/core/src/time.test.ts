import { describe, expect, it } from 'vitest';
import { isValidTimeZone, localDateIn, parseLocal, zonedLocalToUtc } from './time';

describe('time zones', () => {
  it('validates IANA names', () => {
    expect(isValidTimeZone('America/Toronto')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('EST5EDT')).toBe(false); // abbreviations and legacy aliases are not accepted
  });

  it('parses and rejects malformed local times', () => {
    expect(parseLocal('2027-01-10T08:30')).toEqual({ year: 2027, month: 1, day: 10, hour: 8, minute: 30 });
    expect(() => parseLocal('2027-02-30T08:00')).toThrow();
    expect(() => parseLocal('2027-01-10 08:00')).toThrow();
    expect(() => parseLocal('2027-01-10T24:00')).toThrow();
  });

  it('converts winter and summer local times with the right offset', () => {
    expect(zonedLocalToUtc('2027-01-10T08:00', 'America/Toronto').toISOString()).toBe(
      '2027-01-10T13:00:00.000Z',
    );
    expect(zonedLocalToUtc('2027-07-10T08:00', 'America/Toronto').toISOString()).toBe(
      '2027-07-10T12:00:00.000Z',
    );
    expect(zonedLocalToUtc('2027-07-10T08:00', 'Australia/Sydney').toISOString()).toBe(
      '2027-07-09T22:00:00.000Z',
    );
    expect(zonedLocalToUtc('2027-07-10T08:00', 'Asia/Kolkata').toISOString()).toBe(
      '2027-07-10T02:30:00.000Z',
    );
  });

  it('handles the spring-forward gap by moving forward', () => {
    // 2027-03-14 02:30 does not exist in Toronto; clocks jump from 02:00 to 03:00 (EDT, UTC-4).
    expect(zonedLocalToUtc('2027-03-14T02:30', 'America/Toronto').toISOString()).toBe(
      '2027-03-14T07:30:00.000Z',
    );
  });

  it('picks the earlier instant for the ambiguous autumn hour', () => {
    // 2027-11-07 01:30 happens twice in Toronto; the first is EDT (UTC-4) = 05:30Z.
    expect(zonedLocalToUtc('2027-11-07T01:30', 'America/Toronto').toISOString()).toBe(
      '2027-11-07T05:30:00.000Z',
    );
  });

  it('computes the local date of an instant', () => {
    expect(localDateIn(new Date('2027-01-11T03:00:00Z'), 'America/Toronto')).toBe('2027-01-10');
    expect(localDateIn(new Date('2027-01-11T03:00:00Z'), 'Asia/Kolkata')).toBe('2027-01-11');
  });
});
