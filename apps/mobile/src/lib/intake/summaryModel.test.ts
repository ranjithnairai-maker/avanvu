import { describe, expect, it } from 'vitest';
import { fictionalProfile, generationMinimumMissing, createEmptyProfile } from '@avanvu/core';
import { buildSummary, editIsValid, editToUpdates, removeUpdate } from './summaryModel';

const profile = fictionalProfile();
const find = (sections: ReturnType<typeof buildSummary>, id: string) =>
  sections.flatMap((s) => s.rows).find((r) => r.id === id || r.path === id);

describe('summary card (SPEC §4.3)', () => {
  it('builds the nine sections in order with the cue phrase shown large', () => {
    const sections = buildSummary(profile, 'Harbour Marathon', []);
    expect(sections.map((s) => s.title)).toEqual([
      'My objective',
      'What success means',
      'My event',
      'The scene',
      'My key moments',
      'My hardest moment and my plan',
      'My cue phrase',
      'How I want to show up',
      'The finish',
    ]);
    const cue = sections.find((s) => s.title === 'My cue phrase')!.rows[0]!;
    expect(cue).toMatchObject({ display: 'Smooth and steady', large: true });
    expect(sections.flatMap((s) => s.rows).some((r) => r.add)).toBe(false);
  });

  it('shows Add rows for every missing generation-minimum field and nothing else', () => {
    const empty = createEmptyProfile({
      supportedSportId: 'golf',
      engine: 'closed_skill_v1',
      sportLabel: 'Golf',
      voiceId: 'v',
    });
    const missing = generationMinimumMissing(empty, true);
    const adds = buildSummary(empty, 'Club final', missing)
      .flatMap((s) => s.rows)
      .filter((r) => r.add);
    expect(adds.map((r) => r.path).sort()).toEqual(
      [
        'objective.primary',
        'objective.process_success',
        'scene.visual',
        'scene.sounds',
        'performance.key_moments',
        'obstacles.hardest_moment',
        'responses.if_then',
        'responses.cue_phrase',
        'identity.intention',
        'outcome.body',
      ].sort(),
    );
    // The Add rows need exactly the inputs the server expects.
    expect(
      find(buildSummary(empty, 'x', missing), 'add:responses.if_then')!.fields.map((f) => f.key),
    ).toEqual(['when', 'then']);
  });

  it('turns edits into the ops the server validates, for every row kind', () => {
    const sections = buildSummary(profile, 'x', []);
    const text = find(sections, 'objective.primary')!;
    expect(editToUpdates(text, { value: ' New objective ' })).toEqual([
      { op: 'set', path: 'objective.primary', item_id: '', value: 'New objective' },
    ]);

    const sound = sections.find((s) => s.title === 'The scene')!.rows.find((r) => r.path === 'scene.sounds')!;
    expect(editToUpdates(sound, { value: 'Wind' })).toEqual([
      { op: 'replace_item', path: 'scene.sounds', item_id: sound.itemId, value: 'Wind' },
    ]);
    expect(removeUpdate(sound)).toEqual([
      { op: 'remove_item', path: 'scene.sounds', item_id: sound.itemId, value: '' },
    ]);

    const km = sections.find((s) => s.title === 'My key moments')!.rows[0]!;
    const [u] = editToUpdates(km, { label: 'The bridge', description: 'Legs go heavy' });
    expect(u).toMatchObject({ op: 'replace_item', path: 'performance.key_moments', item_id: km.itemId });
    expect(JSON.parse(u!.value)).toEqual({ label: 'The bridge', description: 'Legs go heavy' });

    const plan = sections.flatMap((s) => s.rows).find((r) => r.kind === 'if_then')!;
    expect(JSON.parse(editToUpdates(plan, { when: 'doubt', then: 'I breathe' })[0]!.value)).toEqual({
      when: 'doubt',
      then: 'I breathe',
    });

    const add = find(
      buildSummary(
        createEmptyProfile({
          supportedSportId: 'golf',
          engine: 'closed_skill_v1',
          sportLabel: 'Golf',
          voiceId: 'v',
        }),
        'x',
        ['scene.visual'],
      ),
      'add:scene.visual',
    )!;
    expect(editToUpdates(add, { value: 'Fog on the first tee' })[0]).toMatchObject({
      op: 'add_item',
      item_id: '',
    });
    expect(removeUpdate(add)).toEqual([]);
  });

  it('validates edits against field limits and empties', () => {
    const cue = find(buildSummary(profile, 'x', []), 'responses.cue_phrase')!;
    expect(editIsValid(cue, { value: 'Calm' })).toBe(true);
    expect(editIsValid(cue, { value: '   ' })).toBe(false);
    expect(editIsValid(cue, { value: 'x'.repeat(41) })).toBe(false);
  });
});
