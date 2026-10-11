import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, USER_A, USER_B, type Harness } from '../testing/harness';

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ now: new Date('2026-10-20T15:00:00Z') });
});
afterAll(() => h.close());

const body = (over: Record<string, unknown> = {}) => ({
  name: 'Fictional City Marathon',
  starts_local: '2026-12-13T08:00',
  time_zone: 'America/Toronto',
  supported_sport_id: 'running_road',
  ...over,
});

describe('POST /v1/events', () => {
  it('creates an event with a sealed name, a program and its items', async () => {
    const r = await h.call('POST', '/v1/events', { userId: USER_A, body: body() });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({
      name: 'Fictional City Marathon',
      sport_label: 'Road running',
      starts_local: '2026-12-13T08:00',
      starts_at: '2026-12-13T13:00:00.000Z',
      engine: 'endurance_v1',
    });
    const stored = await h.db.admin.kysely
      .selectFrom('app.events')
      .select(['name_enc', 'sport_label_enc'])
      .where('id', '=', r.json.id)
      .executeTakeFirstOrThrow();
    expect(Buffer.from(stored.name_enc).includes(Buffer.from('Marathon'))).toBe(false);
    expect(Buffer.from(stored.sport_label_enc!).includes(Buffer.from('running'))).toBe(false);

    const program = await h.call('GET', `/v1/programs/${r.json.program_id}`, { userId: USER_A });
    expect(program.status).toBe(200);
    const kinds = program.json.items.map((i: { kind: string }) => i.kind);
    expect(kinds).toContain('night_before');
    expect(kinds).toContain('primer');
    expect(kinds).toContain('debrief');
    expect(kinds.filter((k: string) => k === 'training').length).toBeGreaterThan(10);
  });

  it('locks program items beyond the free grant for free users', async () => {
    const e = await h.call('POST', '/v1/events', { userId: USER_A, body: body({ name: 'Second event' }) });
    const p = await h.call('GET', `/v1/programs/${e.json.program_id}`, { userId: USER_A });
    const training = p.json.items.filter((i: { kind: string }) => i.kind === 'training');
    expect(training.filter((i: { locked: boolean }) => !i.locked)).toHaveLength(1); // the one free session
    expect(p.json.items.find((i: { kind: string }) => i.kind === 'night_before').locked).toBe(true);
    expect(p.json.items.find((i: { kind: string }) => i.kind === 'primer').locked).toBe(false);
  });

  it('rejects unsupported sports and respects the custom endurance checklist', async () => {
    const bad = await h.call('POST', '/v1/events', {
      userId: USER_A,
      body: body({ supported_sport_id: 'curling' }),
    });
    expect(bad.status).toBe(422);
    expect(bad.json.error.code).toBe('UNSUPPORTED_SPORT');

    const noAnswers = await h.call('POST', '/v1/events', {
      userId: USER_A,
      body: body({ supported_sport_id: 'custom_endurance', custom_label: 'Camel race' }),
    });
    expect(noAnswers.json.error.code).toBe('UNSUPPORTED_SPORT');

    const anyNo = await h.call('POST', '/v1/events', {
      userId: USER_A,
      body: body({
        supported_sport_id: 'custom_endurance',
        custom_label: 'Cliff run',
        custom_answers: [true, true, false, true],
      }),
    });
    expect(anyNo.json.error.code).toBe('UNSUPPORTED_SPORT');

    const ok = await h.call('POST', '/v1/events', {
      userId: USER_A,
      body: body({
        supported_sport_id: 'custom_endurance',
        custom_label: 'Fictional 24 hour relay',
        custom_answers: [true, true, true, true],
      }),
    });
    expect(ok.status).toBe(201);
    expect(ok.json).toMatchObject({
      sport_label: 'Fictional 24 hour relay',
      engine: 'endurance_v1',
      supported_sport_id: 'custom_endurance',
    });
  });

  it('validates dates and time zones', async () => {
    const past = await h.call('POST', '/v1/events', {
      userId: USER_A,
      body: body({ starts_local: '2026-10-01T08:00' }),
    });
    expect(past.status).toBe(422);
    const far = await h.call('POST', '/v1/events', {
      userId: USER_A,
      body: body({ starts_local: '2028-01-01T08:00' }),
    });
    expect(far.status).toBe(422);
    const zone = await h.call('POST', '/v1/events', {
      userId: USER_A,
      body: body({ time_zone: 'Mars/Base' }),
    });
    expect(zone.status).toBe(422);
    const fake = await h.call('POST', '/v1/events', {
      userId: USER_A,
      body: body({ starts_local: '2026-02-30T08:00' }),
    });
    expect(fake.status).toBe(422);
  });

  it('is idempotent: a replay creates one event', async () => {
    const key = '99999999-9999-4999-8999-999999999999';
    const a = await h.call('POST', '/v1/events', { userId: USER_B, body: body({ name: 'Replay me' }), key });
    const b = await h.call('POST', '/v1/events', { userId: USER_B, body: body({ name: 'Replay me' }), key });
    expect(b.json.id).toBe(a.json.id);
    const rows = await h.db.admin.kysely
      .selectFrom('app.events')
      .select('id')
      .where('user_id', '=', USER_B)
      .execute();
    expect(rows).toHaveLength(1);
  });
});

