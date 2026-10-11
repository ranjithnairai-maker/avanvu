import { describe, expect, it } from 'vitest';
import {
  available,
  availableForOnDemand,
  proBucketFor,
  trialConversionTopUp,
  type LedgerEntry,
} from './ledger';

const d = (s: string) => new Date(s);

describe('pro buckets', () => {
  const anchor = d('2026-01-31T15:30:00Z');

  it('uses the last day of short months at the anchor time', () => {
    const b = proBucketFor(anchor, d('2026-02-28T16:00:00Z'));
    expect(b.start.toISOString()).toBe('2026-02-28T15:30:00.000Z');
    expect(b.end.toISOString()).toBe('2026-03-31T15:30:00.000Z');
  });

  it('is half-open: the boundary instant belongs to the next bucket', () => {
    const next = proBucketFor(anchor, d('2026-03-31T15:30:00Z'));
    expect(next.index).toBe(2);
    const before = proBucketFor(anchor, d('2026-03-31T15:29:59Z'));
    expect(before.index).toBe(1);
  });

  it('starts at the anchor and rejects earlier instants', () => {
    expect(proBucketFor(anchor, anchor).index).toBe(0);
    expect(() => proBucketFor(anchor, d('2026-01-30T00:00:00Z'))).toThrow();
  });
});

describe('availability', () => {
  const start = d('2026-02-01T00:00:00Z');
  const entry = (quantity: number, entry_type: LedgerEntry['entry_type']): LedgerEntry => ({
    allowance_type: 'pro',
    bucket_start: start,
    bucket_end: d('2026-03-01T00:00:00Z'),
    entry_type,
    quantity,
    session_id: null,
    idempotency_key: `${entry_type}:${quantity}:${Math.random()}`,
  });

  it('sums grants, reservations and reversals; commit is audit-only', () => {
    const e = [
      entry(12, 'grant'),
      entry(-1, 'reserve'),
      entry(-1, 'reserve'),
      entry(1, 'reverse'),
      entry(0, 'commit'),
    ];
    expect(available(e, 'pro', start)).toBe(11);
    expect(available(e, 'free_primer', start)).toBe(0);
  });

  it('holds sessions for upcoming events and never goes negative', () => {
    expect(availableForOnDemand(11, 2)).toBe(9);
    expect(availableForOnDemand(1, 3)).toBe(0);
  });

  it('computes the trial conversion top-up', () => {
    expect(trialConversionTopUp(12, 3)).toBe(9);
    expect(trialConversionTopUp(12, 20)).toBe(0);
  });
});
