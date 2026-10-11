/** Quality judge contract (CONTRACTS §7). A quality gate, not a safety guarantee. */
import { z } from 'zod';

export const JUDGE_SCHEMA_VERSION = 'script_judgement_v1' as const;

export const JUDGE_CHECK_IDS = [
  'no_invented_facts',
  'no_skipped_content',
  'no_technique_instruction',
  'no_unsafe_guidance',
  'process_over_outcome',
  'if_then_rehearsed',
  'tone_and_voice',
  'engine_structure',
] as const;
export type JudgeCheckId = (typeof JUDGE_CHECK_IDS)[number];

export const judgementSchema = z
  .object({
    checks: z.array(
      z.object({
        id: z.enum(JUDGE_CHECK_IDS),
        pass: z.boolean(),
        /** At most 200 characters and must not quote the athlete. */
        note: z.string().max(200),
      }),
    ),
  })
  .superRefine((j, ctx) => {
    const ids = new Set(j.checks.map((c) => c.id));
    if (ids.size !== JUDGE_CHECK_IDS.length || j.checks.length !== JUDGE_CHECK_IDS.length) {
      ctx.addIssue({ code: 'custom', message: 'every check must appear exactly once' });
    }
  });
export type Judgement = z.infer<typeof judgementSchema>;

export function failedChecks(j: Judgement): JudgeCheckId[] {
  return j.checks.filter((c) => !c.pass).map((c) => c.id);
}
