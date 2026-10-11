import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, newKey, USER_A, USER_B, type Harness } from '../testing/harness';
import { fictionalProfile, grantPro, seedCatalog, seedProfile } from '../testing/fixtures';

let h: Harness;
const FREE = '33333333-3333-4333-8333-333333333333';
const PRO = '44444444-4444-4444-8444-444444444444';

const create = (userId: string, body: Record<string, unknown>, key?: string) =>
  h.call('POST', '/v1/sessions', { userId, body, ...(key ? { key } : {}) });
const training = { program_item_id: null, context: 'training', length_min: 15 };

beforeAll(async () => {
  h = await createHarness({ now: new Date('2026-10-20T15:00:00Z') });
  await seedCatalog(h);
  for (const u of [USER_A, USER_B, FREE, PRO]) await seedProfile(h, u);
  await grantPro(h, PRO);
});
afterAll(() => h.close());

describe('creating a session (SPEC §5.3)', () => {
  it('refuses until a confirmed, complete profile exists', async () => {
    const stranger = '55555555-5555-4555-8555-555555555555';
    const r = await create(stranger, training);
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe('MINIMUM_PROFILE_INCOMPLETE');
  });

  it('reserves allowance, creates the job and outbox row together, and dispatches a unique task', async () => {
    const r = await create(FREE, training);
    expect(r.status).toBe(202);
    expect(r.json).toMatchObject({
      context: 'training',
      length_min: 15,
      status: 'preparing',
      state: 'queued',
      engine: 'endurance_v1',
    });

    const ledger = await h.db.admin.kysely
      .selectFrom('app.usage_ledger')
      .select(['entry_type', 'quantity', 'allowance_type'])
      .where('session_id', '=', r.json.id)
      .execute();
    expect(ledger).toEqual([{ entry_type: 'reserve', quantity: -1, allowance_type: 'free_training' }]);
    const job = await h.db.admin.kysely
      .selectFrom('app.render_jobs')
      .select(['id', 'state'])
      .where('session_id', '=', r.json.id)
      .executeTakeFirstOrThrow();
    expect(job.state).toBe('queued');
    const outbox = await h.db.admin.kysely
      .selectFrom('app.outbox_events')
      .selectAll()
      .where('subject_id', '=', job.id)
      .executeTakeFirstOrThrow();
    expect(outbox.dispatched_at).not.toBeNull();
    expect(h.queue.tasks.map((t) => t.name)).toContain(`render-${job.id}-0`);
    const task = h.queue.tasks.find((t) => t.name === `render-${job.id}-0`)!;
    expect(task).toMatchObject({
      queue: 'render',
      path: '/tasks/render',
      body: { job_id: job.id, kind: 'render' },
    });
    // Task payloads carry ids only.
    expect(JSON.stringify(task.body)).not.toMatch(/Smooth|marathon|steady/i);
  });

  it('is idempotent: a repeated key returns the same session and spends allowance once', async () => {
    const key = newKey();
    const a = await create(PRO, training, key);
    const b = await create(PRO, training, key);
    expect(b.json.id).toBe(a.json.id);
    const reserves = await h.db.admin.kysely
      .selectFrom('app.usage_ledger')
      .select('id')
      .where('session_id', '=', a.json.id)
      .where('entry_type', '=', 'reserve')
      .execute();
    expect(reserves).toHaveLength(1);
  });

  it('enforces free allowance semantics: one training session, no night-before, no on-demand primer', async () => {
    expect((await create(FREE, training)).json.error.code).toBe('ALLOWANCE_EXHAUSTED');
    expect(
      (await create(FREE, { program_item_id: null, context: 'night_before', length_min: 15 })).json.error
        .code,
    ).toBe('ENTITLEMENT_REQUIRED');
    expect(
      (await create(FREE, { program_item_id: null, context: 'primer', length_min: 5 })).json.error.code,
    ).toBe('ENTITLEMENT_REQUIRED');
  });

  it('validates the length for the context', async () => {
    expect((await create(PRO, { program_item_id: null, context: 'primer', length_min: 15 })).status).toBe(
      422,
    );
    expect((await create(PRO, { program_item_id: null, context: 'training', length_min: 3 })).status).toBe(
      422,
    );
  });

  it('allows at most two sessions in progress', async () => {
    const u = '66666666-6666-4666-8666-666666666666';
    await seedProfile(h, u);
    await grantPro(h, u);
    expect((await create(u, training)).status).toBe(202);
    expect((await create(u, training)).status).toBe(202);
    const third = await create(u, training);
    expect(third.status).toBe(429);
    expect(third.json.error.code).toBe('RATE_LIMITED');
  });

  it('picks a track by the athlete’s style, defaults the night before to low drone, and none for voice only', async () => {
    const u = '77777777-7777-4777-8777-777777777777';
    await seedProfile(h, u, {
      ...fictionalProfile(),
      preferences: { ...fictionalProfile().preferences, music_style: 'pulse' },
    });
    await grantPro(h, u);
    const t = await create(u, training);
    const nb = await create(u, { program_item_id: null, context: 'night_before', length_min: 15 });
    const rows = await h.db.admin.kysely
      .selectFrom('app.sessions')
      .select(['id', 'track_id'])
      .where('user_id', '=', u)
      .execute();
    expect(rows.find((r) => r.id === t.json.id)?.track_id).toBe('pulse_1');
    expect(rows.find((r) => r.id === nb.json.id)?.track_id).toBe('drone_1');

    const v = '88888888-8888-4888-8888-888888888888';
    await seedProfile(h, v, {
      ...fictionalProfile(),
      preferences: { ...fictionalProfile().preferences, music_style: 'voice_only' },
    });
    await grantPro(h, v);
    const vo = await create(v, training);
    const row = await h.db.admin.kysely
      .selectFrom('app.sessions')
      .select('track_id')
      .where('id', '=', vo.json.id)
      .executeTakeFirstOrThrow();
    expect(row.track_id).toBeNull();
  });
});

