import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient, withRetry } from './client';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function client(fetchImpl: typeof fetch, extra: Partial<Parameters<typeof createApiClient>[0]> = {}) {
  return createApiClient({
    baseUrl: 'https://api.example.test',
    getToken: async () => 'tok',
    fetchImpl,
    newKey: () => 'key-1',
    ...extra,
  });
}

describe('api client', () => {
  it('sends the bearer token, never an Idempotency-Key on GET, and a key on every mutation', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return json(200, { ok: true });
    }) as unknown as typeof fetch;
    const c = client(f);
    await c.get('/v1/me', { query: { limit: 5, skip: undefined } });
    await c.post('/v1/waitlist', { sport_label: 'Curling' });
    await c.post('/v1/waitlist', { sport_label: 'Curling' }, { idempotencyKey: 'retry-key' });
    expect(calls[0]!.url).toBe('https://api.example.test/v1/me?limit=5');
    expect((calls[0]!.init.headers as Record<string, string>)['Idempotency-Key']).toBeUndefined();
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect((calls[1]!.init.headers as Record<string, string>)['Idempotency-Key']).toBe('key-1');
    expect((calls[2]!.init.headers as Record<string, string>)['Idempotency-Key']).toBe('retry-key');
  });

  it('maps the error contract, including retry hints and the latest committed state', async () => {
    const f = (async () =>
      json(409, {
        error: {
          code: 'PROFILE_REVISION_CONFLICT',
          message: 'Changed elsewhere.',
          retryable: false,
          request_id: 'req_1',
        },
        latest: { revision: 7 },
      })) as unknown as typeof fetch;
    const err = (await client(f)
      .post('/v1/intake/turns', {})
      .catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'PROFILE_REVISION_CONFLICT', status: 409, retryable: false });
    expect(err.latest).toEqual({ revision: 7 });
    expect(err.opts.requestId).toBe('req_1');

    const limited = (async () =>
      json(429, {
        error: {
          code: 'RATE_LIMITED',
          message: 'Slow down.',
          retryable: true,
          retry_after_ms: 2000,
          request_id: 'r',
        },
      })) as unknown as typeof fetch;
    const e2 = await client(limited)
      .get('/v1/me')
      .catch((e) => e);
    expect(e2).toMatchObject({ code: 'RATE_LIMITED', retryable: true, retryAfterMs: 2000 });
  });

  it('turns network failures and bad bodies into safe errors with no vendor text', async () => {
    const offline = (async () => {
      throw new TypeError('Network request failed: secret detail');
    }) as unknown as typeof fetch;
    const e1 = (await client(offline)
      .get('/v1/me')
      .catch((e: unknown) => e)) as ApiError;
    expect(e1).toMatchObject({ code: 'NETWORK', retryable: true });
    expect(e1.message).not.toContain('secret');
    const html = (async () => new Response('<html>oops</html>', { status: 502 })) as unknown as typeof fetch;
    expect(
      await client(html)
        .get('/v1/me')
        .catch((e) => e),
    ).toMatchObject({ code: 'BAD_RESPONSE', retryable: true });
  });

  it('signals the app to sign out on UNAUTHENTICATED and ACCOUNT_DELETED', async () => {
    const onUnauthenticated = vi.fn();
    for (const code of ['UNAUTHENTICATED', 'ACCOUNT_DELETED']) {
      const f = (async () =>
        json(401, {
          error: { code, message: 'x', retryable: false, request_id: 'r' },
        })) as unknown as typeof fetch;
      await client(f, { onUnauthenticated })
        .get('/v1/me')
        .catch(() => undefined);
    }
    expect(onUnauthenticated).toHaveBeenCalledTimes(2);
  });

  it('retries retryable failures with the server hint and stops on non-retryable ones', async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => void sleeps.push(ms);
    let n = 0;
    const out = await withRetry(
      async () => {
        if (++n < 3) throw new ApiError('UPSTREAM_UNAVAILABLE', 'x', 503, true);
        return 'done';
      },
      { sleep },
    );
    expect(out).toBe('done');
    expect(sleeps).toEqual([500, 1000]);
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new ApiError('VALIDATION_FAILED', 'x', 422, false);
        },
        { sleep },
      ),
    ).rejects.toBeInstanceOf(ApiError);
    expect(calls).toBe(1);
    await expect(
      withRetry(
        async () => {
          throw new ApiError('RATE_LIMITED', 'x', 429, true, { retryAfterMs: 7 });
        },
        { sleep, attempts: 2 },
      ),
    ).rejects.toBeInstanceOf(ApiError);
    expect(sleeps.at(-1)).toBe(7);
  });
});
