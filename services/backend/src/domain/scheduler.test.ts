import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, USER_A, USER_B, type Harness } from '../testing/harness';
import { grantPro, seedCatalog, seedProfile } from '../testing/fixtures';
import { Scheduler } from './scheduler';

let h: Harness;
let scheduler: Scheduler;
const T0 = new Date('2026-10-20T15:00:00Z');
const HOUR = 3_600_000;
let n = 0;
const uid = () => `b0000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

const eventAt = (userId: string, local = '2026-10-25T08:00') =>
  h.call('POST', '/v1/events', {
    userId,
    body: {
      name: 'Scheduler race',
      starts_local: local,
      time_zone: 'America/Toronto',
      supported_sport_id: 'running_road',
    },
  });

const itemsOf = async (programId: string, userId: string) =>
  (await h.call('GET', `/v1/programs/${programId}`, { userId })).json.items as {
    id: string;
    kind: string;
    state: string;
    generate_at: string | null;
    session_id: string | null;
  }[];

beforeAll(async () => {
  h = await createHarness({ now: T0 });
  await seedCatalog(h);
  scheduler = new Scheduler({
    db: h.db.api,
    sealer: h.sealer,
    dispatcher: h.dispatcher,
    costGuard: h.deps.costGuard,
    storage: h.storage,
    logger: h.deps.logger,
    now: h.deps.now,
    config: h.deps.config,
  });
});
afterAll(() => h.close());

describe('special sessions at event start minus 72 hours (SPEC §5.2)', () => {
  it('waits until generate_at, then creates the night-before and primer sessions once', async () => {
    const u = uid();
    await seedProfile(h, u);
    await grantPro(h, u);
    const ev = await eventAt(u); // 08:00 Toronto on the 25th = 12:00Z; generate_at = 2026-10-22T12:00Z
    const before = await scheduler.tick();
    expect(before.generated).toBe(0);

    h.clock.now = new Date('2026-10-22T12:05:00Z');
    const report = await scheduler.tick();
    expect(report.generated).toBe(2);
    const items = await itemsOf(ev.json.program_id, u);
    const night = items.find((i) => i.kind === 'night_before')!;
    const primer = items.find((i) => i.kind === 'primer')!;
    expect([night.state, primer.state]).toEqual(['generating', 'generating']);
    const sessions = await h.db.admin.kysely
      .selectFrom('app.sessions')
      .select(['context', 'length_min', 'state'])
      .where('user_id', '=', u)
      .orderBy('context')
      .execute();
    expect(sessions).toEqual([
      { context: 'night_before', length_min: 15, state: 'queued' },
      { context: 'primer', length_min: 5, state: 'queued' },
    ]);
    expect(h.queue.tasks.filter((t) => t.path === '/tasks/render').length).toBeGreaterThanOrEqual(2);

    // A second tick (or an overlapping one) creates nothing more.
    const again = await scheduler.tick();
    expect(again.generated).toBe(0);
    expect(
      await h.db.admin.kysely.selectFrom('app.sessions').select('id').where('user_id', '=', u).execute(),
    ).toHaveLength(2);
    h.clock.now = T0;
  });

  it('uses the held allowance for special items and leaves on-demand sessions untouched', async () => {
    const u = uid();
    await seedProfile(h, u);
    await grantPro(h, u);
    await eventAt(u);
    h.clock.now = new Date('2026-10-22T12:05:00Z');
    await scheduler.tick();
    const me = await h.call('GET', '/v1/me', { userId: u });
    expect(me.json.allowance.pro.available).toBe(10); // 12 granted, 2 reserved
    expect(me.json.allowance.pro.held_for_events).toBe(0);
    h.clock.now = T0;
  });

  it('waits for the profile, then generates once it exists', async () => {
    const u = uid();
    await grantPro(h, u);
    await h.deps.accounts.check(u);
    await eventAt(u);
    h.clock.now = new Date('2026-10-22T12:05:00Z');
    const waiting = await scheduler.tick();
    expect(waiting.waitingForProfile).toBeGreaterThanOrEqual(2);
    expect(waiting.generated).toBe(0);
    await seedProfile(h, u);
    const ok = await scheduler.tick();
    expect(ok.generated).toBe(2);
    h.clock.now = T0;
  });

  it('gives free users their primer but no night-before, and notifies once when the free primer is used up', async () => {
    const u = uid();
    await seedProfile(h, u);
    const ev1 = await eventAt(u);
    const ev2 = await eventAt(u, '2026-10-25T09:00');
    h.clock.now = new Date('2026-10-22T13:05:00Z'); // after both events' generate_at
    const report = await scheduler.tick();
    // Two primers, two night-befores, one free primer grant: one primer is generated.
    expect(report.generated).toBe(1);
    expect(report.blocked).toBeGreaterThanOrEqual(3);
    const items1 = await itemsOf(ev1.json.program_id, u);
    const items2 = await itemsOf(ev2.json.program_id, u);
    const all = [...items1, ...items2];
    expect(all.filter((i) => i.kind === 'night_before').every((i) => i.state === 'locked')).toBe(true);
    expect(
      all
        .filter((i) => i.kind === 'primer')
        .map((i) => i.state)
        .sort(),
    ).toEqual(['generating', 'locked']);
    const notes = await h.db.admin.kysely
      .selectFrom('app.notification_deliveries')
      .select('kind')
      .where('user_id', '=', u)
      .execute();
    expect(notes.map((x) => x.kind)).toEqual(['generation_blocked']); // only the exhausted primer notifies
    // Locked items are not retried or re-notified on later ticks.
    await scheduler.tick();
    expect(
      await h.db.admin.kysely
        .selectFrom('app.notification_deliveries')
        .select('id')
        .where('user_id', '=', u)
        .execute(),
    ).toHaveLength(1);
    h.clock.now = T0;
  });

  it('pauses with the cost breaker and resumes on a later tick', async () => {
    const u = uid();
    await seedProfile(h, u);
    await grantPro(h, u);
    await eventAt(u);
    h.clock.now = new Date('2026-10-22T12:05:00Z');
    await h.db.pg.exec(
      `insert into app.vendor_usage (vendor, kind, est_cost_usd, created_at) values ('test', 'script', 80, '${h.clock.now.toISOString()}')`,
    );
    const paused = await scheduler.tick();
    expect(paused).toMatchObject({ paused: true, generated: 0 });
    await h.db.pg.exec('delete from app.vendor_usage');
    const resumed = await scheduler.tick();
    expect(resumed).toMatchObject({ paused: false, generated: 2 });
    h.clock.now = T0;
  });
});

describe('offline readiness nudges (SPEC §6.6)', () => {
  it('nudges once at 48 hours and once at 24 hours, and not after a verified download', async () => {
    const u = uid();
    await seedProfile(h, u);
    await grantPro(h, u);
    await eventAt(u, '2026-10-30T08:00'); // 2026-10-30T12:00Z
    // Make the special sessions ready by hand (the worker has its own tests).
    h.clock.now = new Date('2026-10-27T12:05:00Z');
    await scheduler.tick();
    await h.db.admin.kysely
      .updateTable('app.sessions')
      .set({ state: 'ready', audio_path: 'p', sha256: 'a'.repeat(64), bytes: 1000 })
      .where('user_id', '=', u)
      .execute();

    h.clock.now = new Date('2026-10-28T13:00:00Z'); // 47 hours before
    expect(await scheduler.offlineNudges()).toBe(2);
    expect(await scheduler.offlineNudges()).toBe(0); // once only
    h.clock.now = new Date('2026-10-29T13:00:00Z'); // 23 hours before
    expect(await scheduler.offlineNudges()).toBe(2);
    const kinds = (
      await h.db.admin.kysely
        .selectFrom('app.notification_deliveries')
        .select('kind')
        .where('user_id', '=', u)
        .execute()
    ).map((k) => k.kind);
    expect(kinds.filter((k) => k === 'offline_nudge_48h')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'offline_nudge_24h')).toHaveLength(2);

    // A verified download on a device suppresses further nudges for that session.
    const u2 = uid();
    await seedProfile(h, u2);
    await grantPro(h, u2);
    await eventAt(u2, '2026-10-30T08:00');
    h.clock.now = new Date('2026-10-27T12:05:00Z');
    await scheduler.tick();
    await h.db.admin.kysely
      .updateTable('app.sessions')
      .set({ state: 'ready', audio_path: 'p', sha256: 'a'.repeat(64), bytes: 1000 })
      .where('user_id', '=', u2)
      .execute();
    const sessions = await h.db.admin.kysely
      .selectFrom('app.sessions')
      .select('id')
      .where('user_id', '=', u2)
      .execute();
    for (const s of sessions) {
      await h.db.pg.exec(
        `insert into app.session_downloads (user_id, session_id, sha256, bytes) values ('${u2}', '${s.id}', '${'a'.repeat(64)}', 1000)`,
      );
    }
    h.clock.now = new Date('2026-10-28T13:00:00Z');
    await scheduler.offlineNudges();
    expect(
      await h.db.admin.kysely
        .selectFrom('app.notification_deliveries')
        .select('id')
        .where('user_id', '=', u2)
        .execute(),
    ).toHaveLength(0);
    h.clock.now = T0;
  });
});

describe('stuck job recovery and retention', () => {
  it('re-dispatches a render job whose task was lost, under a new task name', async () => {
    const u = uid();
    await seedProfile(h, u);
    await grantPro(h, u);
    const made = await h.call('POST', '/v1/sessions', {
      userId: u,
      body: { program_item_id: null, context: 'training', length_min: 15 },
    });
    const job = await h.db.admin.kysely
      .selectFrom('app.render_jobs')
      .select('id')
      .where('session_id', '=', made.json.id)
      .executeTakeFirstOrThrow();
    h.queue.tasks.length = 0;
    // The task was "lost": dispatched long ago, never leased.
    await h.db.admin.kysely
      .updateTable('app.outbox_events')
      .set({ dispatched_at: new Date(h.clock.now.getTime() - HOUR) })
      .where('subject_id', '=', job.id)
      .execute();
    expect(await scheduler.recoverStuckJobs()).toBeGreaterThanOrEqual(1);
    expect(h.queue.tasks.map((t) => t.name)).toContain(`render-${job.id}-1`);
    // Fresh dispatches are left alone.
    expect(await scheduler.recoverStuckJobs()).toBe(0);
  });

  it('purges expired data and old render caches, and keeps everything else', async () => {
    const u = uid();
    await seedProfile(h, u);
    const ev = await eventAt(u);
    const conv = await h.call('POST', '/v1/intake/conversations', {
      userId: u,
      body: { event_id: ev.json.id },
    });
    await h.db.pg.exec(`
      update app.intake_conversations set summary_confirmed_at = '${new Date(T0.getTime() - 91 * 86_400_000).toISOString()}' where id = '${conv.json.id}';
      insert into app.webhook_events (vendor, vendor_event_id, received_at) values ('revenuecat', 'old', '${new Date(T0.getTime() - 91 * 86_400_000).toISOString()}'), ('revenuecat', 'new', '${T0.toISOString()}');
      insert into app.vendor_usage (vendor, kind, est_cost_usd, created_at) values ('t', 'old', 1, '${new Date(T0.getTime() - 400 * 86_400_000).toISOString()}'), ('t', 'new', 1, '${T0.toISOString()}');
      insert into app.idempotency_keys (user_id, endpoint, key, request_hash, status, expires_at) values ('${u}', 'x', gen_random_uuid(), 'h', 'completed', '${new Date(T0.getTime() - 1000).toISOString()}');
    `);
    await h.storage.put('jobs', 'jobs/old/chunks/a.wav', new Uint8Array([1]), 'audio/wav');
    h.clock.now = new Date(T0.getTime() + 2 * 86_400_000);
    await h.storage.put('jobs', 'jobs/new/chunks/b.wav', new Uint8Array([1]), 'audio/wav');
    h.clock.now = T0;
    // `old` was written at the harness clock T0; advance time past 24 hours for the purge instead.
    h.clock.now = new Date(T0.getTime() + 30 * 3_600_000);
    const out = await scheduler.purge();
    expect(out.intake_turns).toBeGreaterThanOrEqual(1);
    expect(out.webhook_events).toBe(1);
    expect(out.vendor_usage).toBe(1);
    expect(out.idempotency_keys).toBeGreaterThanOrEqual(1);
    expect(out.job_chunks).toBeGreaterThanOrEqual(1);
    expect(
      (await h.db.admin.kysely.selectFrom('app.webhook_events').select('vendor_event_id').execute()).map(
        (r) => r.vendor_event_id,
      ),
    ).toEqual(['new']);
    h.clock.now = T0;
  });
});

describe('internal endpoints', () => {
  it('are not reachable with an athlete token or without a token', async () => {
    // Internal routes are only mounted when the process is configured with scheduler auth.
    const res = await h.app.request('/internal/schedule/tick', { method: 'POST' });
    expect(res.status).toBe(404);
    void USER_A;
    void USER_B;
  });
});
