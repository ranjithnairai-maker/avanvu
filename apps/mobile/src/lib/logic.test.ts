import { describe, expect, it, vi } from 'vitest';
import { Analytics } from './analytics';
import {
  planOfflineSync,
  offlineBadge,
  matchesExpected,
  needsOfflineAttention,
  storageSummary,
  type LocalFile,
  type RemoteSession,
} from './offline/sync';
import { PlayRecorder, crossedMarks, type Mark } from './player/plays';

describe('play marks (SPEC §6.5)', () => {
  it('records start once, then each percent mark once per play-through', () => {
    let n = 0;
    const r = new PlayRecorder(
      () => `e${++n}`,
      () => new Date('2026-10-20T15:00:00Z'),
    );
    expect(r.update(0, 600_000)).toEqual([]);
    expect(r.update(1000, 600_000)).toEqual(['start']);
    expect(r.update(2000, 600_000)).toEqual([]);
    expect(r.update(150_000, 600_000)).toEqual(['25']);
    expect(r.update(151_000, 600_000)).toEqual([]);
    expect(r.update(500_000, 600_000)).toEqual(['50', '80']); // seeking forward still records each crossed mark
    expect(r.update(599_000, 600_000)).toEqual(['100']);
    expect(r.pending().map((e) => e.mark)).toEqual(['start', '25', '50', '80', '100']);
  });

  it('starts a fresh play-through on reset and batches with acknowledgement', () => {
    let n = 0;
    const r = new PlayRecorder(() => `e${++n}`);
    r.update(10, 1000);
    r.update(300, 1000);
    const batch = r.batch(1);
    expect(batch).toHaveLength(1);
    r.ack(batch);
    expect(r.pending()).toHaveLength(1);
    r.reset();
    expect(r.update(10, 1000)).toEqual(['start']);
    // Unacknowledged events survive (for example a restart): they are replayed with the same ids.
    const restored = new PlayRecorder(
      () => 'x',
      () => new Date(),
      r.pending(),
    );
    expect(restored.pending().map((e) => e.client_event_id)).toEqual(
      r.pending().map((e) => e.client_event_id),
    );
  });

  it('prompts the check-in only once at least half has played', () => {
    expect(PlayRecorder.shouldPromptCheckin(299_000, 600_000)).toBe(false);
    expect(PlayRecorder.shouldPromptCheckin(300_000, 600_000)).toBe(true);
    expect(crossedMarks(0, 1000, new Set<Mark>())).toEqual([]);
  });
});

const rs = (over: Partial<RemoteSession> & { id: string }): RemoteSession => ({
  context: 'training',
  state: 'ready',
  sha256: 'a'.repeat(64),
  bytes: 1000,
  readyAt: '2026-10-20T10:00:00Z',
  forUpcomingSpecial: false,
  ...over,
});
const lf = (over: Partial<LocalFile> & { id: string }): LocalFile => ({
  sha256: 'a'.repeat(64),
  bytes: 1000,
  verified: true,
  reported: true,
  ...over,
});

