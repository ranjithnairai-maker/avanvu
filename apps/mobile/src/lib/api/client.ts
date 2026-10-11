/**
 * API client (SPEC §9.1, CLAUDE.md non-negotiable 2): the ONLY path for athlete data. The app uses Supabase for
 * sign-in alone; everything else goes through here with the Supabase access token and, for every mutation, an
 * Idempotency-Key. Errors follow CONTRACTS §10. Request bodies and responses are never logged.
 */
import type { ErrorCode } from '@avanvu/core';

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode | 'NETWORK' | 'BAD_RESPONSE',
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly opts: { retryAfterMs?: number; latest?: unknown; requestId?: string } = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
  get retryAfterMs(): number | undefined {
    return this.opts.retryAfterMs;
  }
  get latest(): unknown {
    return this.opts.latest;
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  getToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  /** Called once when the server says the session is no longer valid. */
  onUnauthenticated?: () => void;
  newKey?: () => string;
  timeoutMs?: number;
}

export interface RequestOptions {
  /** Reuse the same key when retrying the same mutation. */
  idempotencyKey?: string;
  query?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
}

export interface ApiClient {
  get<T>(path: string, opts?: RequestOptions): Promise<T>;
  post<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T>;
  put<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T>;
  patch<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T>;
  del<T>(path: string, opts?: RequestOptions): Promise<T>;
  newKey(): string;
}

const uuid = (): string =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

export function createApiClient(o: ApiClientOptions): ApiClient {
  const doFetch = o.fetchImpl ?? fetch;
  const newKey = o.newKey ?? (() => globalThis.crypto?.randomUUID?.() ?? uuid());

  async function request<T>(
    method: string,
    path: string,
    body: unknown,
    ro: RequestOptions = {},
  ): Promise<T> {
    const token = await o.getToken();
    const url = new URL(path.startsWith('/') ? path : `/${path}`, o.baseUrl);
    for (const [k, v] of Object.entries(ro.query ?? {}))
      if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET') headers['Idempotency-Key'] = ro.idempotencyKey ?? newKey();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? 30_000);
    ro.signal?.addEventListener('abort', () => controller.abort());
    let res: Response;
    try {
      res = await doFetch(url.toString(), {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } catch {
      throw new ApiError(
        'NETWORK',
        "We couldn't reach Avanvu. Check your connection and try again.",
        0,
        true,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new ApiError('BAD_RESPONSE', 'Something went wrong. Try again.', res.status, res.status >= 500);
      }
    }
    if (res.ok) return json as T;

    const e = (json as { error?: Record<string, unknown>; latest?: unknown } | null)?.error;
    const code = (
      typeof e?.code === 'string' ? e.code : res.status === 401 ? 'UNAUTHENTICATED' : 'INTERNAL'
    ) as ErrorCode;
    if (code === 'UNAUTHENTICATED' || code === 'ACCOUNT_DELETED') o.onUnauthenticated?.();
    throw new ApiError(
      code,
      typeof e?.message === 'string' ? e.message : 'Something went wrong. Try again.',
      res.status,
      e?.retryable === true,
      {
        ...(typeof e?.retry_after_ms === 'number' ? { retryAfterMs: e.retry_after_ms } : {}),
        ...((json as { latest?: unknown } | null)?.latest !== undefined
          ? { latest: (json as { latest: unknown }).latest }
          : {}),
        ...(typeof e?.request_id === 'string' ? { requestId: e.request_id } : {}),
      },
    );
  }

  return {
    get: (p, ro) => request('GET', p, undefined, ro),
    post: (p, b, ro) => request('POST', p, b, ro),
    put: (p, b, ro) => request('PUT', p, b, ro),
    patch: (p, b, ro) => request('PATCH', p, b, ro),
    del: (p, ro) => request('DELETE', p, undefined, ro),
    newKey,
  };
}

/** Run a call, retrying retryable failures with backoff (used for idempotent, resumable work only). */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!(e instanceof ApiError) || !e.retryable || i === attempts - 1) throw e;
      await sleep(e.retryAfterMs ?? (opts.baseMs ?? 500) * 2 ** i);
    }
  }
  throw last;
}
