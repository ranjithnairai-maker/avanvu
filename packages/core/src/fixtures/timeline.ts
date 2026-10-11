/**
 * Fixture builder: a deterministic, fictional timeline that satisfies every deterministic rule for a given
 * profile. Used by tests, the fake LLM and the eval harness (EVALS §4). Never used in production paths.
 */
import type { AthleteProfile } from '../profile';
import {
  BLOCKS,
  BLOCK_SHARES,
  fearedSelfExpected,
  type Block,
  type SessionContext,
  type SessionTimeline,
  type TimelineItem,
} from '../timeline';

const POOL = [
  'You notice the steady rhythm of your breathing.',
  'Your shoulders settle and your hands feel loose.',
  'The air is cool on your arms and face.',
  'Each step lands softly beneath you.',
  'You hear the crowd, steady and warm.',
  'Your eyes stay on the horizon a few metres ahead.',
  'Your jaw softens and your hands open.',
  'You let the moment arrive without rushing it.',
];

export interface BuildOptions {
  context?: SessionContext;
  targetSeconds?: number;
  wpm?: number;
  /** Fraction of the session that is silence. */
  silence?: number;
  title?: string;
}

export function buildFictionalTimeline(profile: AthleteProfile, o: BuildOptions = {}): SessionTimeline {
  const context = o.context ?? 'training';
  const target = o.targetSeconds ?? 900;
  const wpm = o.wpm ?? 100;
  const sigma = o.silence ?? (context === 'training' ? 0.38 : context === 'night_before' ? 0.45 : 0.25);
  const feared = fearedSelfExpected(profile, context);

  const required: Partial<Record<Block, string[]>> = {
    intention: [`${profile.identity.intention?.value ?? ''}.`],
    obstacle: [
      ...profile.responses.if_then.map((p) => `When it comes, ${p.then.replace(/^I /, 'you ')}.`),
      `You tell yourself: ${profile.responses.cue_phrase?.value ?? ''}.`,
    ],
    return: [`${profile.identity.intention?.value ?? ''}.`],
    process: profile.performance.key_moments.map((m) => `${m.label}, ${m.description.toLowerCase()}.`),
    outcome_anchor: ['You press your thumb and finger together and feel it land.'],
  };
  if (feared) {
    required.feared_self = [
      'You see for a moment who you do not want to be on the day.',
      'Then you let that picture go.',
    ];
  }

  const shares = { ...BLOCK_SHARES[context] };
  if (feared) {
    shares.feared_self = 0.045;
    shares.process += 0.005;
  } else {
    shares.process += context === 'training' ? 0.05 : 0;
  }

  const items: TimelineItem[] = [];
  for (const block of BLOCKS) {
    const share = shares[block];
    if (share === 0 || (block === 'feared_self' && !feared)) continue;
    const secs = share * target;
    const budgetWords = Math.round(((secs * (1 - sigma)) / 60) * wpm);
    const sentences: string[] = [...(required[block] ?? [])];
    let words = sentences.join(' ').split(' ').length;
    let i = 0;
    while (words < budgetWords - 4) {
      const s = POOL[i++ % POOL.length] as string;
      sentences.push(s);
      words += s.split(' ').length;
    }
    const chunks: string[] = [];
    for (let n = 0; n < sentences.length; n += 3) chunks.push(sentences.slice(n, n + 3).join(' '));
    const spoken = chunks.join(' ').split(' ').length;
    const silenceSecs = Math.max(0.6 * chunks.length, secs - (spoken / wpm) * 60);
    const per = Math.max(600, Math.round((silenceSecs * 1000) / chunks.length));
    chunks.forEach((text, n) => {
      items.push({ type: 'speech', block, text, duration_ms: 0, label: '' });
      if (block === 'process' && n === 0) {
        const first = profile.performance.key_moments[0];
        const rt = Math.min(per - 100, (first?.realtime_seconds ?? 8) * 1000);
        items.push({
          type: 'rehearse',
          block,
          text: '',
          duration_ms: Math.max(1000, rt),
          label: first?.label.slice(0, 40) || 'the first moment',
        });
        if (per - rt > 600) items.push({ type: 'pause', block, text: '', duration_ms: per - rt, label: '' });
      } else {
        items.push({ type: 'pause', block, text: '', duration_ms: per, label: '' });
      }
    });
  }
  return {
    schema_version: 'session_timeline_v1',
    context,
    engine: profile.sport.engine,
    target_seconds: target,
    title: o.title ?? 'Steady through the hard part',
    items,
  };
}
