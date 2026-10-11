/**
 * Analytics wrapper (CONTRACTS §13, CLAUDE.md non-negotiable 3). Typed at compile time to the allowlist and
 * re-checked at runtime with `sanitizeEvent`; anything else is dropped and reported to Sentry by event name only.
 * Events are sent only with the athlete's analytics consent. The distinct id is the server-issued `analytics_id`,
 * never the auth user id, email or Apple identifier. Autocapture and session replay stay off globally.
 */
import { sanitizeEvent, type AnalyticsEventName, type AnalyticsEvents } from '@avanvu/core';

export interface AnalyticsSink {
  capture(distinctId: string, event: string, props: Record<string, string | number | boolean>): void;
}

export interface AnalyticsOptions {
  sink: AnalyticsSink;
  /** The athlete's optional analytics consent (separate from required processing consent). */
  hasConsent: () => boolean;
  distinctId: () => string | null;
  /** Reports a dropped event by name only; never props. */
  onDropped: (eventName: string) => void;
}

export class Analytics {
  constructor(private readonly o: AnalyticsOptions) {}

  track<E extends AnalyticsEventName>(
    name: E,
    ...props: AnalyticsEvents[E] extends Record<string, never> ? [] : [AnalyticsEvents[E]]
  ): void {
    if (!this.o.hasConsent()) return;
    const id = this.o.distinctId();
    if (!id) return;
    const clean = sanitizeEvent(name, (props[0] ?? {}) as Record<string, unknown>);
    if (!clean) {
      this.o.onDropped(name);
      return;
    }
    this.o.sink.capture(id, clean.name, clean.props);
  }
}

/** Placeholder sink until the PostHog adapter is added (needs the project key): drops everything. */
export const noopSink: AnalyticsSink = { capture: () => undefined };
