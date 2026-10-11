import { describe, expect, it } from 'vitest';
import { ENGINES, SPORTS } from '../sports';
import { CONTEXTS, validateTimeline, sessionTimelineSchema } from '../timeline';
import { generationMinimumMissing } from '../profile';
import { buildFictionalTimeline } from './timeline';
import { fictionalProfile } from './profile';

const sportFor = (engine: string) => SPORTS.find((s) => s.engine === engine)!;

describe('fictional profile fixture', () => {
  it('meets the generation minimum for every engine', () => {
    for (const engine of ENGINES) {
      const sport = sportFor(engine);
      const p = fictionalProfile({ engine, sportId: sport.id, sportLabel: sport.label });
      expect(generationMinimumMissing(p, true), engine).toEqual([]);
    }
  });
});

describe('fictional timeline builder satisfies every deterministic rule', () => {
  const cases = ENGINES.flatMap((engine) =>
    CONTEXTS.flatMap((context) => {
      const lengths = context === 'training' ? [10, 15] : context === 'night_before' ? [15] : [3, 5];
      return lengths.map((len) => ({ engine, context, len }));
    }),
  );

  it.each(cases)('$engine $context $len min', ({ engine, context, len }) => {
    const sport = sportFor(engine);
    const profile = fictionalProfile({
      engine,
      sportId: sport.id,
      sportLabel: sport.label,
      fearedSelf: true,
      skipPeople: true,
    });
    const tl = buildFictionalTimeline(profile, { context, targetSeconds: len * 60 });
    expect(sessionTimelineSchema.safeParse(tl).success).toBe(true);
    const r = validateTimeline(tl, { profile, wpm: 100 });
    expect(r.failures).toEqual([]);
  });

  it('includes the feared self block only in training when the athlete kept it', () => {
    const p = fictionalProfile({ fearedSelf: true });
    expect(
      buildFictionalTimeline(p, { context: 'training' }).items.some((i) => i.block === 'feared_self'),
    ).toBe(true);
    expect(
      buildFictionalTimeline(p, { context: 'night_before' }).items.some((i) => i.block === 'feared_self'),
    ).toBe(false);
    expect(
      buildFictionalTimeline(fictionalProfile(), { context: 'training' }).items.some(
        (i) => i.block === 'feared_self',
      ),
    ).toBe(false);
  });
});
