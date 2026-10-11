import { describe, expect, it } from 'vitest';
import { applyProfileUpdates, type ProfileUpdate } from './intake';
import { createEmptyProfile, type AthleteProfile } from './profile';
import {
  BLOCKS,
  BLOCK_SHARES,
  fitDurations,
  sessionTimelineSchema,
  validateTimeline,
  type Block,
  type SessionTimeline,
  type TimelineItem,
} from './timeline';

const WPM = 100;
const up = (op: ProfileUpdate['op'], path: string, value = ''): ProfileUpdate => ({
  op,
  path,
  value,
  item_id: '',
});

function profile(): AthleteProfile {
  const km = (l: string) => JSON.stringify({ label: l, description: `${l} on the course` });
  return applyProfileUpdates(
    createEmptyProfile({
      supportedSportId: 'running_road',
      engine: 'endurance_v1',
      sportLabel: 'Marathon',
      voiceId: 'v',
    }),
    [
      up('set', 'objective.primary', 'Finish feeling in control'),
      up('set', 'objective.process_success', 'Hold my pace through the first half'),
      up('add_item', 'scene.visual', 'Start line banners'),
      up('add_item', 'scene.sounds', 'Crowd noise'),
      up('add_item', 'performance.key_moments', km('Start')),
      up('add_item', 'performance.key_moments', km('Kilometre thirty two')),
      up('set', 'obstacles.hardest_moment', 'Heavy legs after the bridge'),
      up(
        'add_item',
        'responses.if_then',
        JSON.stringify({ when: 'legs get heavy', then: 'shorten my stride' }),
      ),
      up('set', 'responses.cue_phrase', 'Smooth and steady'),
      up('set', 'identity.intention', 'I run my own race'),
      up('set', 'outcome.body', 'Tired, proud, loose shoulders'),
    ],
  ).profile;
}

const POOL = [
  'You notice the steady rhythm of your breathing.',
  'Your shoulders settle and your hands feel loose.',
  'The air is cool on your arms and face.',
  'Each step lands softly beneath you.',
  'You hear the crowd, steady and warm.',
  'Your eyes stay on the road a few metres ahead.',
];

const required: Partial<Record<Block, string[]>> = {
  intention: ['I run my own race.'],
  obstacle: ['Your legs feel heavy and you shorten my stride.', 'You tell yourself: Smooth and steady.'],
  return: ['I run my own race.'],
};

function build(
  opts: { target?: number; context?: 'training' | 'night_before' | 'primer'; silence?: number } = {},
): SessionTimeline {
  const target = opts.target ?? 900;
  const context = opts.context ?? 'training';
  const sigma = opts.silence ?? 0.38;
  const shares = { ...BLOCK_SHARES[context] };
  const items: TimelineItem[] = [];
  for (const block of BLOCKS) {
    let share = shares[block];
    if (block === 'process') share += 0.05; // no feared self in this profile
    if (block === 'feared_self' || share === 0) continue;
    const secs = share * target;
    const wordsBudget = Math.round(((secs * (1 - sigma)) / 60) * WPM);
    const sentences: string[] = [...(required[block] ?? [])];
    let w = sentences.join(' ').split(' ').length;
    let i = 0;
    while (w < wordsBudget - 4) {
      const s = POOL[i++ % POOL.length]!;
      sentences.push(s);
      w += s.split(' ').length;
    }
    const chunks: string[] = [];
    for (let n = 0; n < sentences.length; n += 3) chunks.push(sentences.slice(n, n + 3).join(' '));
    const actualWords = chunks.join(' ').split(' ').length;
    const silenceSecs = secs - (actualWords / WPM) * 60;
    const per = Math.max(600, Math.round((silenceSecs * 1000) / chunks.length));
    chunks.forEach((text, n) => {
      items.push({ type: 'speech', block, text, duration_ms: 0, label: '' });
      if (block === 'process' && n === 0) {
        items.push({
          type: 'rehearse',
          block,
          text: '',
          duration_ms: per,
          label: 'first 100 m in real time',
        });
      } else items.push({ type: 'pause', block, text: '', duration_ms: per, label: '' });
    });
  }
  return {
    schema_version: 'session_timeline_v1',
    context,
    engine: 'endurance_v1',
    target_seconds: target,
    title: 'Patient through 32',
    items,
  };
}

describe('timeline schema', () => {
  it('accepts a well-formed timeline', () => {
    expect(sessionTimelineSchema.safeParse(build()).success).toBe(true);
  });
  it('rejects text on a pause, a label off rehearse and a silent speech item', () => {
    const base = build();
    const bad = (patch: Partial<TimelineItem>) =>
      sessionTimelineSchema.safeParse({ ...base, items: [{ ...base.items[1]!, ...patch }] }).success;
    expect(bad({ text: 'hello' })).toBe(false);
    expect(bad({ label: 'x' })).toBe(false);
    expect(
      sessionTimelineSchema.safeParse({ ...base, items: [{ ...base.items[0]!, text: '' }] }).success,
    ).toBe(false);
  });
  it('limits the title to 40 characters', () => {
    expect(sessionTimelineSchema.safeParse({ ...build(), title: 'x'.repeat(41) }).success).toBe(false);
  });
});

