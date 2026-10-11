/**
 * Deterministic script checks (EVALS §4.2). They run on the final timeline independently of the pipeline's own
 * validator, so a regression in either is caught.
 */
import {
  findBannedContent,
  fearedSelfExpected,
  validateTimeline,
  type AthleteProfile,
  type SessionTimeline,
} from '@avanvu/core';

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export interface ScriptCheck {
  id: string;
  ok: boolean;
}

export function checkScript(
  tl: SessionTimeline,
  ctx: { profile: AthleteProfile; wpm: number; cue: string; intention: string },
): ScriptCheck[] {
  const speech = tl.items.filter((i) => i.type === 'speech');
  const all = norm(speech.map((i) => i.text).join(' '));
  const v = validateTimeline(tl, { profile: ctx.profile, wpm: ctx.wpm });
  const feared = fearedSelfExpected(ctx.profile, tl.context);
  const hasFeared = tl.items.some((i) => i.block === 'feared_self');
  const banned = findBannedContent(speech.map((i) => i.text).join('\n'));
  return [
    { id: 'cue_verbatim', ok: all.includes(norm(ctx.cue)) },
    { id: 'intention_verbatim', ok: all.includes(norm(ctx.intention)) },
    { id: 'no_banned_content', ok: banned.length === 0 },
    { id: 'feared_self_gated', ok: feared === hasFeared },
    {
      id: 'duration_within_tolerance',
      ok: Math.abs(v.predictedSeconds - tl.target_seconds) / tl.target_seconds <= 0.08,
    },
    { id: 'validator_passes', ok: v.ok },
  ];
}

export const failedIds = (checks: ScriptCheck[]): string[] => checks.filter((c) => !c.ok).map((c) => c.id);
