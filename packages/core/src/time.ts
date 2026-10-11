/**
 * Event time handling (CONTRACTS §1): events store a local start plus an IANA time zone, never a bare local
 * date. Conversion uses Intl only, so it works unchanged on the server and in Hermes.
 */
export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone.includes('/') || zone === 'UTC';
  } catch {
    return false;
  }
}

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export function parseLocal(local: string): LocalParts {
  const m = LOCAL.exec(local);
  if (!m) throw new Error('Expected local time as YYYY-MM-DDTHH:mm');
  const [year, month, day, hour, minute] = m.slice(1).map(Number) as [number, number, number, number, number];
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59
  ) {
    throw new Error('Not a real calendar time');
  }
  return { year, month, day, hour, minute };
}

/** Offset of `zone` from UTC at an instant, in milliseconds (positive east of UTC). */
export function zoneOffsetMs(instant: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * Local wall time in an IANA zone to a UTC instant. In a spring-forward gap the time moves forward by the
 * gap (02:30 becomes 03:30); for an ambiguous autumn hour the earlier (daylight) instant is used.
 */
export function zonedLocalToUtc(local: string, zone: string): Date {
  const p = parseLocal(local);
  const naive = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const DAY = 86_400_000;
  const before = zoneOffsetMs(new Date(naive - DAY), zone);
  const after = zoneOffsetMs(new Date(naive + DAY), zone);
  const candidates = [...new Set([naive - before, naive - after])].sort((a, b) => a - b);
  const valid = candidates.filter((c) => c + zoneOffsetMs(new Date(c), zone) === naive);
  if (valid.length > 0) return new Date(valid[0] as number);
  return new Date(naive - before); // gap: apply the pre-transition offset
}

/** The local date part (YYYY-MM-DD) of an instant in a zone. */
export function localDateIn(instant: Date, zone: string): string {
  const d = new Date(instant.getTime() + zoneOffsetMs(instant, zone));
  return d.toISOString().slice(0, 10);
}

export const MAX_EVENT_MONTHS_AHEAD = 12;

export function addMonthsUtc(d: Date, months: number): Date {
  const out = new Date(d.getTime());
  out.setUTCMonth(out.getUTCMonth() + months);
  return out;
}
