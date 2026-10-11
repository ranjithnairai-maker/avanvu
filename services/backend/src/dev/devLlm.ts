/**
 * Deterministic stand-in for the language model, used only by `pnpm dev:backend` (local environment, no API
 * keys). It fills the draft one field at a time from what the athlete typed, writes a valid script with the
 * fixture builder, and passes the judge. It exists so the whole product loop can be exercised end to end
 * without a vendor. It is never constructed outside AVANVU_ENV=local.
 */
import {
  JUDGE_CHECK_IDS,
  PHASE_OPENINGS,
  buildFictionalTimeline,
  type AthleteProfile,
  type Phase,
  type SessionContext,
} from '@avanvu/core';
import type { LlmClient, LlmRequest, LlmResponse } from '../ports/llm';

interface Step {
  path: string;
  phase: Phase;
  op: 'set' | 'add_item';
  count?: number;
  wrap?: (t: string) => string;
}

const words = (t: string, n: number) => t.trim().split(/\s+/).slice(0, n).join(' ');

const STEPS: Step[] = [
  { path: 'objective.primary', phase: 'objective', op: 'set' },
  { path: 'objective.process_success', phase: 'objective', op: 'set' },
  { path: 'event.stakes', phase: 'sport_event', op: 'set' },
  { path: 'event.venue', phase: 'sport_event', op: 'set', wrap: (t) => t.slice(0, 120) },
  { path: 'scene.visual', phase: 'scene', op: 'add_item', count: 3 },
  { path: 'scene.sounds', phase: 'scene', op: 'add_item', count: 2 },
  { path: 'scene.weather_temperature', phase: 'scene', op: 'set' },
  { path: 'scene.surface_equipment', phase: 'scene', op: 'add_item', count: 1 },
  { path: 'performance.routine', phase: 'performance', op: 'set' },
  {
    path: 'performance.key_moments',
    phase: 'performance',
    op: 'add_item',
    count: 2,
    wrap: (t) => JSON.stringify({ label: words(t, 4), description: t.slice(0, 280) }),
  },
  { path: 'performance.controllables', phase: 'performance', op: 'add_item', count: 1 },
  { path: 'obstacles.hardest_moment', phase: 'obstacles', op: 'set' },
  { path: 'obstacles.disruptors', phase: 'obstacles', op: 'add_item', count: 1 },
  {
    path: 'responses.if_then',
    phase: 'response',
    op: 'add_item',
    count: 1,
    wrap: (t) => JSON.stringify({ when: words(t, 8), then: `I ${words(t, 10)}`.slice(0, 190) }),
  },
  { path: 'responses.cue_phrase', phase: 'response', op: 'set', wrap: (t) => t.slice(0, 40) },
  { path: 'identity.hoped_self', phase: 'identity', op: 'set' },
  { path: 'identity.intention', phase: 'identity', op: 'set', wrap: (t) => t.slice(0, 160) },
  { path: 'outcome.visual', phase: 'outcome', op: 'set' },
  { path: 'outcome.body', phase: 'outcome', op: 'set' },
  { path: 'outcome.emotion', phase: 'outcome', op: 'set', wrap: (t) => t.slice(0, 120) },
  { path: 'outcome.first_action', phase: 'outcome', op: 'set', wrap: (t) => t.slice(0, 160) },
];

type Draft = Record<string, Record<string, { value?: string } | unknown[] | null> | undefined>;

function nextStep(draft: Draft): Step | null {
  for (const s of STEPS) {
    const [g, k] = s.path.split('.') as [string, string];
    const v = draft[g]?.[k];
    const have = Array.isArray(v) ? v.length : v && (v as { value?: string }).value ? 1 : 0;
    if (have < (s.count ?? 1)) return s;
  }
  return null;
}

function between(text: string, tag: string): string {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return m?.[1]?.trim() ?? '';
}

export class DevLlm implements LlmClient {
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const usage = { model: 'dev-llm', tokensIn: 0, tokensOut: 0, estCostUsd: 0 };
    if (req.task === 'judge') {
      return { output: { checks: JUDGE_CHECK_IDS.map((id) => ({ id, pass: true, note: '' })) }, usage };
    }
    if (req.task === 'script') {
      const profile = JSON.parse(between(req.userPayload, 'athlete_profile')) as AthleteProfile;
      const seconds = Number(/Target length: (\d+) seconds/.exec(req.userPayload)?.[1] ?? 900);
      const ctx = /Context: (training|night before|pre-event primer)/.exec(req.userPayload)?.[1];
      const context: SessionContext =
        ctx === 'night before' ? 'night_before' : ctx === 'pre-event primer' ? 'primer' : 'training';
      const feared = /Include a feared_self block: yes/.test(req.userPayload);
      const full = {
        ...profile,
        field_status: feared ? { 'identity.feared_self': 'complete' } : {},
        preferences: { ...profile.preferences, feared_self_enabled: feared },
      } as AthleteProfile;
      // The writer is not shown the engine id; the server owns it and overwrites this value.
      const timeline = buildFictionalTimeline(full, { context, targetSeconds: seconds });
      return { output: { ...timeline, engine: timeline.engine ?? 'endurance_v1' }, usage };
    }
    if (req.task === 'debrief') {
      return {
        output: {
          summary: 'You stayed with your plan. Keep what worked.',
          profile_updates: [],
          learning_stage_change: 'none',
          safety_signal: 'none',
        },
        usage,
      };
    }
    // Interview turn: record the athlete's words in the first field that still needs an answer.
    const message = between(req.userPayload, 'athlete_message');
    const draftJson = /Current draft with item ids \(JSON\): (.*)/.exec(req.userPayload)?.[1] ?? '{}';
    const step = nextStep(JSON.parse(draftJson) as Draft);
    const updates = step
      ? [
          {
            op: step.op,
            path: step.path,
            item_id: '',
            value: (step.wrap ?? ((t: string) => t.slice(0, 190)))(message),
          },
        ]
      : [];
    const phase: Phase = step ? step.phase : 'outcome';
    return {
      output: {
        assistant_message: PHASE_OPENINGS[phase],
        quick_replies: [],
        profile_updates: updates,
        field_assessments: [],
        safety_signal: 'none',
        next_focus: phase,
      },
      usage,
    };
  }
}
