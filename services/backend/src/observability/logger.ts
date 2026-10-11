/**
 * Structured JSON logger (SPEC §11.5). Raw athlete text, prompts, model outputs, signed URLs and tokens
 * are never logged: values under sensitive key names are redacted, `Sensitive<T>` values are refused, and
 * only primitives are accepted as fields. Use this instead of console (ESLint forbids console).
 */
import { isSensitive } from '@avanvu/core';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, string | number | boolean | null | undefined>;

/** Key names whose values must never be written, whatever they contain. */
const SENSITIVE_KEY =
  /content|text|prompt|transcript|message|answer|note|name|email|token|secret|password|authorization|cookie|signed|url|key|phone|cue|intention|script|timeline|profile|body/i;

/** Keys that look sensitive but are safe identifiers or counters. */
const SAFE_KEYS = new Set([
  'request_id',
  'idempotency_key',
  'error_code',
  'client_message_id',
  'key_version',
  'dispatch_generation',
  'message_count',
  'content_length',
  'text_length',
]);

export interface LogSink {
  write(line: string): void;
}

const defaultSink: LogSink = { write: (line) => process.stdout.write(`${line}\n`) };

export class Logger {
  constructor(
    private readonly base: LogFields = {},
    private readonly sink: LogSink = defaultSink,
    private readonly minLevel: LogLevel = 'info',
  ) {}

  child(fields: LogFields): Logger {
    return new Logger({ ...this.base, ...fields }, this.sink, this.minLevel);
  }

  debug(event: string, fields?: LogFields): void {
    this.log('debug', event, fields);
  }
  info(event: string, fields?: LogFields): void {
    this.log('info', event, fields);
  }
  warn(event: string, fields?: LogFields): void {
    this.log('warn', event, fields);
  }
  error(event: string, fields?: LogFields): void {
    this.log('error', event, fields);
  }

  private log(level: LogLevel, event: string, fields: LogFields = {}): void {
    const order: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    if (order.indexOf(level) < order.indexOf(this.minLevel)) return;
    const out: Record<string, unknown> = { ts: new Date().toISOString(), level, event };
    for (const [k, v] of Object.entries({ ...this.base, ...fields })) out[k] = scrub(k, v);
    this.sink.write(JSON.stringify(out));
  }
}

export function scrub(key: string, value: unknown): unknown {
  if (isSensitive(value)) return '[REDACTED]';
  if (value === null || value === undefined) return value;
  if (SENSITIVE_KEY.test(key) && !SAFE_KEYS.has(key)) return '[REDACTED]';
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 120 ? '[TRUNCATED]' : value;
  return '[UNSUPPORTED]'; // objects and arrays are never logged
}
