import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FakeTtsProvider,
  TtsError,
  fictionalProfile,
  type TtsProvider,
  type TtsRequest,
  type TtsResult,
} from '@avanvu/core';
import { LlmError } from '../ports/llm';
import { writeWav } from '../render/wav';
import { createHarness, USER_B, type Harness } from '../testing/harness';
import { grantPro, seedCatalog, seedProfile } from '../testing/fixtures';
import { createWorkerHarness, ffmpegBin } from '../testing/workerHarness';

const haveFfmpeg = !!ffmpegBin && existsSync(ffmpegBin);

let h: Harness;

class CountingTts implements TtsProvider {
  readonly name = 'counting';
  calls = 0;
  failures: Error[] = [];
  private readonly inner: FakeTtsProvider;
  constructor(wpm = 100) {
    this.inner = new FakeTtsProvider(wpm);
  }
  listVoices = () => this.inner.listVoices();
  async synthesize(req: TtsRequest): Promise<TtsResult> {
    this.calls++;
    const f = this.failures.shift();
    if (f) throw f;
    return this.inner.synthesize(req);
  }
}

const primer = { program_item_id: null, context: 'primer', length_min: 3 };
const create = (userId: string, body: Record<string, unknown> = primer) =>
  h.call('POST', '/v1/sessions', { userId, body });
