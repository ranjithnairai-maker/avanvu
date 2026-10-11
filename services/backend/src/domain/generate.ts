/**
 * Script generation (SPEC §5.4, CONTRACTS §6, §7): structured-output call, Zod parse, deterministic
 * validation, judge, and AT MOST ONE repair call per job. A second failure is a non-retryable job error and
 * the reservation is reversed. The fallback is never a silently substituted generic session.
 *
 * Nothing here logs prompts, athlete text or model output. Failure details are rule ids only.
 */
import {
  AvanvuError,
  FIELD_PATHS,
  JUDGE_SYSTEM_PROMPT,
  LEXICON_VERSION,
  MAX_SPEECH_SHARE,
  SCRIPT_SYSTEM_PROMPT,
  buildScriptUserPayload,
  failedChecks,
  fearedSelfExpected,
  judgementJsonSchema,
  judgementSchema,
  promptVersion,
  sessionTimelineSchema,
  timelineJsonSchema,
  validateTimeline,
  type AthleteProfile,
  type SessionContext,
  type SessionTimeline,
} from '@avanvu/core';
import { LlmError, type LlmClient, type LlmUsage } from '../ports/llm';

export interface GenerateInput {
  profile: AthleteProfile;
  context: SessionContext;
  lengthMin: number;
  wpm: number;
  coreScene: unknown | null;
  recentCheckins: readonly { vividness: number; readiness: number }[];
}

export interface GenerateResult {
  timeline: SessionTimeline;
  usages: { kind: 'script' | 'judge'; usage: LlmUsage }[];
  repaired: boolean;
  versions: Record<string, unknown>;
}

/** Speech share targeted by the writer (the validator allows a wider band). */
const TARGET_SPEECH_SHARE: Record<SessionContext, number> = { training: 0.6, night_before: 0.55, primer: 0.75 };

export class NonRetryableJobError extends Error {
  constructor(
    readonly code: 'VALIDATION_FAILED_AFTER_REPAIR',
    readonly failedRules: string[],
  ) {
    super(code);
    this.name = 'NonRetryableJobError';
  }
}

function normalizeTimeline(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const o = { ...(raw as Record<string, unknown>) };
  if (Array.isArray(o.items)) {
    o.items = o.items.map((i) =>
      i && typeof i === 'object'
        ? {
            ...i,
            type: typeof (i as { type?: unknown }).type === 'string' ? (i as { type: string }).type.toLowerCase() : (i as { type?: unknown }).type,
            block: typeof (i as { block?: unknown }).block === 'string' ? (i as { block: string }).block.toLowerCase() : (i as { block?: unknown }).block,
          }
        : i,
    );
  }
  return o;
}

export async function generateTimeline(
  llm: LlmClient,
  models: { script: string; judge: string; effort: string },
  input: GenerateInput,
  timeoutMs = 120_000,
): Promise<GenerateResult> {
  const { profile, context, lengthMin, wpm } = input;
  const targetSeconds = lengthMin * 60;
  const wordBudget = Math.round((targetSeconds / 60) * wpm * Math.min(TARGET_SPEECH_SHARE[context], MAX_SPEECH_SHARE[context]));
  const skipped = FIELD_PATHS.filter((p) => profile.field_status[p] === 'skipped');
  const unsure = FIELD_PATHS.filter((p) => profile.field_status[p] === 'unsure');
  const usages: GenerateResult['usages'] = [];
  let repaired = false;

  const payload = (repairRules?: string[]) =>
    buildScriptUserPayload({
      engine: profile.sport.engine as never,
      context,
      targetSeconds,
      wpm,
      speechWordBudget: wordBudget,
      includeFearedSelf: fearedSelfExpected(profile, context),
      perspective: profile.preferences.perspective,
      profile: athleteView(profile),
      skippedPaths: skipped,
      unsurePaths: unsure,
      coreScene: input.coreScene,
      recentCheckins: input.recentCheckins,
      ...(repairRules ? { repairRules } : {}),
    });

  const writeScript = async (repairRules?: string[]) => {
    const r = await llm.complete({
      task: 'script',
      systemPrompt: SCRIPT_SYSTEM_PROMPT,
      userPayload: payload(repairRules),
      jsonSchema: timelineJsonSchema(),
      timeoutMs,
      repair: !!repairRules,
    });
    usages.push({ kind: 'script', usage: r.usage });
    const parsed = sessionTimelineSchema.safeParse(normalizeTimeline(r.output));
    if (!parsed.success) return { timeline: null, failures: ['schema_invalid'] };
    // Server-owned fields are not the model's to set.
    const timeline: SessionTimeline = {
      ...parsed.data,
      schema_version: 'session_timeline_v1',
      context,
      engine: profile.sport.engine,
      target_seconds: targetSeconds,
    };
    return { timeline, failures: validateTimeline(timeline, { profile, wpm }).failures };
  };

  const judge = async (timeline: SessionTimeline) => {
    const text = timeline.items
      .filter((i) => i.type === 'speech')
      .map((i) => `[${i.block}] ${i.text}`)
      .join('\n');
    const r = await llm.complete({
      task: 'judge',
      systemPrompt: JUDGE_SYSTEM_PROMPT,
      userPayload: [
        `Engine: ${profile.sport.engine}. Context: ${context}.`,
        `Skipped paths: ${skipped.join(', ') || 'none'}`,
        `Unsure paths: ${unsure.join(', ') || 'none'}`,
        `<athlete_profile>${JSON.stringify(athleteView(profile))}</athlete_profile>`,
        `<script>${text}</script>`,
      ].join('\n\n'),
      jsonSchema: judgementJsonSchema(),
      timeoutMs,
      repair: false,
    });
    usages.push({ kind: 'judge', usage: r.usage });
    const parsed = judgementSchema.safeParse(r.output);
    return parsed.success ? failedChecks(parsed.data).map((c) => `judge_${c}`) : ['judge_invalid'];
  };

  try {
    let attempt = await writeScript();
    let failures = attempt.failures;
    if (attempt.timeline && failures.length === 0) failures = await judge(attempt.timeline);

    if (failures.length > 0) {
      // The single repair call, shared by deterministic validation and the judge.
      repaired = true;
      attempt = await writeScript(failures);
      failures = attempt.failures;
      if (attempt.timeline && failures.length === 0) failures = await judge(attempt.timeline);
      if (failures.length > 0 || !attempt.timeline) throw new NonRetryableJobError('VALIDATION_FAILED_AFTER_REPAIR', failures);
    }
    if (!attempt.timeline) throw new NonRetryableJobError('VALIDATION_FAILED_AFTER_REPAIR', ['schema_invalid']);

    return {
      timeline: attempt.timeline,
      usages,
      repaired,
      versions: {
        prompt: await promptVersion('script'),
        judge_prompt: await promptVersion('judge'),
        schema: 'session_timeline_v1',
        models: { script: models.script, judge: models.judge },
        effort: models.effort,
        lexicon: LEXICON_VERSION,
        engine: profile.sport.engine,
        repaired,
      },
    };
  } catch (e) {
    if (e instanceof NonRetryableJobError) throw e;
    if (e instanceof LlmError || e instanceof AvanvuError) throw e; // retryable: vendor 429/5xx, timeouts
    throw e;
  }
}

/** What the writer and judge may see: athlete-owned content only, never server-owned fields. */
function athleteView(p: AthleteProfile): unknown {
  const { field_status: _f, schema_version: _s, learning_stage: _l, ...rest } = p;
  return {
    ...rest,
    sport: { label: p.sport.label.value, level: p.sport.level },
    preferences: { perspective: p.preferences.perspective },
  };
}
