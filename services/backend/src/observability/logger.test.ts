import { describe, expect, it } from 'vitest';
import { sensitive } from '@avanvu/core';
import { Logger } from './logger';

function capture() {
  const lines: string[] = [];
  return { lines, logger: new Logger({ service: 'api' }, { write: (l) => lines.push(l) }, 'debug') };
}

const SECRET = 'my cue phrase is Smooth and steady';

describe('logger redaction', () => {
  it('redacts values under sensitive key names', () => {
    const { lines, logger } = capture();
    logger.info('intake_turn', {
      content: SECRET,
      assistant_message: SECRET,
      signed_url: 'https://x/y?token=abc',
      authorization: 'Bearer abc',
      user_email: 'a@b.c',
      request_id: 'req_1',
      error_code: 'RATE_LIMITED',
    });
    const out = lines.join('');
    expect(out).not.toContain('Smooth');
    expect(out).not.toContain('Bearer');
    expect(out).not.toContain('a@b.c');
    expect(out).toContain('req_1');
    expect(out).toContain('RATE_LIMITED');
  });

  it('refuses Sensitive values and objects', () => {
    const { lines, logger } = capture();
    logger.info('x', {
      note: sensitive(SECRET) as never,
      thing: { a: SECRET } as never,
      list: [SECRET] as never,
    });
    const out = lines.join('');
    expect(out).not.toContain('Smooth');
    expect(out).toContain('[UNSUPPORTED]');
  });

  it('truncates long strings under innocent keys', () => {
    const { lines, logger } = capture();
    logger.info('x', { detail: 'a'.repeat(500) });
    expect(lines.join('')).toContain('[TRUNCATED]');
  });

  it('Sensitive never serialises through JSON, string or template literals', () => {
    const s = sensitive(SECRET);
    expect(JSON.stringify({ s })).toBe('{"s":"[REDACTED]"}');
    expect(`${s}`).toBe('[REDACTED]');
    expect(s.reveal()).toBe(SECRET);
  });

  it('respects the minimum level and carries child fields', () => {
    const lines: string[] = [];
    const logger = new Logger({}, { write: (l) => lines.push(l) }, 'warn').child({ request_id: 'r1' });
    logger.info('hidden');
    logger.error('shown');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'shown', request_id: 'r1', level: 'error' });
  });
});
