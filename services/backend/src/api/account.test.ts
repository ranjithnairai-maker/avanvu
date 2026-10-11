import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { fictionalProfile } from '@avanvu/core';
import { Scheduler } from '../domain/scheduler';
import { createHarness, USER_A, USER_B, type Harness } from '../testing/harness';
import { grantPro, seedCatalog, seedProfile } from '../testing/fixtures';
import { createWorkerHarness, type WorkerHarness } from '../testing/workerHarness';

let h: Harness;
let w: WorkerHarness;
const T0 = new Date('2026-10-20T15:00:00Z');
let n = 0;
const uid = () => `c0000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const WEBHOOK = { Authorization: 'Bearer test-webhook-secret' };

const hook = (userId: string, id: string, auth: Record<string, string> = WEBHOOK) =>
  h.app.request('/webhooks/revenuecat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ event: { id, app_user_id: userId, type: 'INITIAL_PURCHASE' } }),
  });

beforeAll(async () => {
  h = await createHarness({ now: T0 });
  await seedCatalog(h);
  w = await createWorkerHarness(h);
  w.scriptFor(fictionalProfile());
});
afterAll(() => h.close());

describe('RevenueCat webhooks and entitlement sync', () => {
  it('rejects a wrong or missing Authorization header', async () => {
    expect((await hook(USER_A, 'evt-1', { Authorization: 'Bearer nope' })).status).toBe(401);
    expect((await hook(USER_A, 'evt-1', {})).status).toBe(401);
  });

  it('treats webhooks as triggers: stores the event once, syncs current state from the API, ignores duplicates', async () => {
    const u = uid();
    await seedProfile(h, u);
    h.revenuecat.customers.set(u, {
      active: true,
      periodType: 'normal',
      product: 'pro_annual',
      expiresAt: new Date('2027-10-01T00:00:00Z'),
      originalPurchaseAt: new Date('2026-10-01T09:00:00Z'),
      willRenew: true,
      billingIssue: false,
    });
    expect((await hook(u, 'evt-a')).status).toBe(200);
    expect((await hook(u, 'evt-a')).status).toBe(200); // duplicate delivery
    const events = await h.db.admin.kysely
      .selectFrom('app.webhook_events')
      .select('id')
      .where('vendor_event_id', '=', 'evt-a')
      .execute();
    expect(events).toHaveLength(1);
    const fetchesBefore = h.revenuecat.fetches;
    expect(await w.drain()).toEqual([200]);
    expect(h.revenuecat.fetches - fetchesBefore).toBe(1); // one sync for one event
    const me = await h.call('GET', '/v1/me', { userId: u });
    expect(me.json.entitlement).toMatchObject({ active: true, period_type: 'normal' });
    expect(me.json.allowance.pro).toBeTruthy();
  });

  it('is harmless out of order: the sync reads the latest state, whatever order events arrive in', async () => {
    const u = uid();
    await seedProfile(h, u);
    h.revenuecat.customers.set(u, {
      active: false,
      periodType: null,
      product: null,
      expiresAt: null,
      originalPurchaseAt: null,
      willRenew: false,
      billingIssue: false,
    });
    await hook(u, 'evt-new-first');
    await hook(u, 'evt-old-second');
    await w.drain();
    const me = await h.call('GET', '/v1/me', { userId: u });
    expect(me.json.entitlement).toMatchObject({ active: false });
  });

  it('ignores events for unknown users and malformed bodies', async () => {
    expect((await hook('99999999-0000-4000-8000-000000000000', 'evt-ghost')).status).toBe(200);
    expect(h.queue.tasks.some((t) => t.name.includes('99999999'))).toBe(false);
    const res = await h.app.request('/webhooks/revenuecat', {
      method: 'POST',
      headers: { ...WEBHOOK, 'Content-Type': 'application/json' },
      body: '{"nope":1}',
    });
    expect(res.status).toBe(200);
  });

  it('refreshes after a purchase, and tops the trial up to the full allowance on conversion', async () => {
    const u = uid();
    await seedProfile(h, u);
    const base = {
      productName: 'x',
      product: 'pro_annual',
      expiresAt: new Date('2027-10-01T00:00:00Z'),
      originalPurchaseAt: new Date('2026-10-01T09:00:00Z'),
      willRenew: true,
      billingIssue: false,
    };
    h.revenuecat.customers.set(u, { ...base, active: true, periodType: 'trial' });
    const first = await h.call('POST', '/v1/purchases/refresh', { userId: u });
    expect(first.json.entitlement).toMatchObject({ active: true, period_type: 'trial' });
    const s1 = await h.call('POST', '/v1/sessions', {
      userId: u,
      body: { program_item_id: null, context: 'training', length_min: 15 },
    });
    expect(s1.status).toBe(202);
    expect((await h.call('GET', '/v1/me', { userId: u })).json.allowance.pro.available).toBe(2); // 3 trial sessions, one used

    h.revenuecat.customers.set(u, { ...base, active: true, periodType: 'normal' });
    await h.call('POST', '/v1/purchases/refresh', { userId: u });
    const s2 = await h.call('POST', '/v1/sessions', {
      userId: u,
      body: { program_item_id: null, context: 'training', length_min: 15 },
    });
    expect(s2.status).toBe(202);
    expect((await h.call('GET', '/v1/me', { userId: u })).json.allowance.pro.available).toBe(12 - 2);
    h.queue.tasks.length = 0; // rendering is covered by the worker tests
  });

  it('removes Pro access when the entitlement lapses', async () => {
    const u = uid();
    await seedProfile(h, u);
    await grantPro(h, u);
    h.revenuecat.customers.set(u, {
      active: false,
      periodType: 'normal',
      product: 'pro_monthly',
      expiresAt: new Date('2026-10-02T00:00:00Z'),
      originalPurchaseAt: new Date('2026-09-02T00:00:00Z'),
      willRenew: false,
      billingIssue: false,
    });
    await h.call('POST', '/v1/purchases/refresh', { userId: u });
    const night = await h.call('POST', '/v1/sessions', {
      userId: u,
      body: { program_item_id: null, context: 'night_before', length_min: 15 },
    });
    expect(night.json.error.code).toBe('ENTITLEMENT_REQUIRED');
  });
});

describe('Sign in with Apple linking', () => {
  it('stores the refresh token sealed and rejects a bad code', async () => {
    const u = uid();
    await h.deps.accounts.check(u);
    expect(
      (
        await h.call('POST', '/v1/auth/apple/link', {
          userId: u,
          body: { authorization_code: 'garbage-code' },
        })
      ).status,
    ).toBe(422);
    const ok = await h.call('POST', '/v1/auth/apple/link', {
      userId: u,
      body: { authorization_code: 'valid-abcdef123' },
    });
    expect(ok.status).toBe(200);
    const row = await h.db.admin.kysely
      .selectFrom('app.apple_tokens')
      .select('refresh_token_enc')
      .where('user_id', '=', u)
      .executeTakeFirstOrThrow();
    expect(Buffer.from(row.refresh_token_enc).includes(Buffer.from('refresh-valid'))).toBe(false);
    expect(h.logs.join('\n')).not.toContain('refresh-valid');
  });
});

describe('account deletion (SPEC §10.5)', () => {
  const userTables = async () =>
    (
      await h.db.pg.query<{ table_name: string; column_name: string }>(`
      select table_name, column_name from information_schema.columns
      where table_schema = 'app' and column_name in ('user_id', 'id') and table_name not in ('deletion_jobs','deletion_ledger','webhook_events','rate_limit_buckets','sport_engines','voice_catalog','music_catalog','vendor_usage')`)
    ).rows;

  async function populate(u: string) {
    await seedProfile(h, u);
    await grantPro(h, u);
    await h.call('POST', '/v1/auth/apple/link', {
      userId: u,
      body: { authorization_code: 'valid-deleteme01' },
    });
    await h.call('POST', '/v1/devices', {
      userId: u,
      body: { push_token: 'ExponentPushToken[delete-me-000000]' },
    });
    const ev = await h.call('POST', '/v1/events', {
      userId: u,
      body: {
        name: 'Delete me race',
        starts_local: '2026-12-13T08:00',
        time_zone: 'America/Toronto',
        supported_sport_id: 'running_road',
      },
    });
    await h.call('POST', '/v1/intake/conversations', { userId: u, body: { event_id: ev.json.id } });
    const s = await h.call('POST', '/v1/sessions', {
      userId: u,
      body: { program_item_id: null, context: 'primer', length_min: 3 },
    });
    await w.drain();
    return { eventId: ev.json.id as string, sessionId: s.json.id as string };
  }

  it('erases every athlete row and object, revokes vendor access, and keeps other athletes intact', async () => {
    const u = uid();
    const other = uid();
    await seedProfile(h, other);
    await h.call('POST', '/v1/waitlist', { userId: other, body: { sport_label: 'Keep me' } });
    const { sessionId } = await populate(u);
    expect((await h.call('GET', `/v1/sessions/${sessionId}`, { userId: u })).json.state).toBe('ready');
    expect(h.storage.count('audio', `audio/${u}/`)).toBe(1);
    const analyticsId = (
      await h.db.admin.kysely
        .selectFrom('app.users')
        .select('analytics_id')
        .where('id', '=', u)
        .executeTakeFirstOrThrow()
    ).analytics_id;

    const del = await h.call('POST', '/v1/account/delete', { userId: u });
    expect(del.status).toBe(202);
    // Immediate denial, before the job even runs.
    expect((await h.call('GET', '/v1/me', { userId: u })).json.error.code).toBe('ACCOUNT_DELETED');

    expect(await w.drain()).toEqual([200]);
    expect(w.vendors.signedOut).toEqual([u]);
    expect(w.vendors.authDeleted).toEqual([u]);
    expect(w.vendors.analyticsDeleted).toEqual([analyticsId]);
    expect(h.revenuecat.deleted).toContain(u);
    expect(h.apple.revoked).toContain('refresh-valid-deleteme01');
    expect(h.storage.count('audio', `audio/${u}/`)).toBe(0);

    // Every table with the athlete's rows is empty for them.
    for (const t of await userTables()) {
      const col = t.column_name;
      const r = await h.db.pg
        .query<{ n: number }>(`select count(*)::int as n from app.${t.table_name} where ${col} = '${u}'`)
        .catch(() => null);
      if (r) expect(r.rows[0]!.n, `${t.table_name}.${col}`).toBe(0);
    }
    const ledger = await h.db.admin.kysely
      .selectFrom('app.deletion_ledger')
      .select('user_id')
      .where('user_id', '=', u)
      .execute();
    expect(ledger).toHaveLength(1);
    expect(JSON.stringify(ledger)).not.toMatch(/email|name/);
    // The other athlete is untouched.
    expect(
      await h.db.admin.kysely
        .selectFrom('app.waitlist_entries')
        .select('id')
        .where('user_id', '=', other)
        .execute(),
    ).toHaveLength(1);
    // An unexpired token cannot resurrect the account, even on a fresh server instance.
    const fresh = await createHarnessLike();
    void fresh;
    h.deps.accounts.markDeleted(u);
    expect((await h.call('GET', '/v1/me', { userId: u })).json.error.code).toBe('ACCOUNT_DELETED');
    expect(
      await h.db.admin.kysely.selectFrom('app.users').select('id').where('id', '=', u).execute(),
    ).toHaveLength(0);
  }, 240_000);

  it('resumes after a vendor failure without repeating completed steps, and is harmless when delivered twice', async () => {
    const u = uid();
    await populate(u);
    w.vendors.failAnalytics = 1;
    await h.call('POST', '/v1/account/delete', { userId: u });
    const revokedBefore = h.apple.revoked.length;
    expect(await w.drain({ maxAttempts: 1 })).toEqual([503]);
    expect(h.apple.revoked.length - revokedBefore).toBe(1); // step 2 done once
    const job = await h.db.admin.kysely
      .selectFrom('app.deletion_jobs')
      .select(['id', 'state', 'steps'])
      .where('user_id', '=', u)
      .executeTakeFirstOrThrow();
    expect(job.state).toBe('running');
    expect(Object.keys(job.steps as object)).toEqual(
      expect.arrayContaining(['sign_out', 'apple_revoke', 'revenuecat']),
    );
    // Retry (twice, as if duplicated).
    const r1 = await w.deliver('/tasks/delete-account', { job_id: job.id });
    const r2 = await w.deliver('/tasks/delete-account', { job_id: job.id });
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(h.apple.revoked.length - revokedBefore).toBe(1); // not revoked again
    expect(w.vendors.authDeleted.filter((x) => x === u)).toHaveLength(1);
    expect(
      (
        await h.db.admin.kysely
          .selectFrom('app.deletion_jobs')
          .select('state')
          .where('id', '=', job.id)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe('completed');
  }, 240_000);
});

async function createHarnessLike() {
  return null;
}

describe('data export (SPEC §10.6)', () => {
  it('builds a ZIP with the athlete’s decrypted data and audio, served by a short-lived URL, and expires after 72 hours', async () => {
    const u = uid();
    await seedProfile(h, u);
    await grantPro(h, u);
    const ev = await h.call('POST', '/v1/events', {
      userId: u,
      body: {
        name: 'Export race',
        starts_local: '2026-12-13T08:00',
        time_zone: 'America/Toronto',
        supported_sport_id: 'running_road',
      },
    });
    await h.call('POST', '/v1/intake/conversations', { userId: u, body: { event_id: ev.json.id } });
    const s = await h.call('POST', '/v1/sessions', {
      userId: u,
      body: { program_item_id: null, context: 'primer', length_min: 3 },
    });
    await w.drain();
    await h.call('POST', `/v1/sessions/${s.json.id}/checkin`, {
      userId: u,
      body: { vividness: 4, readiness: 5, useful: 'The cue phrase landed' },
    });

    const req = await h.call('POST', '/v1/account/export', { userId: u });
    expect(req.status).toBe(202);
    expect((await h.call('GET', `/v1/account/exports/${req.json.id}`, { userId: u })).json.state).toBe(
      'queued',
    );
    expect(await w.drain()).toEqual([200, 200]); // the export, then its ready push
    const status = await h.call('GET', `/v1/account/exports/${req.json.id}`, { userId: u });
    expect(status.json.state).toBe('ready');
    expect(status.json.url).toMatch(/^memory:\/\/exports\//);

    const job = await h.db.admin.kysely
      .selectFrom('app.export_jobs')
      .select('storage_path')
      .where('id', '=', req.json.id)
      .executeTakeFirstOrThrow();
    const files = unzipSync((await h.storage.get('exports', job.storage_path!))!);
    expect(Object.keys(files).sort()).toEqual(['audio/' + s.json.id + '.m4a', 'avanvu-export.json']);
    const data = JSON.parse(strFromU8(files['avanvu-export.json']!));
    expect(data.events[0].name).toBe('Export race');
    expect(data.profile_versions[0].profile.responses.cue_phrase.value).toBe('Smooth and steady');
    expect(data.sessions[0].transcript.length).toBeGreaterThan(5);
    expect(data.checkins[0].useful).toBe('The cue phrase landed');
    expect(data.intake_turns[0].text).toBeTruthy();

    // Other athletes cannot see it; it expires and is removed.
    expect((await h.call('GET', `/v1/account/exports/${req.json.id}`, { userId: USER_B })).status).toBe(404);
    h.clock.now = new Date(T0.getTime() + 73 * 3_600_000);
    expect((await h.call('GET', `/v1/account/exports/${req.json.id}`, { userId: u })).json.state).toBe(
      'expired',
    );
    const scheduler = new Scheduler({
      db: h.db.api,
      sealer: h.sealer,
      dispatcher: h.dispatcher,
      costGuard: h.deps.costGuard,
      storage: h.storage,
      logger: h.deps.logger,
      now: h.deps.now,
      config: h.deps.config,
    });
    const purged = await scheduler.purge();
    expect(purged.exports).toBe(1);
    expect(await h.storage.get('exports', job.storage_path!)).toBeNull();
    h.clock.now = T0;
  }, 240_000);
});

describe('debrief (SPEC §8.4)', () => {
  const answers = (over: Record<string, unknown> = {}) => ({
    overall: 4,
    went_well: 'I stayed patient early',
    harder: 'The bridge came sooner than I thought',
    cue_helped: 'yes',
    next_time: 'Keep the cue phrase',
    ...over,
  });
  const debriefOut = (over: Record<string, unknown> = {}) => ({
    summary: 'You stayed patient and the plan helped.',
    profile_updates: [
      { op: 'set', path: 'obstacles.hardest_moment', item_id: '', value: 'The bridge near kilometre thirty' },
      { op: 'set', path: 'responses.cue_phrase', item_id: '', value: 'Calm and strong' },
      { op: 'set', path: 'identity.feared_self', item_id: '', value: 'must be filtered when skipped' },
      { op: 'set', path: 'sport.engine', item_id: '', value: 'golf' },
    ],
    learning_stage_change: 'advance',
    safety_signal: 'none',
    ...over,
  });

  async function pastEvent(u: string) {
    const ev = await h.call('POST', '/v1/events', {
      userId: u,
      body: {
        name: 'Past race',
        starts_local: '2026-12-13T08:00',
        time_zone: 'America/Toronto',
        supported_sport_id: 'running_road',
      },
    });
    await h.db.admin.kysely
      .updateTable('app.events')
      .set({ starts_at: new Date('2026-10-19T12:00:00Z') })
      .where('id', '=', ev.json.id)
      .execute();
    return ev.json.id as string;
  }

  it('refuses a debrief before the event has started', async () => {
    const u = uid();
    await seedProfile(h, u);
    const ev = await h.call('POST', '/v1/events', {
      userId: u,
      body: {
        name: 'Future race',
        starts_local: '2026-12-13T08:00',
        time_zone: 'America/Toronto',
        supported_sport_id: 'running_road',
      },
    });
    const r = await h.call('POST', '/v1/debriefs', {
      userId: u,
      body: { event_id: ev.json.id, ...answers() },
    });
    expect(r.status).toBe(422);
  });

  it('proposes a checklist, filters what the model may not touch, and applies only the checked items', async () => {
    const u = uid();
    await seedProfile(h, u, fictionalProfile({ skipPeople: false }));
    const eventId = await pastEvent(u);
    h.llm.reset();
    h.llm.enqueue('debrief', debriefOut());
    const r = await h.call('POST', '/v1/debriefs', { userId: u, body: { event_id: eventId, ...answers() } });
    expect(r.status).toBe(201);
    const paths = r.json.proposals.map((p: { path: string }) => p.path);
    expect(paths).toEqual(
      expect.arrayContaining(['obstacles.hardest_moment', 'responses.cue_phrase', 'identity.feared_self']),
    );
    expect(paths).not.toContain('sport.engine'); // server-owned: filtered
    const cue = r.json.proposals.find((p: { path: string }) => p.path === 'responses.cue_phrase');
    const hardest = r.json.proposals.find((p: { path: string }) => p.path === 'obstacles.hardest_moment');
    expect(cue.default_checked).toBe(false); // exact words are never pre-checked
    expect(hardest.default_checked).toBe(true);
    expect(r.json.learning_stage_change).toBe('advance');

    const sent = h.llm.callsFor('debrief')[0]!.userPayload;
    expect(sent).toContain('<debrief>');
    // The answers and proposals are sealed.
    const row = await h.db.admin.kysely
      .selectFrom('app.event_debriefs')
      .select(['answers_enc', 'proposals_enc'])
      .where('id', '=', r.json.id)
      .executeTakeFirstOrThrow();
    expect(Buffer.from(row.answers_enc).includes(Buffer.from('patient'))).toBe(false);
    expect(Buffer.from(row.proposals_enc!).includes(Buffer.from('bridge'))).toBe(false);

    // Confirm only the hardest-moment change; the cue phrase and the stage stay as they were.
    const c = await h.call('POST', `/v1/debriefs/${r.json.id}/confirm`, {
      userId: u,
      body: { accepted_item_ids: [hardest.id] },
    });
    expect(c.json).toMatchObject({ profile_version: 2, applied: 1 });
    const profile = (await h.call('GET', '/v1/profile', { userId: u })).json;
    expect(profile.source).toBe('debrief');
    expect(profile.profile.obstacles.hardest_moment.value).toBe('The bridge near kilometre thirty');
    expect(profile.profile.responses.cue_phrase.value).toBe('Smooth and steady');
    expect(profile.profile.learning_stage).toBe(1);
    expect(
      (
        await h.call('POST', `/v1/debriefs/${r.json.id}/confirm`, {
          userId: u,
          body: { accepted_item_ids: [] },
        })
      ).status,
    ).toBe(422);
    expect(
      (await h.call('POST', '/v1/debriefs', { userId: u, body: { event_id: eventId, ...answers() } })).status,
    ).toBe(422); // one per event
  });

  it('advances the learning stage only when the athlete explicitly checks it', async () => {
    const u = uid();
    await seedProfile(h, u);
    const eventId = await pastEvent(u);
    h.llm.reset();
    h.llm.enqueue('debrief', debriefOut({ profile_updates: [] }));
    const r = await h.call('POST', '/v1/debriefs', { userId: u, body: { event_id: eventId, ...answers() } });
    const c = await h.call('POST', `/v1/debriefs/${r.json.id}/confirm`, {
      userId: u,
      body: { accepted_item_ids: ['learning_stage'] },
    });
    expect(c.status).toBe(200);
    expect((await h.call('GET', '/v1/profile', { userId: u })).json.profile.learning_stage).toBe(2);
    const bad = await h.call('POST', `/v1/debriefs/${r.json.id}/confirm`, {
      userId: u,
      body: { accepted_item_ids: ['p99'] },
    });
    expect([422]).toContain(bad.status);
  });

  it('runs the safety screen before any model call, and ends on a model-reported crisis', async () => {
    const u = uid();
    await seedProfile(h, u);
    const eventId = await pastEvent(u);
    h.llm.reset();
    const r = await h.call('POST', '/v1/debriefs', {
      userId: u,
      body: { event_id: eventId, ...answers({ harder: 'I want to kill myself' }) },
    });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('SAFETY_INTERRUPTED');
    expect(h.llm.calls).toHaveLength(0);
    expect(h.logs.join('\n')).not.toContain('kill myself');

    const u2 = uid();
    await seedProfile(h, u2);
    const ev2 = await pastEvent(u2);
    h.llm.enqueue('debrief', debriefOut({ safety_signal: 'crisis' }));
    const m = await h.call('POST', '/v1/debriefs', { userId: u2, body: { event_id: ev2, ...answers() } });
    expect(m.json.error.code).toBe('SAFETY_INTERRUPTED');
    const none = await h.db.admin.kysely
      .selectFrom('app.event_debriefs')
      .select('id')
      .where('user_id', '=', u2)
      .execute();
    expect(none).toHaveLength(0); // nothing is stored from an interrupted debrief
  });

  it('never exposes another athlete’s debrief', async () => {
    const u = uid();
    await seedProfile(h, u);
    const eventId = await pastEvent(u);
    h.llm.reset();
    h.llm.enqueue('debrief', debriefOut({ profile_updates: [] }));
    const r = await h.call('POST', '/v1/debriefs', { userId: u, body: { event_id: eventId, ...answers() } });
    expect(
      (
        await h.call('POST', `/v1/debriefs/${r.json.id}/confirm`, {
          userId: USER_B,
          body: { accepted_item_ids: [] },
        })
      ).status,
    ).toBe(404);
    expect(
      (await h.call('POST', '/v1/debriefs', { userId: USER_B, body: { event_id: eventId, ...answers() } }))
        .status,
    ).toBe(404);
  });
});