describe('deterministic validation', () => {
  const p = profile();

  it('passes a well-built 15 minute training timeline', () => {
    const r = validateTimeline(build(), { profile: p, wpm: WPM });
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
    expect(Math.abs(r.predictedSeconds - 900) / 900).toBeLessThan(0.08);
  });

  const mutate = (fn: (tl: SessionTimeline) => void) => {
    const tl = build();
    fn(tl);
    return validateTimeline(tl, { profile: p, wpm: WPM }).failures;
  };

  it('flags a missing cue phrase, intention and unrehearsed if-then', () => {
    const f = mutate((tl) => {
      for (const it of tl.items) {
        it.text = it.text
          .replace(/Smooth and steady/g, 'Stay calm')
          .replace(/shorten my stride/g, 'keep going');
      }
    });
    expect(f).toContain('cue_phrase_missing');
    expect(f).toContain('if_then_not_rehearsed');
    expect(
      mutate((tl) => tl.items.forEach((i) => (i.text = i.text.replace(/I run my own race\./g, 'Run well.')))),
    ).toEqual(expect.arrayContaining(['intention_missing', 'intention_missing_return']));
  });

  it('flags style and banned content', () => {
    const f = mutate((tl) => {
      const s = tl.items.find((i) => i.type === 'speech')!;
      s.text = 'Great! Manifest your result — push through the pain.';
    });
    expect(f).toEqual(
      expect.arrayContaining([
        'style_exclamation',
        'style_dash',
        'banned_manifestation',
        'banned_push_through_pain',
      ]),
    );
  });

  it('flags a rehearse item that does not follow speech in process or obstacle', () => {
    const f = mutate((tl) => {
      tl.items.unshift({ type: 'rehearse', block: 'arrive', text: '', duration_ms: 5000, label: 'x' });
    });
    expect(f).toContain('rehearse_placement');
  });

  it('flags out-of-range pauses and long consecutive silence', () => {
    const f = mutate((tl) => {
      const idx = tl.items.findIndex((i) => i.type === 'pause');
      tl.items[idx]!.duration_ms = 25_000;
      tl.items.splice(idx + 1, 0, {
        type: 'pause',
        block: tl.items[idx]!.block,
        text: '',
        duration_ms: 20_000,
        label: '',
      });
    });
    expect(f).toEqual(expect.arrayContaining(['pause_range', 'consecutive_silence']));
  });

  it('flags a timeline that is off target length and has the wrong silence share', () => {
    expect(
      validateTimeline({ ...build(), target_seconds: 600 }, { profile: p, wpm: WPM }).failures,
    ).toContain('duration_off_target');
    const quiet = validateTimeline(build({ silence: 0.1 }), { profile: p, wpm: WPM }).failures;
    expect(quiet).toContain('silence_share');
  });

  it('flags missing and out-of-order blocks and a feared self block when none is expected', () => {
    const f = mutate((tl) => {
      tl.items = tl.items.filter((i) => i.block !== 'hoped_self');
    });
    expect(f).toContain('block_missing');
    const g = mutate((tl) => {
      tl.items.push({ ...tl.items[0]!, block: 'arrive' });
    });
    expect(g).toContain('block_order');
    const h = mutate((tl) => {
      tl.items.splice(3, 0, {
        type: 'speech',
        block: 'feared_self',
        text: 'Who you do not want to be.',
        duration_ms: 0,
        label: '',
      });
    });
    expect(h).toContain('block_not_allowed');
  });

  it('never returns athlete text in failure ids', () => {
    const f = mutate((tl) => {
      tl.items[0]!.text = 'Manifest Smooth and steady';
    });
    expect(f.join(' ')).not.toMatch(/steady/i);
  });
});

describe('duration fitting', () => {
  const tl = build();
  const speechMs = tl.items
    .filter((i) => i.type === 'speech')
    .map((i) => (i.text.split(' ').length / WPM) * 60_000);

  it('lands within 2 % of target and never changes rehearse items', () => {
    const r = fitDurations(
      tl.items,
      speechMs.map((m) => m * 1.05),
      900,
    );
    expect(r.ok).toBe(true);
    expect(Math.abs(r.totalMs - 900_000) / 900_000).toBeLessThanOrEqual(0.02);
    const before = tl.items.filter((i) => i.type === 'rehearse').map((i) => i.duration_ms);
    expect(r.items.filter((i) => i.type === 'rehearse').map((i) => i.duration_ms)).toEqual(before);
    for (const i of r.items) if (i.type === 'pause') expect(i.duration_ms).toBeGreaterThanOrEqual(500);
  });

  it('fails cleanly with DURATION_UNFITTABLE when speech alone overshoots', () => {
    const r = fitDurations(
      tl.items,
      speechMs.map((m) => m * 2),
      900,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('DURATION_UNFITTABLE');
    expect(r.factor).toBeCloseTo(0.6, 5);
  });
});