describe('cost circuit breaker', () => {
  it('pauses new generations above the daily cap with an honest message, but still replays earlier results', async () => {
    const u = '99999999-9999-4999-8999-999999999999';
    await seedProfile(h, u);
    await grantPro(h, u);
    const key = newKey();
    const first = await create(u, training, key);
    expect(first.status).toBe(202);

    await h.db.pg.exec(
      `insert into app.vendor_usage (vendor, kind, est_cost_usd, created_at) values ('test', 'script', 80, '${h.clock.now.toISOString()}')`,
    );
    const blocked = await create(u, training);
    expect(blocked.status).toBe(503);
    expect(blocked.json.error).toMatchObject({ code: 'GENERATION_PAUSED', retryable: true });
    expect(blocked.json.error.message).toContain("allowance wasn't used");
    const replay = await create(u, training, key);
    expect(replay.status).toBe(202);
    expect(replay.json.id).toBe(first.json.id);
    await h.db.pg.exec(`delete from app.vendor_usage`);
  });
});

describe('outbox recovery', () => {
  it('re-enqueues undispatched work with the sweeper when the first enqueue failed', async () => {
    const u = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await seedProfile(h, u);
    await grantPro(h, u);
    h.queue.failNext = 1;
    const r = await create(u, training);
    expect(r.status).toBe(202); // the request still succeeds
    const job = await h.db.admin.kysely
      .selectFrom('app.render_jobs')
      .select('id')
      .where('session_id', '=', r.json.id)
      .executeTakeFirstOrThrow();
    let row = await h.db.admin.kysely
      .selectFrom('app.outbox_events')
      .select('dispatched_at')
      .where('subject_id', '=', job.id)
      .executeTakeFirstOrThrow();
    expect(row.dispatched_at).toBeNull();
    expect(h.queue.tasks.some((t) => t.name.includes(job.id))).toBe(false);

    // The test clock is not the database clock, so stamp the row with the test time.
    await h.db.admin.kysely
      .updateTable('app.outbox_events')
      .set({ created_at: h.clock.now })
      .where('subject_id', '=', job.id)
      .execute();
    expect(await h.dispatcher.sweep()).toBe(0); // too fresh (under 30 s)
    h.clock.now = new Date(h.clock.now.getTime() + 60_000);
    expect(await h.dispatcher.sweep()).toBeGreaterThanOrEqual(1);
    row = await h.db.admin.kysely
      .selectFrom('app.outbox_events')
      .select('dispatched_at')
      .where('subject_id', '=', job.id)
      .executeTakeFirstOrThrow();
    expect(row.dispatched_at).not.toBeNull();
    expect(h.queue.tasks.filter((t) => t.name === `render-${job.id}-0`)).toHaveLength(1);
    // Sweeping again, or dispatching again, never creates a second task.
    await h.dispatcher.sweep();
    expect(h.queue.tasks.filter((t) => t.name === `render-${job.id}-0`)).toHaveLength(1);
  });
});

