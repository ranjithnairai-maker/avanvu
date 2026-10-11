/**
 * Marks a value as sensitive (CONTRACTS §1, 🔒). A `Sensitive<T>` never serialises: JSON, string
 * conversion and inspection all yield a redaction marker, so passing one to a logger, an analytics call
 * or an error report cannot leak its content. The only way out is the explicit `reveal()` call, which
 * should appear only next to encryption or the model call that genuinely needs the value.
 */
const REDACTED = '[REDACTED]';

export class Sensitive<T> {
  readonly #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  reveal(): T {
    return this.#value;
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return REDACTED;
  }
}

export const sensitive = <T>(value: T): Sensitive<T> => new Sensitive(value);

export function isSensitive(v: unknown): v is Sensitive<unknown> {
  return v instanceof Sensitive;
}
