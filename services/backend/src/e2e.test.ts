/**
 * The whole product loop on the real code paths with fake vendors (SPEC §14.1 internal alpha, automated):
 * event -> interview -> summary -> confirm -> preferences -> session -> render -> ready -> download -> check-in.
 */
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DevLlm } from './dev/devLlm';
import { createHarness, USER_A, type Harness } from './testing/harness';
import { grantPro, seedCatalog } from './testing/fixtures';
import { createWorkerHarness, ffmpegBin, type WorkerHarness } from './testing/workerHarness';

let h: Harness;
let w: WorkerHarness;
const haveFfmpeg = !!ffmpegBin && existsSync(ffmpegBin);

beforeAll(async () => {
  h = await createHarness({ now: new Date('2026-10-20T15:00:00Z') });
  await seedCatalog(h);
  const dev = new DevLlm();
  for (const task of ['intake', 'script', 'judge', 'debrief'] as const) {
    h.llm.fallback(task, async (req) => (await dev.complete(req)).output);
  }
  w = await createWorkerHarness(h);
});
afterAll(() => h.close());

describe.skipIf(!haveFfmpeg)('end to end', () => {
  it('takes an athlete from first launch to a playable personalised session', async () => {
    const u = USER_A;
    // Onboarding.
    expect(
      (await h.call('POST', '/v1/age-assurance', { userId: u, body: { method: 'declared_age_range' } }))
        .status,
    ).toBe(200);
    expect(
      (
        await h.call('POST', '/v1/consents', {
          userId: u,
          body: { consents: [{ kind: 'processing', version: '2026-10', accepted: true }] },
        })
      ).status,
    ).toBe(201);
    const ev = await h.call('POST', '/v1/events', {
      userId: u,
      body: {
        name: 'Fictional Harbour Marathon',
        starts_local: '2026-12-13T08:00',
        time_zone: 'America/Toronto',
        supported_sport_id: 'running_road',
      },
    });
    expect(ev.status).toBe(201);

    // Interview until the server says the summary is ready.
    const conv = await h.call('POST', '/v1/intake/conversations', {
      userId: u,
      body: { event_id: ev.json.id },
    });
    let c = { id: conv.json.id as string, revision: conv.json.revision as number };
    const answers = [
      'Finish feeling in control of my race',
      'Hold my planned pace through the first half',
      'A first marathon after a hard year of training',
      'The harbour front course by the old lighthouse',
      'Banners at the start line and a gray sky',
      'Bright jackets and breath clouds in the cold',
      'Mist rising off the river at dawn',
      'Cowbells and cheering all along the barrier',
      'Shoes on wet pavement and quiet breathing',
      'Cold air and light drizzle on my face',
      'Wet road and a soft foam shoe feel',
      'Shake out my arms, three slow breaths, first step',
      'The start gun goes and I settle into the crowd',
      'Kilometre thirty two where my legs go heavy',
      'My watch pace and my breathing rhythm',
      'Heavy legs and doubt right after the bridge',
      'A strong headwind along the waterfront',
      'When my legs get heavy I shorten my stride and breathe out',
      'Smooth and steady',
      'Relaxed shoulders, quiet mind, steady stride',
      'I run my own race',
      'Crossing the line with my arms up',
      'Tired, proud, loose shoulders',
      'Quiet pride and relief',
      'Find my family and sit down on the grass',
    ];
    let state = 'AWAITING_USER';
    for (let i = 0; i < answers.length && state !== 'READY_FOR_SUMMARY'; i++) {
      const r = await h.call('POST', '/v1/intake/turns', {
        userId: u,
        body: {
          conversation_id: c.id,
          client_message_id: crypto.randomUUID(),
          expected_revision: c.revision,
          input_mode: 'text',
          content: answers[i],
        },
      });
      expect(r.status, `turn ${i + 1}`).toBe(200);
      state = r.json.state;
      c = { id: c.id, revision: r.json.revision };
    }
    if (state !== 'READY_FOR_SUMMARY') {
      const v = await h.call('GET', `/v1/intake/conversations/${c.id}`, { userId: u });
      const pending = Object.entries(v.json.profile.field_status)
        .filter(([, s]) => s !== 'complete')
        .map(([p, s]) => `${p}:${s}`);
      throw new Error(
        `not ready: ${JSON.stringify(pending)} missing=${JSON.stringify(v.json.minimum_missing)} phase=${v.json.phase}`,
      );
    }
    expect(state).toBe('READY_FOR_SUMMARY');

    const summary = await h.call('GET', `/v1/intake/conversations/${c.id}`, { userId: u });
    expect(summary.json.minimum_missing).toEqual([]);
    expect(summary.json.profile.responses.cue_phrase.value).toBe('Smooth and steady');

    // Confirm, then delivery preferences.
    expect((await h.call('POST', `/v1/intake/conversations/${c.id}/confirm`, { userId: u })).status).toBe(
      200,
    );
    const prefs = await h.call('PUT', '/v1/profile/preferences', {
      userId: u,
      body: {
        perspective: 'first_person',
        voice_id: 'voice_a',
        music_style: 'ambient_warm',
        training_length_min: 10,
        primer_length_min: 3,
        feared_self_enabled: true,
      },
    });
    expect(prefs.status).toBe(200);

    // Free first session: the allowance for a free training session.
    const made = await h.call('POST', '/v1/sessions', {
      userId: u,
      body: { program_item_id: null, context: 'training', length_min: 10 },
    });
    expect(made.status).toBe(202);
    h.storage.puts = 0;
    expect(await w.drain()).toEqual([200, 200]); // render, then the ready push
    const view = await h.call('GET', `/v1/sessions/${made.json.id}`, { userId: u });
    expect(view.json).toMatchObject({ status: 'ready', state: 'ready' });
    expect(Math.abs(view.json.duration_ms - 600_000) / 600_000).toBeLessThanOrEqual(0.02);

    // The script uses the athlete's own words, verbatim (CONTRACTS §6.1).
    const transcript = await h.call('GET', `/v1/sessions/${made.json.id}/transcript`, { userId: u });
    const text = transcript.json.items
      .filter((i: { type: string }) => i.type === 'speech')
      .map((i: { text: string }) => i.text)
      .join(' ');
    expect(text).toContain('Smooth and steady');
    expect(text).toContain('I run my own race');

    // Download, verify, play, check in.
    const dl = await h.call('POST', `/v1/sessions/${made.json.id}/download-url`, { userId: u });
    expect(dl.status).toBe(200);
    expect(
      (
        await h.call('POST', `/v1/sessions/${made.json.id}/download-verified`, {
          userId: u,
          body: { sha256: dl.json.sha256, bytes: dl.json.bytes },
        })
      ).status,
    ).toBe(200);
    const plays = [
      {
        client_event_id: crypto.randomUUID(),
        mark: 'start',
        position_ms: 0,
        occurred_at: '2026-10-20T15:05:00Z',
      },
    ];
    expect(
      (await h.call('POST', `/v1/sessions/${made.json.id}/plays`, { userId: u, body: { plays } })).status,
    ).toBe(200);
    expect(
      (
        await h.call('POST', `/v1/sessions/${made.json.id}/checkin`, {
          userId: u,
          body: { vividness: 4, readiness: 5 },
        })
      ).status,
    ).toBe(201);

    // The free grant is spent; the next paid action is gated until the athlete upgrades.
    const second = await h.call('POST', '/v1/sessions', {
      userId: u,
      body: { program_item_id: null, context: 'training', length_min: 10 },
    });
    expect(second.json.error.code).toBe('ALLOWANCE_EXHAUSTED');
    await grantPro(h, u);
    const third = await h.call('POST', '/v1/sessions', {
      userId: u,
      body: { program_item_id: null, context: 'training', length_min: 10 },
    });
    expect(third.status).toBe(202);
    h.queue.tasks.length = 0;
  }, 300_000);
});
