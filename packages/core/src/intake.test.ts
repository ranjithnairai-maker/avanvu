import { describe, expect, it } from 'vitest';
import {
  applyProfileUpdates,
  applyTurn,
  checkTermination,
  parseIntakeOutput,
  withStandardReplies,
  type ProfileUpdate,
} from './intake';
import { createEmptyProfile, generationMinimumMissing, type AthleteProfile } from './profile';

const fresh = (): AthleteProfile =>
  createEmptyProfile({
    supportedSportId: 'running_road',
    engine: 'endurance_v1',
    sportLabel: 'Marathon',
    voiceId: 'voice_a',
  });

const up = (op: ProfileUpdate['op'], path: string, value = '', item_id = ''): ProfileUpdate => ({
  op,
  path,
  value,
  item_id,
});

describe('applyProfileUpdates', () => {
  it('sets text fields and adds list items with source athlete', () => {
    const r = applyProfileUpdates(fresh(), [
      up('set', 'objective.primary', 'Run steady and finish strong'),
      up('add_item', 'scene.visual', 'Banners at the start line'),
    ]);
    expect(r.accepted).toBe(2);
    expect(r.profile.objective.primary).toEqual({ value: 'Run steady and finish strong', source: 'athlete' });
    expect(r.profile.scene.visual[0]?.value).toBe('Banners at the start line');
    expect(r.profile.scene.visual[0]?.item_id).toHaveLength(8);
  });

  it('drops non-allowlisted and server-owned paths', () => {
    const r = applyProfileUpdates(fresh(), [
      up('set', 'sport.engine', 'closed_skill_v1'),
      up('set', 'learning_stage', '3'),
      up('set', 'preferences.voice_id', 'x'),
    ]);
    expect(r.accepted).toBe(0);
    expect(r.rejected.map((x) => x.reason)).toEqual(Array(3).fill('path_not_allowlisted'));
    expect(r.profile.sport.engine).toBe('endurance_v1');
  });

  it('drops over-length values and over-count lists', () => {
    const r = applyProfileUpdates(fresh(), [up('set', 'responses.cue_phrase', 'x'.repeat(41))]);
    expect(r.rejected[0]?.reason).toBe('value_too_long');
    let p = fresh();
    for (let i = 0; i < 4; i++)
      p = applyProfileUpdates(p, [up('add_item', 'scene.smells', `smell ${i}`)]).profile;
    const over = applyProfileUpdates(p, [up('add_item', 'scene.smells', 'fifth')]);
    expect(over.rejected[0]?.reason).toBe('too_many_items');
  });

  it('replaces and removes items by id; unknown ids are rejected', () => {
    let p = applyProfileUpdates(fresh(), [up('add_item', 'scene.sounds', 'Crowd noise')]).profile;
    const id = p.scene.sounds[0]!.item_id;
    p = applyProfileUpdates(p, [up('replace_item', 'scene.sounds', 'Cowbells and cheering', id)]).profile;
    expect(p.scene.sounds[0]?.value).toBe('Cowbells and cheering');
    const bad = applyProfileUpdates(p, [up('remove_item', 'scene.sounds', '', 'nope1234')]);
    expect(bad.rejected[0]?.reason).toBe('item_not_found');
    p = applyProfileUpdates(p, [up('remove_item', 'scene.sounds', '', id)]).profile;
    expect(p.scene.sounds).toHaveLength(0);
  });

  it('parses JSON-encoded key moments and if-then plans, rejecting malformed ones', () => {
    const km = JSON.stringify({ label: 'Kilometre 32', description: 'Legs go heavy on the bridge' });
    const it_ = JSON.stringify({ when: 'doubt shows up', then: 'I breathe out and count steps' });
    const r = applyProfileUpdates(fresh(), [
      up('add_item', 'performance.key_moments', km),
      up('add_item', 'responses.if_then', it_),
      up('add_item', 'performance.key_moments', 'not json'),
      up('add_item', 'responses.if_then', JSON.stringify({ when: 'only when' })),
    ]);
    expect(r.accepted).toBe(2);
    expect(r.rejected.map((x) => x.reason)).toEqual(['invalid_value', 'invalid_value']);
    expect(r.profile.performance.key_moments[0]?.realtime_seconds).toBeNull();
  });

  it('later answers win: replacing an earlier value overwrites it', () => {
    let p = applyProfileUpdates(fresh(), [up('set', 'event.venue', 'City park loop')]).profile;
    p = applyProfileUpdates(p, [up('set', 'event.venue', 'Harbour front course')]).profile;
    expect(p.event.venue?.value).toBe('Harbour front course');
  });

  it('skip clears content, only on sensitive paths, and is never revisited', () => {
    let p = applyProfileUpdates(fresh(), [
      up('add_item', 'obstacles.negative_self_talk', 'I always fade'),
    ]).profile;
    expect(applyProfileUpdates(p, [up('mark_skipped', 'objective.primary')]).rejected[0]?.reason).toBe(
      'skip_not_allowed',
    );
    p = applyProfileUpdates(p, [up('mark_skipped', 'obstacles.negative_self_talk')]).profile;
    expect(p.obstacles.negative_self_talk).toEqual([]);
    expect(p.field_status['obstacles.negative_self_talk']).toBe('skipped');
    const again = applyProfileUpdates(p, [up('add_item', 'obstacles.negative_self_talk', 'inferred line')]);
    expect(again.rejected[0]?.reason).toBe('path_skipped');
    expect(again.profile.obstacles.negative_self_talk).toEqual([]);
  });

  it('never leaks values into rejection records', () => {
    const r = applyProfileUpdates(fresh(), [up('set', 'nope.path', 'SECRET TEXT')]);
    expect(JSON.stringify(r.rejected)).not.toContain('SECRET');
  });
});

