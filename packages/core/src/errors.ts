/** Error contract (CONTRACTS §10). `message` is safe to show to the athlete; vendor text never is. */
export const ERROR_CODES = {
  UNAUTHENTICATED: { http: 401, retryable: false },
  ACCOUNT_DELETED: { http: 401, retryable: false },
  AGE_REQUIREMENT_NOT_MET: { http: 403, retryable: false },
  FORBIDDEN: { http: 403, retryable: false },
  NOT_FOUND: { http: 404, retryable: false },
  VALIDATION_FAILED: { http: 422, retryable: false },
  UNSUPPORTED_SPORT: { http: 422, retryable: false },
  IDEMPOTENCY_KEY_REUSED: { http: 409, retryable: false },
  REQUEST_IN_PROGRESS: { http: 409, retryable: true },
  PROFILE_REVISION_CONFLICT: { http: 409, retryable: false },
  TURN_IN_PROGRESS: { http: 409, retryable: true },
  SAFETY_INTERRUPTED: { http: 409, retryable: false },
  MINIMUM_PROFILE_INCOMPLETE: { http: 422, retryable: false },
  ENTITLEMENT_REQUIRED: { http: 402, retryable: false },
  ALLOWANCE_EXHAUSTED: { http: 402, retryable: false },
  RATE_LIMITED: { http: 429, retryable: true },
  GENERATION_PAUSED: { http: 503, retryable: true },
  UPSTREAM_UNAVAILABLE: { http: 503, retryable: true },
  INTERNAL: { http: 500, retryable: true },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    request_id: string;
    retry_after_ms?: number;
  };
}

export class AvanvuError extends Error {
  readonly code: ErrorCode;
  readonly retryAfterMs?: number;

  constructor(code: ErrorCode, message: string, opts: { retryAfterMs?: number } = {}) {
    super(message);
    this.name = 'AvanvuError';
    this.code = code;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }

  get http(): number {
    return ERROR_CODES[this.code].http;
  }

  get retryable(): boolean {
    return ERROR_CODES[this.code].retryable;
  }

  toBody(requestId: string): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        request_id: requestId,
        ...(this.retryAfterMs !== undefined ? { retry_after_ms: this.retryAfterMs } : {}),
      },
    };
  }
}
