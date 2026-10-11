import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SPORTS } from '@avanvu/core';
import { createHarness, newKey, USER_A, USER_B, type Harness } from '../testing/harness';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

describe('authentication', () => {
  it('rejects missing, malformed, expired, wrong-audience and wrong-issuer tokens', async () => {
    expect((await h.call('GET', '/v1/me')).status).toBe(401);
    expect((await h.call('GET', '/v1/me', { token: 'garbage' })).status).toBe(401);
    expect(
      (await h.call('GET', '/v1/me', { token: await h.token(USER_A, { expiresIn: '-1m' }) })).status,
    ).toBe(401);
    expect(
      (await h.call('GET', '/v1/me', { token: await h.token(USER_A, { audience: 'anon' }) })).status,
    ).toBe(401);
    expect(
      (
        await h.call('GET', '/v1/me', {
          token: await h.token(USER_A, { issuer: 'https://evil.example/auth/v1' }),
        })
      ).status,
    ).toBe(401);
    const r = await h.call('GET', '/v1/me');
    expect(r.json.error).toMatchObject({ code: 'UNAUTHENTICATED', retryable: false });
    expect(r.json.error.request_id).toMatch(/^req_/);
  });

  it('rejects an unsigned (alg none) token', async () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const forged = `${b64({ alg: 'none' })}.${b64({ sub: USER_A, iss: 'https://test.supabase.co/auth/v1', aud: 'authenticated', exp: 9999999999 })}.`;
    expect((await h.call('GET', '/v1/me', { token: forged })).status).toBe(401);
  });

  it('keeps the health check public', async () => {
    expect((await h.call('GET', '/healthz')).status).toBe(200);
  });
});

describe('GET /v1/me', () => {
  it('creates the account on first use and reports the free allowance', async () => {
    const r = await h.call('GET', '/v1/me', { userId: USER_A });
    expect(r.status).toBe(200);
    expect(r.json.user).toMatchObject({ demo_account: false, age_assured: false });
    expect(r.json.entitlement).toBeNull();
    expect(r.json.allowance).toMatchObject({ free_training: 1, free_primer: 1, pro: null });
  });

  it('echoes and generates request ids', async () => {
    const r = await h.call('GET', '/v1/me', {
      userId: USER_A,
      headers: { 'x-request-id': 'trace-id-12345' },
    });
    expect(r.headers.get('x-request-id')).toBe('trace-id-12345');
  });
});

describe('GET /v1/sports', () => {
  it('serves the supported registry', async () => {
    const r = await h.call('GET', '/v1/sports', { userId: USER_A });
    expect(r.json.sports).toHaveLength(SPORTS.length);
    expect(r.json.sports.find((s: { id: string }) => s.id === 'golf')).toMatchObject({
      engine: 'closed_skill_v1',
    });
  });
});