describe('two-user isolation for events and programs', () => {
  it('hides another athlete’s event and program', async () => {
    const mine = await h.call('POST', '/v1/events', { userId: USER_A, body: body({ name: 'A only' }) });
    expect((await h.call('GET', `/v1/events/${mine.json.id}`, { userId: USER_B })).status).toBe(404);
    expect((await h.call('GET', `/v1/programs/${mine.json.program_id}`, { userId: USER_B })).status).toBe(
      404,
    );
    expect(
      (await h.call('PATCH', `/v1/events/${mine.json.id}`, { userId: USER_B, body: { name: 'hijack' } }))
        .status,
    ).toBe(404);
    expect((await h.call('GET', `/v1/events/${mine.json.id}`, { userId: USER_A })).json.name).toBe('A only');
  });

  it('answers NOT_FOUND for malformed ids', async () => {
    expect((await h.call('GET', '/v1/events/not-a-uuid', { userId: USER_A })).status).toBe(404);
  });
});

describe('PATCH /v1/events/:id', () => {
  it('renames without touching the program, and rebuilds planned items when the date moves', async () => {
    const e = await h.call('POST', '/v1/events', { userId: USER_A, body: body({ name: 'Move me' }) });
    const before = await h.call('GET', `/v1/programs/${e.json.program_id}`, { userId: USER_A });

    const renamed = await h.call('PATCH', `/v1/events/${e.json.id}`, {
      userId: USER_A,
      body: { name: 'Renamed' },
    });
    expect(renamed.json.name).toBe('Renamed');
    const same = await h.call('GET', `/v1/programs/${e.json.program_id}`, { userId: USER_A });
    expect(same.json.items.map((i: { id: string }) => i.id)).toEqual(
      before.json.items.map((i: { id: string }) => i.id),
    );

    const moved = await h.call('PATCH', `/v1/events/${e.json.id}`, {
      userId: USER_A,
      body: { starts_local: '2026-12-20T09:30' },
    });
    expect(moved.status).toBe(200);
    expect(moved.json).toMatchObject({
      starts_local: '2026-12-20T09:30',
      starts_at: '2026-12-20T14:30:00.000Z',
    });
    const after = await h.call('GET', `/v1/programs/${e.json.program_id}`, { userId: USER_A });
    expect(after.json.items.find((i: { kind: string }) => i.kind === 'primer')).toMatchObject({
      target_date: '2026-12-20',
      generate_at: '2026-12-17T14:30:00.000Z',
    });
    expect(after.json.items.filter((i: { kind: string }) => i.kind === 'primer')).toHaveLength(1);
  });

  it('rejects an empty patch and a past start', async () => {
    const e = await h.call('POST', '/v1/events', { userId: USER_A, body: body({ name: 'Edge' }) });
    expect((await h.call('PATCH', `/v1/events/${e.json.id}`, { userId: USER_A, body: {} })).status).toBe(422);
    expect(
      (
        await h.call('PATCH', `/v1/events/${e.json.id}`, {
          userId: USER_A,
          body: { starts_local: '2026-10-01T08:00' },
        })
      ).status,
    ).toBe(422);
  });
});

describe('GET /v1/me bootstrap', () => {
  it('reports the soonest upcoming event, the live interview and whether a profile exists', async () => {
    const u = '77777777-0000-4000-8000-000000000001';
    const empty = await h.call('GET', '/v1/me', { userId: u });
    expect(empty.json).toMatchObject({ upcoming_event: null, active_intake: null, has_profile: false });

    const later = await h.call('POST', '/v1/events', {
      userId: u,
      body: body({ name: 'Later race', starts_local: '2026-12-20T08:00' }),
    });
    const sooner = await h.call('POST', '/v1/events', {
      userId: u,
      body: body({ name: 'Sooner race', starts_local: '2026-11-20T08:00' }),
    });
    const conv = await h.call('POST', '/v1/intake/conversations', {
      userId: u,
      body: { event_id: sooner.json.id },
    });
    const me = await h.call('GET', '/v1/me', { userId: u });
    expect(me.json.upcoming_event).toMatchObject({
      id: sooner.json.id,
      name: 'Sooner race',
      program_id: sooner.json.program_id,
    });
    expect(me.json.active_intake).toMatchObject({ id: conv.json.id, state: 'AWAITING_USER' });
    expect(me.json.has_profile).toBe(false);
    expect(later.json.id).not.toBe(sooner.json.id);
  });

  it('offers the debrief for an event that has started and has not been debriefed', async () => {
    const u = '77777777-0000-4000-8000-000000000002';
    const ev = await h.call('POST', '/v1/events', {
      userId: u,
      body: body({ name: 'Just ran', starts_local: '2026-12-13T08:00' }),
    });
    await h.db.admin.kysely
      .updateTable('app.events')
      .set({ starts_at: new Date('2026-10-19T12:00:00Z') })
      .where('id', '=', ev.json.id)
      .execute();
    const me = await h.call('GET', '/v1/me', { userId: u });
    expect(me.json.upcoming_event).toBeNull();
    expect(me.json.pending_debrief).toMatchObject({ id: ev.json.id, name: 'Just ran' });
    await h.db.pg.exec(`update app.events set status = 'completed' where id = '${ev.json.id}'`);
    expect((await h.call('GET', '/v1/me', { userId: u })).json.pending_debrief).toBeNull();
  });
});
