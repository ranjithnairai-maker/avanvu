/**
 * Playback marks recorded locally and synced in batches (SPEC §6.5): start, then 25, 50, 80 and 100 percent.
 * Pure, so the rules (each mark once per play-through, seeking forward still records each crossed mark,
 * batches survive restarts) are tested off-device. No haptics and no UI here.
 */
export type Mark = 'start' | '25' | '50' | '80' | '100';
const PERCENT_MARKS: { mark: Exclude<Mark, 'start'>; at: number }[] = [
  { mark: '25', at: 0.25 },
  { mark: '50', at: 0.5 },
  { mark: '80', at: 0.8 },
  { mark: '100', at: 0.99 }, // the player stops a hair before the exact end
];

export interface PlayEvent {
  client_event_id: string;
  mark: Mark;
  position_ms: number;
  occurred_at: string;
}

/** Marks newly crossed when the position moves, given the ones already recorded in this play-through. */
export function crossedMarks(positionMs: number, durationMs: number, recorded: ReadonlySet<Mark>): Mark[] {
  if (durationMs <= 0 || positionMs <= 0) return [];
  const out: Mark[] = [];
  if (!recorded.has('start')) out.push('start');
  const ratio = positionMs / durationMs;
  for (const p of PERCENT_MARKS) if (ratio >= p.at && !recorded.has(p.mark)) out.push(p.mark);
  return out;
}

export class PlayRecorder {
  private recorded = new Set<Mark>();
  private queue: PlayEvent[] = [];

  constructor(
    private readonly newId: () => string,
    private readonly now: () => Date = () => new Date(),
    restored: PlayEvent[] = [],
  ) {
    this.queue = [...restored];
  }

  /** A new play-through (the athlete pressed play from the start, or replayed). */
  reset(): void {
    this.recorded = new Set();
  }

  update(positionMs: number, durationMs: number): Mark[] {
    const marks = crossedMarks(positionMs, durationMs, this.recorded);
    for (const m of marks) {
      this.recorded.add(m);
      this.queue.push({
        client_event_id: this.newId(),
        mark: m,
        position_ms: Math.round(positionMs),
        occurred_at: this.now().toISOString(),
      });
    }
    return marks;
  }

  /** The next batch to send (up to 50 per request). Sent events stay queued until acknowledged. */
  batch(max = 50): PlayEvent[] {
    return this.queue.slice(0, max);
  }

  ack(sent: readonly PlayEvent[]): void {
    const done = new Set(sent.map((e) => e.client_event_id));
    this.queue = this.queue.filter((e) => !done.has(e.client_event_id));
  }

  pending(): PlayEvent[] {
    return [...this.queue];
  }

  /** The 80 percent mark triggers the check-in prompt on leaving the player (SPEC §5.5: at least half played). */
  static shouldPromptCheckin(positionMs: number, durationMs: number): boolean {
    return durationMs > 0 && positionMs / durationMs >= 0.5;
  }
}
