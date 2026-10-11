/** Post-event debrief contract (SPEC §8.4): same op schema as the interview, plus a learning stage change. */
import { z } from 'zod';
import { PROFILE_OPS, SAFETY_SIGNALS } from './intake';

export const debriefOutputSchema = z.object({
  summary: z.string().min(1),
  profile_updates: z.array(
    z.object({
      op: z.enum(PROFILE_OPS),
      path: z.string(),
      item_id: z.string(),
      value: z.string(),
    }),
  ),
  learning_stage_change: z.enum(['none', 'advance']),
  safety_signal: z.enum(SAFETY_SIGNALS),
});
export type DebriefOutput = z.infer<typeof debriefOutputSchema>;

export function normalizeDebriefOutput(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const o = { ...(raw as Record<string, unknown>) };
  const lower = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : v);
  o.safety_signal = lower(o.safety_signal);
  o.learning_stage_change = lower(o.learning_stage_change);
  if (Array.isArray(o.profile_updates)) {
    o.profile_updates = o.profile_updates.map((u) =>
      u && typeof u === 'object'
        ? {
            ...u,
            op: lower((u as Record<string, unknown>).op),
            path: lower((u as Record<string, unknown>).path),
          }
        : u,
    );
  }
  return o;
}

/** Paths holding the athlete's exact words: a proposal on them is never pre-checked (SPEC §8.4). */
export const PROTECTED_PATHS = [
  'responses.cue_phrase',
  'identity.intention',
  'obstacles.negative_self_talk',
] as const;

export const debriefAnswersSchema = z.object({
  overall: z.number().int().min(1).max(5),
  went_well: z.string().max(280).optional(),
  harder: z.string().max(280).optional(),
  cue_helped: z.enum(['yes', 'somewhat', 'no', 'not_used']),
  next_time: z.string().max(280).optional(),
});
export type DebriefAnswers = z.infer<typeof debriefAnswersSchema>;

export function buildDebriefUserPayload(input: {
  answers: DebriefAnswers;
  profile: unknown;
  skippedPaths: readonly string[];
  allowedPaths: readonly string[];
}): string {
  const a = input.answers;
  const tag = (s: string | undefined) => (s ?? '').replaceAll('</debrief>', '');
  return [
    `Allowed profile paths: ${input.allowedPaths.join(', ')}`,
    `Skipped by the athlete (never touch): ${input.skippedPaths.join(', ') || 'none'}`,
    `Never change these exact-word fields unless the athlete asks: ${PROTECTED_PATHS.join(', ')}`,
    `Current profile (JSON): ${JSON.stringify(input.profile)}`,
    `Overall rating (1 to 5): ${a.overall}. Cue phrase helped: ${a.cue_helped}.`,
    `<debrief>What went well: ${tag(a.went_well)}\nWhat was harder or different: ${tag(a.harder)}\nFor next time: ${tag(a.next_time)}</debrief>`,
  ].join('\n\n');
}