describe('applyTurn statuses', () => {
  it('model can lower but not raise a field status', () => {
    const out = parseIntakeOutput({
      assistant_message: 'What do you hear?',
      quick_replies: [],
      profile_updates: [up('set', 'objective.primary', 'Finish the race feeling in control')],
      field_assessments: [{ path: 'objective.primary', quality: 'PARTIAL' }],
      safety_signal: 'None',
      next_focus: 'Objective',
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const r = applyTurn(fresh(), out.value);
    expect(r.profile.field_status['objective.primary']).toBe('partial');

    const out2 = parseIntakeOutput({
      ...out.value,
      field_assessments: [{ path: 'objective.process_success', quality: 'complete' }],
    });
    if (!out2.ok) throw new Error('parse');
    expect(applyTurn(fresh(), out2.value).profile.field_status['objective.process_success']).toBe('missing');
  });

  it('rejects structurally invalid output', () => {
    expect(parseIntakeOutput({ assistant_message: 'x' }).ok).toBe(false);
  });
});

describe('generation minimum and termination', () => {
  const complete = (): AthleteProfile => {
    const km = (l: string) => JSON.stringify({ label: l, description: `${l} description here` });
    return applyProfileUpdates(fresh(), [
      up('set', 'objective.primary', 'Finish feeling in control'),
      up('set', 'objective.process_success', 'Hold my pace for the first half'),
      up('add_item', 'scene.visual', 'Start line banners'),
      up('add_item', 'scene.sounds', 'Crowd noise'),
      up('add_item', 'performance.key_moments', km('Start')),
      up('add_item', 'performance.key_moments', km('Kilometre 32')),
      up('set', 'obstacles.hardest_moment', 'Heavy legs after the bridge'),
      up(
        'add_item',
        'responses.if_then',
        JSON.stringify({ when: 'legs get heavy', then: 'shorten my stride' }),
      ),
      up('set', 'responses.cue_phrase', 'Smooth and steady'),
      up('set', 'identity.intention', 'I run my own race'),
      up('set', 'outcome.body', 'Tired, proud, loose shoulders'),
    ]).profile;
  };

  it('lists missing minimum fields and clears once complete', () => {
    expect(generationMinimumMissing(fresh(), true).length).toBeGreaterThan(5);
    expect(generationMinimumMissing(complete(), true)).toEqual([]);
    expect(generationMinimumMissing(complete(), false)).toEqual(['event']);
  });

  it('turn cap does not end the interview until the minimum is met', () => {
    const d = checkTermination({
      athleteTurns: 40,
      activeMinutes: 3,
      profile: fresh(),
      eventReady: true,
      followUps: {},
    });
    expect(d.ready).toBe(false);
    const ok = checkTermination({
      athleteTurns: 40,
      activeMinutes: 3,
      profile: complete(),
      eventReady: true,
      followUps: {},
    });
    expect(ok).toEqual({ ready: true, reason: 'turn_cap' });
  });

  it('follow-up exhaustion counts as resolved', () => {
    const p = complete();
    const d = checkTermination({
      athleteTurns: 5,
      activeMinutes: 1,
      profile: p,
      eventReady: true,
      followUps: {},
    });
    expect(d.ready).toBe(false);
  });
});

describe('quick replies', () => {
  it('adds Skip on sensitive paths and Not sure elsewhere', () => {
    expect(withStandardReplies(['A', 'Skip'], 'obstacles.past_setback')).toEqual(['A', 'Skip']);
    expect(withStandardReplies(['A'], 'scene.visual')).toEqual(['A', 'Not sure']);
  });
});
