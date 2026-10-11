import { describe, expect, it } from 'vitest';
import { JUDGE_CHECK_IDS, buildFictionalTimeline, fictionalProfile } from '@avanvu/core';
import { FakeLlm, LlmError } from '../ports/llm';
import { NonRetryableJobError, generateTimeline } from './generate';

const models = { script: 'script-model', judge: 'judge-model', effort: 'medium' };
const profile = fictionalProfile({ fearedSelf: true, skipPeople: true });
const input = { profile, context: 'training' as const, lengthMin: 15, wpm: 100, coreScene: null, recentCheckins: [] };
const good = () => buildFictionalTimeline(profile, { context: 'training', targetSeconds: 900 });
const judgeOk = () => ({ checks: JUDGE_CHECK_IDS.map((id) => ({ id, pass: true, note: '' })) });
const judgeFail = (id: string) => ({ checks: JUDGE_CHECK_IDS.map((c) => ({ id: c, pass: c !== id, note: c === id ? 'Adds a person the athlete did not mention.' : '' })) });

describe('script generation', () => {
  it('returns a validated timeline after one script call and one judge call', async () => {
    const llm = new FakeLlm().enqueue('script', good()).enqueue('judge', judgeOk());
    const r = await generateTimeline(llm, models, input);
    expect(r.repaired).toBe(false);
    expect(r.usages.map((u) => u.kind)).toEqual(['script', 'judge']);
    expect(r.timeline.context).toBe('training');
    expect(r.versions).toMatchObject({ schema: 'session_timeline_v1', models: { script: 'script-model' }, repaired: false });
    expect(String(r.versions.prompt)).toMatch(/^script:[0-9a-f]{12}$/);
  });

  it('overrides server-owned fields the model tries to set and normalises enum case', async () => {
    const t = good();
    const sneaky = { ...t, engine: 'closed_skill_v1', target_seconds: 60, context: 'primer', items: t.items.map((i) => ({ ...i, type: i.type.toUpperCase(), block: i.block.toUpperCase() })) };
    const llm = new FakeLlm().enqueue('script', sneaky).enqueue('judge', judgeOk());
    const r = await generateTimeline(llm, models, input);
    expect(r.timeline).toMatchObject({ engine: 'endurance_v1', target_seconds: 900, context: 'training' });
  });

  it('sends the athlete profile as tagged data, lists skipped paths, and omits server-owned fields', async () => {
    const llm = new FakeLlm().enqueue('script', good()).enqueue('judge', judgeOk());
    await generateTimeline(llm, models, input);
    const sent = llm.callsFor('script')[0]!.userPayload;
    expect(sent).toContain('<athlete_profile>');
    expect(sent).toContain('outcome.people');
    expect(sent).not.toContain('field_status');
    expect(sent).not.toContain('voice_a');
    expect(sent).toContain('Include a feared_self block: yes');
  });

  it('repairs once when deterministic validation fails, passing rule ids only', async () => {
    const bad = good();
    bad.items[0] = { ...bad.items[0]!, text: 'Great start!' };
    const llm = new FakeLlm().enqueue('script', bad, good()).enqueue('judge', judgeOk());
    const r = await generateTimeline(llm, models, input);
    expect(r.repaired).toBe(true);
    const repairCall = llm.callsFor('script')[1]!;
    expect(repairCall.repair).toBe(true);
    expect(repairCall.userPayload).toContain('style_exclamation');
    expect(repairCall.userPayload).not.toContain('Great start');
  });

  it('shares the single repair between validation and the judge: a judge failure then a clean rewrite passes', async () => {
    const llm = new FakeLlm().enqueue('script', good(), good()).enqueue('judge', judgeFail('no_invented_facts'), judgeOk());
    const r = await generateTimeline(llm, models, input);
    expect(r.repaired).toBe(true);
    expect(llm.callsFor('script')).toHaveLength(2);
    expect(llm.callsFor('script')[1]!.userPayload).toContain('judge_no_invented_facts');
  });

  it('fails without a second repair when the rewrite still fails (non-retryable)', async () => {
    const bad = good();
    bad.items[0] = { ...bad.items[0]!, text: 'Great start!' };
    const llm = new FakeLlm().enqueue('script', bad, bad);
    await expect(generateTimeline(llm, models, input)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED_AFTER_REPAIR',
      failedRules: expect.arrayContaining(['style_exclamation']),
    });
    expect(llm.callsFor('script')).toHaveLength(2);
    expect(llm.callsFor('judge')).toHaveLength(0);
  });

  it('fails when the judge rejects the rewrite too', async () => {
    const llm = new FakeLlm().enqueue('script', good(), good()).enqueue('judge', judgeFail('no_skipped_content'), judgeFail('no_skipped_content'));
    const err = await generateTimeline(llm, models, input).catch((e) => e);
    expect(err).toBeInstanceOf(NonRetryableJobError);
    expect(err.failedRules).toContain('judge_no_skipped_content');
    expect(llm.callsFor('script')).toHaveLength(2);
  });

  it('treats structurally invalid script output like a failed check', async () => {
    const llm = new FakeLlm().enqueue('script', { nope: true }, good()).enqueue('judge', judgeOk());
    const r = await generateTimeline(llm, models, input);
    expect(r.repaired).toBe(true);
  });

  it('propagates vendor errors as retryable (no repair is spent on them)', async () => {
    const llm = new FakeLlm().enqueue('script', new LlmError('503', 'unavailable'));
    await expect(generateTimeline(llm, models, input)).rejects.toBeInstanceOf(LlmError);
  });

  it('writes banned content into rule ids, never into the failure list text', async () => {
    const bad = good();
    bad.items[0] = { ...bad.items[0]!, text: 'You will win, guaranteed. Manifest it.' };
    const llm = new FakeLlm().enqueue('script', bad, bad);
    const err = await generateTimeline(llm, models, input).catch((e) => e);
    expect(err.failedRules).toEqual(expect.arrayContaining(['banned_manifestation', 'banned_guaranteed_results']));
    expect(JSON.stringify(err.failedRules)).not.toContain('Manifest it');
  });
});
