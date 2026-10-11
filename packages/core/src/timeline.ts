/**
 * Session timeline contract, deterministic validation and post-synthesis duration fitting
 * (CONTRACTS §6, SPEC §3.3). 🔒 sensitive. The renderer reads only a validated, frozen timeline.
 */
import { z } from 'zod';
import type { AthleteProfile } from './profile';
import { findBannedContent } from './safety/lexicon';

export const TIMELINE_SCHEMA_VERSION = 'session_timeline_v1' as const;

export const CONTEXTS = ['training', 'night_before', 'primer'] as const;
export type SessionContext = (typeof CONTEXTS)[number];

export const BLOCKS = [
  'arrive',
  'intention',
  'feared_self',
  'hoped_self',
  'process',
  'obstacle',
  'outcome_anchor',
  'return',
] as const;
export type Block = (typeof BLOCKS)[number];

export const ITEM_TYPES = ['speech', 'pause', 'rehearse'] as const;

export const timelineItemSchema = z
  .object({
    type: z.enum(ITEM_TYPES),
    block: z.enum(BLOCKS),
    text: z.string(),
    duration_ms: z.number().int().min(0),
    label: z.string(),
  })
  .superRefine((it, ctx) => {
    const bad = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (it.type === 'speech') {
      if (!it.text.trim()) bad('speech needs text');
      if (it.duration_ms !== 0) bad('speech duration is measured after synthesis');
    } else if (it.text !== '') bad('only speech carries text');
    if (it.type !== 'speech' && it.duration_ms <= 0) bad('silence needs a duration');
    if (it.type === 'rehearse' ? !it.label.trim() : it.label !== '') bad('label only on rehearse');
  });

export const sessionTimelineSchema = z.object({
  schema_version: z.literal(TIMELINE_SCHEMA_VERSION),
  context: z.enum(CONTEXTS),
  engine: z.string(),
  target_seconds: z.number().int().positive(),
  title: z.string().min(1).max(40),
  items: z.array(timelineItemSchema).min(1),
});
export type SessionTimeline = z.infer<typeof sessionTimelineSchema>;
export type TimelineItem = z.infer<typeof timelineItemSchema>;

/** Share of session length per block (SPEC §3.3). `return` is the remainder. */
export const BLOCK_SHARES: Record<SessionContext, Record<Block, number>> = {
  training: {
    arrive: 0.15,
    intention: 0.05,
    feared_self: 0.05,
    hoped_self: 0.1,
    process: 0.35,
    obstacle: 0.15,
    outcome_anchor: 0.1,
    return: 0.05,
  },
  night_before: {
    arrive: 0.3,
    intention: 0.05,
    feared_self: 0,
    hoped_self: 0.1,
    process: 0.3,
    obstacle: 0.1,
    outcome_anchor: 0.1,
    return: 0.05,
  },
  primer: {
    arrive: 0.05,
    intention: 0.05,
    feared_self: 0,
    hoped_self: 0.05,
    process: 0.45,
    obstacle: 0.2,
    outcome_anchor: 0.15,
    return: 0.05,
  },
};

/** Silence share and speech share limits per context (CONTRACTS §6.1). */
export const SILENCE_SHARE: Record<SessionContext, [number, number]> = {
  training: [0.3, 0.45],
  night_before: [0.35, 0.55],
  primer: [0.15, 0.35],
};
export const MAX_SPEECH_SHARE: Record<SessionContext, number> = {
  training: 0.7,
  night_before: 0.65,
  primer: 0.85,
};

export const DURATION_TOLERANCE = 0.08;
export const FIT_TOLERANCE_PREFERRED = 0.02;
export const FIT_TOLERANCE_MAX = 0.1;
export const PAUSE_FACTOR_RANGE: [number, number] = [0.6, 1.5];
export const PAUSE_MS_RANGE: [number, number] = [500, 20_000];

export interface ValidationContext {
  profile: AthleteProfile;
  /** The voice's calibrated words per minute (`voice_catalog.wpm`). */
  wpm: number;
}

