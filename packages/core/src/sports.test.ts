import { describe, expect, it } from 'vitest';
import { SPORTS, getSport, isCustomEnduranceEligible, searchSports } from './sports';
import { sanitizeEvent } from './analytics';
import { AvanvuError } from './errors';

describe('sports registry', () => {
  it('has unique ids and a valid engine for each sport', () => {
    expect(new Set(SPORTS.map((x) => x.id)).size).toBe(SPORTS.length);
    expect(getSport('golf')?.engine).toBe('closed_skill_v1');
    expect(getSport('triathlon')?.engine).toBe('endurance_v1');
    expect(getSport('curling')).toBeUndefined();
  });

  it('searches by label and alias', () => {
    expect(searchSports('ironman').map((x) => x.id)).toContain('triathlon');
    expect(searchSports('xyz')).toEqual([]);
  });

  it('requires all four custom endurance answers to be yes', () => {
    expect(isCustomEnduranceEligible([true, true, true, true])).toBe(true);
    expect(isCustomEnduranceEligible([true, true, false, true])).toBe(false);
    expect(isCustomEnduranceEligible([true, true, true])).toBe(false);
  });
});

describe('analytics allowlist', () => {
  it('accepts allowlisted events with bounded props', () => {
    expect(sanitizeEvent('app_opened', { cold_start: true })).not.toBeNull();
    expect(sanitizeEvent('session_ready', { context: 'training', seconds_to_ready: 90 })).not.toBeNull();
  });
  it('rejects unknown events and free text', () => {
    expect(sanitizeEvent('page_view', {})).toBeNull();
    expect(sanitizeEvent('notification_opened', { kind: 'My cue phrase is steady' })).toBeNull();
    expect(sanitizeEvent('intake_summary_shown', { turns: 3.5, minutes: 1 })).toBeNull();
  });
});

describe('error contract', () => {
  it('serialises with status and retryability', () => {
    const e = new AvanvuError('RATE_LIMITED', 'Slow down.', { retryAfterMs: 2000 });
    expect(e.http).toBe(429);
    expect(e.toBody('req_1')).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: 'Slow down.',
        retryable: true,
        request_id: 'req_1',
        retry_after_ms: 2000,
      },
    });
  });
});