describe('offline sync planner (SPEC §6.6)', () => {
  it('downloads special sessions and only the latest training session', () => {
    const remote = [
      rs({ id: 't1', readyAt: '2026-10-01T10:00:00Z' }),
      rs({ id: 't2', readyAt: '2026-10-10T10:00:00Z' }),
      rs({ id: 'nb', context: 'night_before', forUpcomingSpecial: true }),
      rs({ id: 'pr', context: 'primer', forUpcomingSpecial: true }),
      rs({ id: 'busy', state: 'synthesizing' }),
      rs({ id: 'old-primer', context: 'primer', forUpcomingSpecial: false }),
    ];
    expect(planOfflineSync(remote, []).download.sort()).toEqual(['nb', 'pr', 't2']);
  });

  it('reports verified downloads once, discards corrupt or stale files, and removes deleted sessions', () => {
    const remote = [
      rs({ id: 'a' }),
      rs({ id: 'nb', context: 'night_before', forUpcomingSpecial: true, sha256: 'b'.repeat(64) }),
      rs({ id: 'gone', state: 'canceled' }),
    ];
    const local = [
      lf({ id: 'a', reported: false }),
      lf({ id: 'nb' }), // hash differs from the server: re-render happened
      lf({ id: 'deleted-on-server' }),
      lf({ id: 'gone' }),
    ];
    const plan = planOfflineSync(remote, local);
    expect(plan.report).toEqual(['a']);
    expect(plan.discard).toEqual(['nb']);
    expect(plan.download).toEqual(['nb']);
    expect(plan.remove.sort()).toEqual(['deleted-on-server', 'gone']);
    expect(planOfflineSync(remote.slice(0, 1), [lf({ id: 'a', verified: false })]).discard).toEqual(['a']);
  });

  it('shows the right badge and summarises storage', () => {
    const s = rs({ id: 'a' });
    expect(offlineBadge(s, lf({ id: 'a' }), new Set())).toBe('ready_offline');
    expect(offlineBadge(s, undefined, new Set())).toBe('online_only');
    expect(offlineBadge(s, undefined, new Set(['a']))).toBe('downloading');
    expect(offlineBadge({ ...s, state: 'queued' }, undefined, new Set())).toBe('preparing');
    expect(offlineBadge(s, lf({ id: 'a', sha256: 'c'.repeat(64) }), new Set())).toBe('online_only');
    expect(storageSummary([lf({ id: 'a' }), lf({ id: 'b', bytes: 500 })])).toEqual({ files: 2, bytes: 1500 });
  });

  it('verifies hash and length, and flags a missing special session when the event is near', () => {
    expect(
      matchesExpected({ sha256: 'A'.repeat(64), bytes: 1000 }, { sha256: 'a'.repeat(64), bytes: 1000 }),
    ).toBe(true);
    expect(
      matchesExpected({ sha256: 'a'.repeat(64), bytes: 999 }, { sha256: 'a'.repeat(64), bytes: 1000 }),
    ).toBe(false);
    expect(matchesExpected({ sha256: 'a'.repeat(64), bytes: 1 }, { sha256: null, bytes: null })).toBe(false);
    const now = new Date('2026-10-20T12:00:00Z');
    const soon = new Date('2026-10-22T12:00:00Z');
    expect(needsOfflineAttention(soon, now, [{ id: 'nb', state: 'ready' }], [])).toBe(true);
    expect(needsOfflineAttention(soon, now, [{ id: 'nb', state: 'ready' }], [lf({ id: 'nb' })])).toBe(false);
    expect(
      needsOfflineAttention(new Date('2026-11-20T12:00:00Z'), now, [{ id: 'nb', state: 'ready' }], []),
    ).toBe(false);
    expect(needsOfflineAttention(soon, now, [{ id: 'nb', state: 'queued' }], [])).toBe(false);
  });
});

describe('analytics wrapper (CONTRACTS §13)', () => {
  function make(consent = true, id: string | null = 'anon-1') {
    const sink = { capture: vi.fn() };
    const dropped = vi.fn();
    return {
      sink,
      dropped,
      a: new Analytics({ sink, hasConsent: () => consent, distinctId: () => id, onDropped: dropped }),
    };
  }

  it('sends allowlisted events with bounded properties under the analytics id', () => {
    const { a, sink } = make();
    a.track('session_ready', { context: 'training', seconds_to_ready: 95 });
    a.track('intake_started');
    expect(sink.capture).toHaveBeenNthCalledWith(1, 'anon-1', 'session_ready', {
      context: 'training',
      seconds_to_ready: 95,
    });
    expect(sink.capture).toHaveBeenNthCalledWith(2, 'anon-1', 'intake_started', {});
  });

  it('sends nothing without consent or without an analytics id', () => {
    const a = make(false);
    a.a.track('app_opened', { cold_start: true });
    const b = make(true, null);
    b.a.track('app_opened', { cold_start: true });
    expect(a.sink.capture).not.toHaveBeenCalled();
    expect(b.sink.capture).not.toHaveBeenCalled();
  });

  it('drops free text at runtime and reports the event name only', () => {
    const { a, sink, dropped } = make();
    // A caller that bypasses the types (for example through `any`) still cannot leak text.
    (a as unknown as { track: (n: string, p: object) => void }).track('notification_opened', {
      kind: 'My cue phrase is steady',
    });
    expect(sink.capture).not.toHaveBeenCalled();
    expect(dropped).toHaveBeenCalledWith('notification_opened');
    expect(JSON.stringify(dropped.mock.calls)).not.toContain('steady');
  });
});