export interface ValidationResult {
  ok: boolean;
  /** Rule ids only: never athlete text (the repair call receives these ids). */
  failures: string[];
  predictedSeconds: number;
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const sentences = (s: string) => (s.match(/[.!?]+(?:\s|$)/g) ?? []).length || 1;
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function predictedItemSeconds(it: TimelineItem, wpm: number): number {
  return it.type === 'speech' ? (words(it.text) / wpm) * 60 : it.duration_ms / 1000;
}

export function fearedSelfExpected(profile: AthleteProfile, context: SessionContext): boolean {
  if (context !== 'training') return false;
  if (!profile.preferences.feared_self_enabled) return false;
  const status = profile.field_status['identity.feared_self'];
  if (status === 'skipped' || status === 'unsure') return false;
  return !!profile.identity.feared_self?.value.trim();
}

export function validateTimeline(tl: SessionTimeline, ctx: ValidationContext): ValidationResult {
  const fail = new Set<string>();
  const { profile, wpm } = ctx;
  const items = tl.items;
  const secs = items.map((i) => predictedItemSeconds(i, wpm));
  const total = secs.reduce((a, b) => a + b, 0);

  // Blocks present and in order.
  const feared = fearedSelfExpected(profile, tl.context);
  const required = BLOCKS.filter((b) => b !== 'feared_self' || feared);
  const seen = BLOCKS.filter((b) => items.some((i) => i.block === b));
  for (const b of required) if (!seen.includes(b)) fail.add('block_missing');
  if (!feared && seen.includes('feared_self')) fail.add('block_not_allowed');
  let last = -1;
  for (const i of items) {
    const idx = BLOCKS.indexOf(i.block);
    if (idx < last) fail.add('block_order');
    last = Math.max(last, idx);
  }

  // Block durations within 0.5x to 1.5x of their share; feared self 15 to 45 s.
  for (const b of seen) {
    const blockSecs = items.reduce((a, it, n) => (it.block === b ? a + (secs[n] ?? 0) : a), 0);
    if (b === 'feared_self') {
      if (blockSecs < 15 || blockSecs > 45) fail.add('feared_self_duration');
      continue;
    }
    let share = BLOCK_SHARES[tl.context][b];
    if (b === 'process' && !feared) share += tl.context === 'training' ? 0.05 : 0; // feared share moves to process
    const expected = share * tl.target_seconds;
    if (b === 'return') continue; // remainder block; the total check bounds it
    if (blockSecs < expected * 0.5 || blockSecs > expected * 1.5) fail.add(`block_duration_${b}`);
  }

  // Per item rules.
  const rehearseOk = new Set<number>();
  items.forEach((it, n) => {
    if (it.type === 'speech') {
      if (it.text.length < 1 || it.text.length > 600) fail.add('speech_length');
      if (sentences(it.text) > 3) fail.add('speech_sentences');
    } else if (it.type === 'pause') {
      if (it.duration_ms < 500 || it.duration_ms > 20_000) fail.add('pause_range');
    } else {
      if (it.duration_ms < 1000 || it.duration_ms > 120_000) fail.add('rehearse_range');
      const prev = items[n - 1];
      if (!prev || prev.type !== 'speech' || (it.block !== 'process' && it.block !== 'obstacle')) {
        fail.add('rehearse_placement');
      } else rehearseOk.add(n);
    }
  });

  // Consecutive silence.
  let run = 0;
  let runBlocks = new Set<Block>();
  const silenceCap = (blocks: Set<Block>) =>
    tl.context === 'night_before' && [...blocks].every((b) => b === 'arrive' || b === 'return') ? 45 : 30;
  const flush = () => {
    if (run > silenceCap(runBlocks)) fail.add('consecutive_silence');
    run = 0;
    runBlocks = new Set();
  };
  items.forEach((it, n) => {
    if (it.type === 'speech') flush();
    else {
      run += secs[n] ?? 0;
      runBlocks.add(it.block);
    }
  });
  flush();

  // Silence share, speech character guard, total duration.
  const silence = items.reduce((a, it, n) => (it.type === 'speech' ? a : a + (secs[n] ?? 0)), 0);
  const silenceShare = total > 0 ? silence / total : 0;
  const [lo, hi] = SILENCE_SHARE[tl.context];
  if (silenceShare < lo || silenceShare > hi) fail.add('silence_share');
  const speechChars = items.reduce((a, it) => (it.type === 'speech' ? a + it.text.length : a), 0);
  if (speechChars > 12 * tl.target_seconds * MAX_SPEECH_SHARE[tl.context]) fail.add('speech_char_budget');
  if (Math.abs(total - tl.target_seconds) / tl.target_seconds > DURATION_TOLERANCE)
    fail.add('duration_off_target');

  // Verbatim content.
  const blockText = (b: Block) =>
    norm(
      items
        .filter((i) => i.block === b)
        .map((i) => i.text)
        .join(' '),
    );
  const cue = profile.responses.cue_phrase?.value;
  if (cue && !blockText('obstacle').includes(norm(cue))) fail.add('cue_phrase_missing');
  const intention = profile.identity.intention?.value;
  if (intention) {
    if (!blockText('intention').includes(norm(intention))) fail.add('intention_missing');
    if (!blockText('return').includes(norm(intention))) fail.add('intention_missing_return');
  }
  const obstacle = blockText('obstacle');
  const rehearsed = profile.responses.if_then.some((p) => {
    const w = norm(p.then)
      .split(' ')
      .filter((x) => x.length > 3);
    if (w.length === 0) return obstacle.includes(norm(p.then));
    return w.filter((x) => obstacle.includes(x)).length / w.length >= 0.6;
  });
  if (profile.responses.if_then.length > 0 && !rehearsed) fail.add('if_then_not_rehearsed');

  // Style and banned content (deterministic; the judge adds the semantic checks).
  const allText = items.map((i) => i.text).join(' ');
  if (allText.includes('!')) fail.add('style_exclamation');
  if (allText.includes('—') || /\s–\s/.test(allText)) fail.add('style_dash');
  for (const id of findBannedContent(allText)) fail.add(`banned_${id}`);

  return { ok: fail.size === 0, failures: [...fail].sort(), predictedSeconds: total };
}

export interface FitResult {
  ok: boolean;
  /** Applied pause scale factor, clamped to PAUSE_FACTOR_RANGE. */
  factor: number;
  totalMs: number;
  /** Fitted duration for every `pause` item, in item order (other items keep their value). */
  items: TimelineItem[];
  reason?: 'DURATION_UNFITTABLE';
}

/**
 * After synthesis the real speech durations are known. Scale every pause by one factor f
 * (0.6 to 1.5, each pause clamped to 500-20,000 ms) to land on the target; `rehearse` items never change.
 * Within 10 % of target is acceptable; beyond that is a word-budget bug, never fixed by re-synthesis.
 */
export function fitDurations(
  items: readonly TimelineItem[],
  speechMs: readonly number[],
  targetSeconds: number,
): FitResult {
  const targetMs = targetSeconds * 1000;
  let speechIdx = 0;
  let fixedMs = 0;
  for (const it of items) {
    if (it.type === 'speech') fixedMs += speechMs[speechIdx++] ?? 0;
    else if (it.type === 'rehearse') fixedMs += it.duration_ms;
  }
  const pauseMs = items.reduce((a, it) => (it.type === 'pause' ? a + it.duration_ms : a), 0);

  const apply = (f: number) =>
    items.map((it) =>
      it.type === 'pause'
        ? {
            ...it,
            duration_ms: Math.round(
              Math.min(PAUSE_MS_RANGE[1], Math.max(PAUSE_MS_RANGE[0], it.duration_ms * f)),
            ),
          }
        : it,
    );
  const total = (list: TimelineItem[]) =>
    fixedMs + list.reduce((a, it) => (it.type === 'pause' ? a + it.duration_ms : a), 0);

  let f = pauseMs > 0 ? (targetMs - fixedMs) / pauseMs : 1;
  f = Math.min(PAUSE_FACTOR_RANGE[1], Math.max(PAUSE_FACTOR_RANGE[0], f));
  let fitted = apply(f);
  // Per-pause clamping can leave a small residual; one correction pass keeps it near target.
  const residual = targetMs - total(fitted);
  if (Math.abs(residual) > targetMs * FIT_TOLERANCE_PREFERRED && pauseMs > 0) {
    const adj = Math.min(
      PAUSE_FACTOR_RANGE[1],
      Math.max(PAUSE_FACTOR_RANGE[0], f * (1 + residual / Math.max(1, total(fitted) - fixedMs))),
    );
    fitted = apply(adj);
    f = adj;
  }
  const totalMs = total(fitted);
  const off = Math.abs(totalMs - targetMs) / targetMs;
  return off <= FIT_TOLERANCE_MAX
    ? { ok: true, factor: f, totalMs, items: fitted }
    : { ok: false, factor: f, totalMs, items: fitted, reason: 'DURATION_UNFITTABLE' };
}
