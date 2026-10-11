import { describe, expect, it } from 'vitest';
import { canTransition, clientStatus, IN_PROGRESS_STATES, SESSION_STATES } from './sessionState';

describe('session state machine', () => {
  it('moves forward through the pipeline', () => {
    const order = [
      'reserved',
      'queued',
      'generating_script',
      'validating',
      'synthesizing',
      'mixing',
      'uploading',
      'ready',
    ] as const;
    for (let i = 0; i < order.length - 1; i++) expect(canTransition(order[i]!, order[i + 1]!)).toBe(true);
  });

  it('allows canceling only before generation starts', () => {
    expect(canTransition('reserved', 'canceled')).toBe(true);
    expect(canTransition('queued', 'canceled')).toBe(true);
    expect(canTransition('generating_script', 'canceled')).toBe(false);
    expect(canTransition('synthesizing', 'canceled')).toBe(false);
  });

  it('fails from any non-terminal state and never leaves a terminal one', () => {
    for (const s of IN_PROGRESS_STATES) expect(canTransition(s, 'failed')).toBe(true);
    for (const t of ['ready', 'failed', 'canceled'] as const) {
      for (const s of SESSION_STATES) expect(canTransition(t, s)).toBe(false);
    }
  });

  it('does not skip stages, and a retry may resume at an earlier stage', () => {
    expect(canTransition('queued', 'synthesizing')).toBe(false);
    expect(canTransition('validating', 'ready')).toBe(false);
    expect(canTransition('synthesizing', 'generating_script')).toBe(true);
    expect(canTransition('mixing', 'synthesizing')).toBe(true);
  });

  it('simplifies states for the client', () => {
    expect(clientStatus('queued')).toBe('preparing');
    expect(clientStatus('validating')).toBe('preparing');
    expect(clientStatus('mixing')).toBe('voicing');
    expect(clientStatus('ready')).toBe('ready');
  });
});