const stateOf = async (id: string) =>
  h.db.admin.kysely
    .selectFrom('app.sessions')
    .select(['state', 'failure_code', 'audio_path', 'sha256', 'bytes', 'duration_ms'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
const ledger = async (sessionId: string) =>
  (
    await h.db.admin.kysely
      .selectFrom('app.usage_ledger')
      .select(['entry_type', 'quantity'])
      .where('session_id', '=', sessionId)
      .orderBy('created_at')
      .execute()
  ).map((r) => `${r.entry_type}:${r.quantity}`);

/** A fresh Pro athlete so allowance and rate limits never interfere between tests. */
let userCounter = 0;
async function freshPro(): Promise<string> {
  const u = `a0000000-0000-4000-8000-${String(++userCounter).padStart(12, '0')}`;
  await seedProfile(h, u, fictionalProfile({ voiceId: 'voice_a' }));
  await grantPro(h, u);
  return u;
}

beforeAll(async () => {
  h = await createHarness({ now: new Date('2026-10-20T15:00:00Z') });
  await seedCatalog(h);
  const rate = 22050;
  const s = new Int16Array(rate * 4);
  for (let i = 0; i < s.length; i++) s[i] = Math.round(Math.sin((2 * Math.PI * 110 * i) / rate) * 6000);
  const wav = writeWav({ sampleRate: rate, channels: 1, samples: s });
  for (const p of ['warm_1', 'drone_1', 'pulse_1'])
    await h.storage.put('music', `music/${p}.wav`, wav, 'audio/wav');
});
afterAll(() => h.close());

describe.skipIf(!haveFfmpeg)('render worker (CONTRACTS §8.2)', () => {
  it('rejects task deliveries without a valid OIDC token or with the wrong caller', async () => {
    const w = await createWorkerHarness(h);
    const body = { job_id: crypto.randomUUID() };
    expect((await w.deliver('/tasks/render', body, null)).status).toBe(401);
    expect((await w.deliver('/tasks/render', body, 'garbage')).status).toBe(401);
    expect((await w.deliver('/tasks/render', { nope: 1 })).status).toBe(400);
    // A job id alone is never authority: an unknown job is simply a no-op for a valid caller.
    expect((await w.deliver('/tasks/render', body)).json).toEqual({ result: 'lease_held' });
  });

  it('renders a session end to end: ready, audio uploaded, ledger committed, usage recorded, one push', async () => {
    const u = await freshPro();
    const w = await createWorkerHarness(h);
    w.scriptFor(fictionalProfile());
    await h.call('POST', '/v1/devices', {
      userId: u,
      body: { push_token: 'ExponentPushToken[aaaaaaaaaaaaaaaa]' },
    });
    const made = await create(u);
    expect(made.status).toBe(202);

    // The render task, then the push task it queued after the final transition.
    const statuses = await w.drain();
    expect(statuses).toEqual([200, 200]);
    const s = await stateOf(made.json.id);
    expect(s.state).toBe('ready');
    expect(s.audio_path).toBe(`audio/${u}/${made.json.id}/1.m4a`);
    expect(Math.abs(s.duration_ms! - 180_000) / 180_000).toBeLessThanOrEqual(0.02);

    // The stored object is the file whose hash the API reports.
    const stored = await h.storage.get('audio', s.audio_path!);
    expect(stored!.byteLength).toBe(Number(s.bytes));
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(stored!).digest('hex')).toBe(s.sha256);

    expect(await ledger(made.json.id)).toEqual(['reserve:-1', 'commit:0']);
    const usage = await h.db.admin.kysely
      .selectFrom('app.vendor_usage')
      .select(['kind', 'characters'])
      .where('user_id', '=', u)
      .execute();
    expect(usage.map((x) => x.kind).sort()).toEqual(['judge', 'script', 'tts']);
    expect(usage.find((x) => x.kind === 'tts')!.characters).toBeGreaterThan(500);
    expect(h.storage.count('jobs')).toBe(0); // chunk cache is cleaned up at the end

    // The script is sealed; the transcript endpoint derives from it.
    const script = await h.db.admin.kysely
      .selectFrom('app.session_scripts')
      .select('timeline_enc')
      .where('session_id', '=', made.json.id)
      .executeTakeFirstOrThrow();
    expect(Buffer.from(script.timeline_enc).includes(Buffer.from('steady'))).toBe(false);
    const tr = await h.call('GET', `/v1/sessions/${made.json.id}/transcript`, { userId: u });
    expect(tr.json.items.some((i: { type: string }) => i.type === 'speech')).toBe(true);
    const dl = await h.call('POST', `/v1/sessions/${made.json.id}/download-url`, { userId: u });
    expect(dl.json).toMatchObject({ sha256: s.sha256, expires_in: 900 });
    const verified = await h.call('POST', `/v1/sessions/${made.json.id}/download-verified`, {
      userId: u,
      body: { sha256: s.sha256, bytes: Number(s.bytes) },
    });
    expect(verified.status).toBe(200);
    expect(
      (
        await h.call('POST', `/v1/sessions/${made.json.id}/download-verified`, {
          userId: u,
          body: { sha256: 'f'.repeat(64), bytes: 1 },
        })
      ).status,
    ).toBe(422);

    // The ready push was queued once and delivered once.
    expect(await w.drain()).toEqual([]);
    expect(w.push.sent).toHaveLength(1);
    expect(w.push.sent[0]).toMatchObject({ kind: 'session_ready', title: 'Your session is ready' });
    expect(JSON.stringify(w.push.sent[0])).not.toMatch(/steady|marathon/i);
  }, 180_000);

  it('survives forced duplicate delivery: one render, one charge, one commit, one push', async () => {
    const u = await freshPro();
    const tts = new CountingTts();
    const w = await createWorkerHarness(h, { tts });
    w.scriptFor(fictionalProfile());
    await h.call('POST', '/v1/devices', {
      userId: u,
      body: { push_token: 'ExponentPushToken[bbbbbbbbbbbbbbbb]' },
    });
    const made = await create(u);
    h.storage.puts = 0;
    const scriptCallsBefore = h.llm.callsFor('script').length;
    const statuses = await w.drain({ duplicate: true });
    expect(statuses.every((s) => s === 200)).toBe(true);
    expect((await stateOf(made.json.id)).state).toBe('ready');
    expect(h.llm.callsFor('script').length - scriptCallsBefore).toBe(1);
    expect(await ledger(made.json.id)).toEqual(['reserve:-1', 'commit:0']);
    const ttsRows = await h.db.admin.kysely
      .selectFrom('app.vendor_usage')
      .select('id')
      .where('user_id', '=', u)
      .where('kind', '=', 'tts')
      .execute();
    expect(ttsRows).toHaveLength(1);
    const audio = await h.storage.list('audio', `audio/${u}/${made.json.id}/`);
    expect(audio).toHaveLength(1);
    await w.drain({ duplicate: true });
    expect(w.push.sent).toHaveLength(1);
    const deliveries = await h.db.admin.kysely
      .selectFrom('app.notification_deliveries')
      .select('id')
      .where('subject_id', '=', made.json.id)
      .execute();
    expect(deliveries).toHaveLength(1);
  }, 180_000);

  it('recovers from a failure mid-synthesis without paying twice or regenerating the script', async () => {
    const u = await freshPro();
    const tts = new CountingTts();
    const w = await createWorkerHarness(h, { tts, chunkRetries: 0 });
    w.scriptFor(fictionalProfile());
    const made = await create(u);
    const scriptBefore = h.llm.callsFor('script').length;

    tts.failures = [new TtsError('503 from vendor', true)];
    const first = await w.drain({ maxAttempts: 1 });
    expect(first).toEqual([503]);
    const mid = await stateOf(made.json.id);
    expect(mid.state).toBe('synthesizing');
    const chunksAfterFirst = h.storage.count('jobs');
    expect(chunksAfterFirst).toBeGreaterThan(0); // the chunks that did succeed are cached

    // Cloud Tasks retries the same task: the script checkpoint and the cached chunks are reused.
    const job = await h.db.admin.kysely
      .selectFrom('app.render_jobs')
      .select('id')
      .where('session_id', '=', made.json.id)
      .executeTakeFirstOrThrow();
    const retry = await w.deliver('/tasks/render', { job_id: job.id });
    expect(retry.status).toBe(200);
    expect((await stateOf(made.json.id)).state).toBe('ready');
    expect(h.llm.callsFor('script').length - scriptBefore).toBe(1); // generated once
    const distinct = new Set(
      (
        await h.db.admin.kysely
          .selectFrom('app.vendor_usage')
          .select('characters')
          .where('user_id', '=', u)
          .where('kind', '=', 'tts')
          .execute()
      ).map((r) => r.characters),
    );
    expect(distinct.size).toBe(1); // a single charge covering only what the retry synthesized plus the earlier cached text
    expect(await ledger(made.json.id)).toEqual(['reserve:-1', 'commit:0']);
  }, 180_000);

  it('does nothing when another attempt holds the lease', async () => {
    const u = await freshPro();
    const w = await createWorkerHarness(h);
    w.scriptFor(fictionalProfile());
    const made = await create(u);
    const job = await h.db.admin.kysely
      .selectFrom('app.render_jobs')
      .select('id')
      .where('session_id', '=', made.json.id)
      .executeTakeFirstOrThrow();
    await h.db.admin.kysely
      .updateTable('app.render_jobs')
      .set({
        lease_owner: 'someone-else',
        lease_expires_at: new Date(h.clock.now.getTime() + 60_000),
        state: 'running',
      })
      .where('id', '=', job.id)
      .execute();
    const r = await w.deliver('/tasks/render', { job_id: job.id });
    expect(r.json).toEqual({ result: 'lease_held' });
    expect((await stateOf(made.json.id)).state).toBe('queued');
    await h.queue.drain(async () => ({ status: 200 }));
  });

  it('fails permanently after exhausted retries, and gives the allowance back', async () => {
    const u = await freshPro();
    const w = await createWorkerHarness(h);
    h.llm.fallback('script', () => new LlmError('vendor down', 'unavailable'));
    const made = await create(u);
    const statuses = await w.drain({ maxAttempts: 5 });
    expect(statuses).toEqual([503, 503, 200]);
    const s = await stateOf(made.json.id);
    expect(s).toMatchObject({ state: 'failed', failure_code: 'ATTEMPTS_EXHAUSTED' });
    expect(await ledger(made.json.id)).toEqual(['reserve:-1', 'reverse:1']);
    const view = await h.call('GET', `/v1/sessions/${made.json.id}`, { userId: u });
    expect(view.json).toMatchObject({ status: 'failed', failure_code: 'ATTEMPTS_EXHAUSTED' });
    // The athlete can create another session straight away.
    h.llm.reset();
    w.scriptFor(fictionalProfile());
    expect((await create(u)).status).toBe(202);
    await w.drain();
  }, 180_000);

  it('fails at once, without retries, when the script cannot be repaired', async () => {
    const u = await freshPro();
    const w = await createWorkerHarness(h);
    h.llm.reset();
    h.llm.fallback('script', () => ({ schema_version: 'session_timeline_v1', nonsense: true }));
    const made = await create(u);
    const statuses = await w.drain({ maxAttempts: 5 });
    expect(statuses).toEqual([200]);
    expect(await stateOf(made.json.id)).toMatchObject({
      state: 'failed',
      failure_code: 'VALIDATION_FAILED_AFTER_REPAIR',
    });
    expect(await ledger(made.json.id)).toEqual(['reserve:-1', 'reverse:1']);
    expect(h.llm.callsFor('script')).toHaveLength(2); // the first attempt and its single repair
    // The honest message is what the athlete sees; no silent generic fallback exists.
    const view = await h.call('GET', `/v1/sessions/${made.json.id}`, { userId: u });
    expect(view.json.status).toBe('failed');
  }, 180_000);

  it('fails with DURATION_UNFITTABLE when speech overshoots, never by re-synthesizing', async () => {
    const u = await freshPro();
    const slow = new CountingTts(25);
    const w = await createWorkerHarness(h, { tts: slow });
    h.llm.reset();
    w.scriptFor(fictionalProfile());
    const made = await create(u);
    const statuses = await w.drain({ maxAttempts: 5 });
    expect(statuses).toEqual([200]);
    expect(await stateOf(made.json.id)).toMatchObject({
      state: 'failed',
      failure_code: 'DURATION_UNFITTABLE',
    });
    expect(await ledger(made.json.id)).toEqual(['reserve:-1', 'reverse:1']);
  }, 180_000);

  it('leaves a canceled session alone', async () => {
    const u = await freshPro();
    const w = await createWorkerHarness(h);
    h.llm.reset();
    w.scriptFor(fictionalProfile());
    const made = await create(u);
    await h.call('POST', `/v1/sessions/${made.json.id}/cancel`, { userId: u });
    const before = h.llm.calls.length;
    expect(await w.drain()).toEqual([200]);
    expect(h.llm.calls.length).toBe(before);
    expect((await stateOf(made.json.id)).state).toBe('canceled');
    expect(await ledger(made.json.id)).toEqual(['reserve:-1', 'reverse:1']);
  });

  it('links a program item: the first training session stores a text-free core scene', async () => {
    const u = await freshPro();
    const w = await createWorkerHarness(h);
    h.llm.reset();
    w.scriptFor(fictionalProfile());
    const ev = await h.call('POST', '/v1/events', {
      userId: u,
      body: {
        name: 'Core scene race',
        starts_local: '2026-12-13T08:00',
        time_zone: 'America/Toronto',
        supported_sport_id: 'running_road',
      },
    });
    const prog = await h.call('GET', `/v1/programs/${ev.json.program_id}`, { userId: u });
    const item = prog.json.items.find((i: { kind: string }) => i.kind === 'training');
    const made = await create(u, { program_item_id: item.id, context: 'training', length_min: 10 });
    await w.drain();
    expect((await stateOf(made.json.id)).state).toBe('ready');
    const row = await h.db.admin.kysely
      .selectFrom('app.program_items')
      .select(['state', 'core_scene'])
      .where('id', '=', item.id)
      .executeTakeFirstOrThrow();
    expect(row.state).toBe('ready');
    expect(Object.keys(row.core_scene as object).sort()).toEqual([
      'has_obstacle',
      'if_then_ids',
      'key_moment_ids',
      'visual_ids',
    ]);
    expect(JSON.stringify(row.core_scene)).not.toMatch(/legs|stride|banner/i);
  }, 240_000);

  it('keeps every athlete’s audio and script private', async () => {
    const a = await freshPro();
    const w = await createWorkerHarness(h);
    h.llm.reset();
    w.scriptFor(fictionalProfile());
    const made = await create(a);
    await w.drain();
    expect(
      (await h.call('POST', `/v1/sessions/${made.json.id}/download-url`, { userId: USER_B })).status,
    ).toBe(404);
    expect((await h.call('GET', `/v1/sessions/${made.json.id}/transcript`, { userId: USER_B })).status).toBe(
      404,
    );
  }, 180_000);
});