describe('cancel, list, delete and isolation', () => {
  let sessionId: string;

  it('cancels a queued session and gives the allowance back', async () => {
    const u = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await seedProfile(h, u);
    const r = await create(u, training);
    sessionId = r.json.id;
    const c = await h.call('POST', `/v1/sessions/${sessionId}/cancel`, { userId: u });
    expect(c.json).toMatchObject({ state: 'canceled', status: 'canceled' });
    const sum = await h.db.admin.kysely
      .selectFrom('app.usage_ledger')
      .select((eb) => eb.fn.sum<string>('quantity').as('s'))
      .where('user_id', '=', u)
      .where('allowance_type', '=', 'free_training')
      .executeTakeFirstOrThrow();
    expect(Number(sum.s)).toBe(1);
    const again = await h.call('POST', `/v1/sessions/${sessionId}/cancel`, { userId: u });
    expect(again.status).toBe(200);
    // And the athlete can create a session again.
    expect((await create(u, training)).status).toBe(202);
  });

  it('refuses to cancel once generation has started', async () => {
    const u = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await seedProfile(h, u);
    const r = await create(u, training);
    await h.db.admin.kysely
      .updateTable('app.sessions')
      .set({ state: 'generating_script' })
      .where('id', '=', r.json.id)
      .execute();
    const c = await h.call('POST', `/v1/sessions/${r.json.id}/cancel`, { userId: u });
    expect(c.status).toBe(422);
  });

  it('lists with cursor pagination and a context filter', async () => {
    const u = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    await seedProfile(h, u);
    await grantPro(h, u);
    for (let i = 0; i < 2; i++) {
      h.clock.now = new Date(h.clock.now.getTime() + 1000);
      const r = await create(u, training);
      await h.db.admin.kysely
        .updateTable('app.sessions')
        .set({ state: 'ready', created_at: h.clock.now })
        .where('id', '=', r.json.id)
        .execute();
    }
    await create(u, { program_item_id: null, context: 'primer', length_min: 5 });
    const page1 = await h.call('GET', '/v1/sessions?limit=2', { userId: u });
    expect(page1.json.sessions).toHaveLength(2);
    expect(page1.json.next_cursor).toBeTruthy();
    const page2 = await h.call('GET', `/v1/sessions?limit=2&cursor=${page1.json.next_cursor}`, { userId: u });
    expect(page2.json.sessions).toHaveLength(1);
    expect(page2.json.next_cursor).toBeNull();
    const ids = [...page1.json.sessions, ...page2.json.sessions].map((s: { id: string }) => s.id);
    expect(new Set(ids).size).toBe(3);
    const filtered = await h.call('GET', '/v1/sessions?context=primer', { userId: u });
    expect(filtered.json.sessions).toHaveLength(1);
    expect((await h.call('GET', '/v1/sessions?limit=500', { userId: u })).status).toBe(422);
    expect((await h.call('GET', '/v1/sessions?cursor=garbage', { userId: u })).status).toBe(422);
  });

  it('never exposes another athlete’s session through any endpoint', async () => {
    const mine = await create(PRO, training);
    const id = mine.json.id;
    for (const [method, path] of [
      ['GET', `/v1/sessions/${id}`],
      ['POST', `/v1/sessions/${id}/cancel`],
      ['DELETE', `/v1/sessions/${id}`],
      ['GET', `/v1/sessions/${id}/transcript`],
      ['POST', `/v1/sessions/${id}/download-url`],
      ['POST', `/v1/sessions/${id}/checkin`],
      ['POST', `/v1/sessions/${id}/plays`],
    ] as const) {
      const r = await h.call(method, path, {
        userId: USER_B,
        ...(method === 'POST' && path.endsWith('checkin') ? { body: { vividness: 4, readiness: 4 } } : {}),
        ...(method === 'POST' && path.endsWith('plays')
          ? {
              body: {
                plays: [
                  {
                    client_event_id: crypto.randomUUID(),
                    mark: 'start',
                    position_ms: 0,
                    occurred_at: '2026-10-20T15:00:00Z',
                  },
                ],
              },
            }
          : {}),
      });
      expect([404, 422], `${method} ${path} -> ${r.status}`).toContain(r.status);
      expect(r.status, `${method} ${path}`).not.toBe(200);
    }
    const list = await h.call('GET', '/v1/sessions', { userId: USER_B });
    expect(list.json.sessions.map((s: { id: string }) => s.id)).not.toContain(id);
  });

  it('links a program item and rejects a mismatched one', async () => {
    const u = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    await seedProfile(h, u);
    await grantPro(h, u);
    const ev = await h.call('POST', '/v1/events', {
      userId: u,
      body: {
        name: 'Linked race',
        starts_local: '2026-12-13T08:00',
        time_zone: 'America/Toronto',
        supported_sport_id: 'running_road',
      },
    });
    const prog = await h.call('GET', `/v1/programs/${ev.json.program_id}`, { userId: u });
    const trainingItem = prog.json.items.find((i: { kind: string }) => i.kind === 'training');
    const primerItem = prog.json.items.find((i: { kind: string }) => i.kind === 'primer');
    const bad = await create(u, { program_item_id: primerItem.id, context: 'training', length_min: 15 });
    expect(bad.status).toBe(422);
    const ok = await create(u, { program_item_id: trainingItem.id, context: 'training', length_min: 15 });
    expect(ok.status).toBe(202);
    const after = await h.call('GET', `/v1/programs/${ev.json.program_id}`, { userId: u });
    expect(after.json.items.find((i: { id: string }) => i.id === trainingItem.id)).toMatchObject({
      state: 'generating',
      session_id: ok.json.id,
    });
    const twice = await create(u, { program_item_id: trainingItem.id, context: 'training', length_min: 15 });
    expect(twice.status).toBe(422);
    // Not the athlete's item: not found, never an information leak.
    expect(
      (await create(USER_B, { program_item_id: trainingItem.id, context: 'training', length_min: 15 }))
        .status,
    ).toBe(404);
  });
});