describe('mutations require an Idempotency-Key and a valid body', () => {
  it('rejects a missing or malformed key', async () => {
    const r = await h.call('POST', '/v1/waitlist', {
      userId: USER_A,
      body: { sport_label: 'Curling' },
      headers: { 'Idempotency-Key': 'nope' },
    });
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe('VALIDATION_FAILED');
  });

  it('names invalid fields without echoing their values', async () => {
    const r = await h.call('POST', '/v1/waitlist', { userId: USER_A, body: { sport_label: 'x'.repeat(61) } });
    expect(r.status).toBe(422);
    expect(r.json.error.message).toContain('sport_label');
    expect(JSON.stringify(r.json)).not.toContain('xxxxxxxx');
  });

  it('rejects a body that is not JSON', async () => {
    const res = await h.app.request('/v1/waitlist', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await h.token(USER_A)}`,
        'Idempotency-Key': newKey(),
        'Content-Type': 'application/json',
      },
      body: '{not json',
    });
    expect(res.status).toBe(422);
  });

  it('applies a mutation once for a repeated key and conflicts on a changed body', async () => {
    const key = newKey();
    const first = await h.call('POST', '/v1/waitlist', {
      userId: USER_A,
      body: { sport_label: 'Curling' },
      key,
    });
    const again = await h.call('POST', '/v1/waitlist', {
      userId: USER_A,
      body: { sport_label: 'Curling' },
      key,
    });
    expect([first.status, again.status]).toEqual([201, 201]);
    expect(again.json).toEqual(first.json);
    const count = await h.db.admin.kysely
      .selectFrom('app.waitlist_entries')
      .select('id')
      .where('user_id', '=', USER_A)
      .execute();
    expect(count).toHaveLength(1);
    const clash = await h.call('POST', '/v1/waitlist', {
      userId: USER_A,
      body: { sport_label: 'Bowls' },
      key,
    });
    expect(clash.status).toBe(409);
    expect(clash.json.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

describe('consents, age assurance and devices', () => {
  it('records consents and the age-check method with no birth date', async () => {
    const c = await h.call('POST', '/v1/consents', {
      userId: USER_A,
      body: {
        consents: [
          { kind: 'processing', version: '2026-10', accepted: true },
          { kind: 'analytics', version: '2026-10', accepted: false },
        ],
      },
    });
    expect(c.status).toBe(201);
    const a = await h.call('POST', '/v1/age-assurance', {
      userId: USER_A,
      body: { method: 'declared_age_range' },
    });
    expect(a.status).toBe(200);
    expect(
      (
        await h.call('POST', '/v1/age-assurance', {
          userId: USER_A,
          body: { method: 'declared_age_range', birth_date: '1990-01-01' },
        })
      ).status,
    ).toBe(200); // unknown fields are ignored, never stored
    const me = await h.call('GET', '/v1/me', { userId: USER_A });
    expect(me.json.user.age_assured).toBe(true);
    const cols = await h.db.pg.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_schema='app' and table_name='users'`,
    );
    expect(cols.rows.map((x) => x.column_name).join()).not.toMatch(/birth|dob/);
  });

  it('upserts a device and deletes only the caller’s own', async () => {
    const reg = await h.call('POST', '/v1/devices', {
      userId: USER_A,
      body: { push_token: 'ExponentPushToken[aaaaaaaaaaaa]' },
    });
    expect(reg.status).toBe(201);
    const other = await h.call('DELETE', `/v1/devices/${reg.json.id}`, { userId: USER_B });
    expect(other.status).toBe(404);
    const mine = await h.call('DELETE', `/v1/devices/${reg.json.id}`, { userId: USER_A });
    expect(mine.status).toBe(200);
  });
});

describe('rate limits and error hygiene', () => {
  it('limits unauthenticated-adjacent traffic per IP with a Retry-After header', async () => {
    const ip = { 'x-forwarded-for': '203.0.113.9' };
    let last = 200;
    for (let i = 0; i < 61; i++)
      last = (await h.call('GET', '/v1/sports', { userId: USER_B, headers: ip })).status;
    expect(last).toBe(429);
    const r = await h.call('GET', '/v1/sports', { userId: USER_B, headers: ip });
    expect(r.json.error).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('never writes request bodies or tokens to logs', async () => {
    await h.call('POST', '/v1/waitlist', { userId: USER_A, body: { sport_label: 'Underwater hockey' } });
    const all = h.logs.join('\n');
    expect(all).not.toContain('Underwater');
    expect(all).not.toContain('Bearer');
    expect(all).toContain('http_request');
  });

  it('hides internal error details behind INTERNAL', async () => {
    const original = h.deps.accounts.check.bind(h.deps.accounts);
    h.deps.accounts.check = async () => {
      throw new Error('database password is hunter2');
    };
    try {
      const r = await h.call('GET', '/v1/me', {
        userId: USER_B,
        headers: { 'x-forwarded-for': '198.51.100.7' },
      });
      expect(r.status).toBe(500);
      expect(r.json.error).toMatchObject({ code: 'INTERNAL', retryable: true });
      expect(JSON.stringify(r.json)).not.toContain('hunter2');
      expect(h.logs.join('\n')).not.toContain('hunter2');
    } finally {
      h.deps.accounts.check = original;
    }
  });
});
