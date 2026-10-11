/**
 * Intake turn contracts and the pure server-side logic that applies model output to the draft
 * (CONTRACTS §4, §5). Model output is untrusted: it is validated here, and only allowlisted updates
 * are applied. Rejection reasons never include athlete or model text.
 */
import { z } from 'zod';
import {
  FIELD_SPECS,
  type AthleteProfile,
  type FieldPath,
  type FieldSpec,
  type FieldStatus,
  type IfThen,
  type KeyMoment,
  type ModelQuality,
  anchorSchema,
  generationMinimumMissing,
  isFieldPath,
  levelSchema,
  recomputeStatuses,
  getAtPath,
  setAtPath,
  SENSITIVE_PATHS,
  FIELD_PATHS,
} from './profile';

export const INTAKE_INPUT_MODES = ['text', 'dictation', 'quick_reply'] as const;
export const INTAKE_CONTENT_MAX = 1000;

export const intakeTurnRequestSchema = z.object({
  conversation_id: z.string().uuid(),
  client_message_id: z.string().uuid(),
  expected_revision: z.number().int().min(0),
  input_mode: z.enum(INTAKE_INPUT_MODES),
  content: z.string().min(1).max(INTAKE_CONTENT_MAX),
});
export type IntakeTurnRequest = z.infer<typeof intakeTurnRequestSchema>;

export const PROFILE_OPS = [
  'set',
  'add_item',
  'replace_item',
  'remove_item',
  'mark_skipped',
  'mark_unsure',
] as const;
export const NEXT_FOCUS = [
  'objective',
  'sport_event',
  'scene',
  'performance',
  'obstacles',
  'response',
  'identity',
  'outcome',
  'wrap_up',
] as const;
export type NextFocus = (typeof NEXT_FOCUS)[number];

export const SAFETY_SIGNALS = ['none', 'ambiguous', 'crisis'] as const;
export type SafetySignal = (typeof SAFETY_SIGNALS)[number];

export const intakeTurnOutputSchema = z.object({
  assistant_message: z.string().min(1),
  quick_replies: z.array(z.string().max(24)).max(4),
  profile_updates: z.array(
    z.object({
      op: z.enum(PROFILE_OPS),
      path: z.string(),
      item_id: z.string(),
      value: z.string(),
    }),
  ),
  field_assessments: z.array(
    z.object({ path: z.string(), quality: z.enum(['missing', 'partial', 'complete']) }),
  ),
  safety_signal: z.enum(SAFETY_SIGNALS),
  next_focus: z.enum(NEXT_FOCUS),
});
export type IntakeTurnOutput = z.infer<typeof intakeTurnOutputSchema>;
export type ProfileUpdate = IntakeTurnOutput['profile_updates'][number];

/** Structured outputs do not guarantee enum capitalisation: normalise before validating. */
export function normalizeIntakeOutput(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const o = { ...(raw as Record<string, unknown>) };
  const lower = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : v);
  o.safety_signal = lower(o.safety_signal);
  o.next_focus = lower(o.next_focus);
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
  if (Array.isArray(o.field_assessments)) {
    o.field_assessments = o.field_assessments.map((a) =>
      a && typeof a === 'object'
        ? {
            ...a,
            path: lower((a as Record<string, unknown>).path),
            quality: lower((a as Record<string, unknown>).quality),
          }
        : a,
    );
  }
  return o;
}

export function parseIntakeOutput(raw: unknown): { ok: true; value: IntakeTurnOutput } | { ok: false } {
  const r = intakeTurnOutputSchema.safeParse(normalizeIntakeOutput(raw));
  return r.success ? { ok: true, value: r.data } : { ok: false };
}

/** Assistant message limits: 45 words normally; one repair, then accept up to 60 and log (CONTRACTS §4.2). */
export const ASSISTANT_WORDS_SOFT = 45;
export const ASSISTANT_WORDS_HARD = 60;
export function assistantWordCount(message: string): number {
  return message.trim().split(/\s+/).filter(Boolean).length;
}
export function assistantMessageStyleIssues(message: string): string[] {
  const issues: string[] = [];
  if (message.includes('!')) issues.push('exclamation');
  if (message.includes('—')) issues.push('em_dash');
  if (assistantWordCount(message) > ASSISTANT_WORDS_SOFT) issues.push('too_long');
  return issues;
}

export type RejectReason =
  | 'path_not_allowlisted'
  | 'path_skipped'
  | 'op_not_valid_for_field'
  | 'item_not_found'
  | 'value_empty'
  | 'value_too_long'
  | 'too_many_items'
  | 'invalid_value'
  | 'skip_not_allowed';

export interface RejectedUpdate {
  path: string;
  op: string;
  reason: RejectReason;
}

const base32 = 'abcdefghijklmnopqrstuvwxyz234567';
export function generateItemId(rand: () => number = Math.random): string {
  let id = '';
  for (let i = 0; i < 8; i++) id += base32[Math.floor(rand() * 32)];
  return id;
}

const keyMomentValueSchema = z.object({
  label: z.string().min(1).max(60),
  description: z.string().min(1).max(300),
  body_feel: z.string().max(200).default(''),
  realtime_seconds: z.number().int().min(1).max(120).nullable().default(null),
});
const ifThenValueSchema = z.object({ when: z.string().min(1).max(160), then: z.string().min(1).max(200) });

function parseJsonObject(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

interface ApplyOptions {
  /** Which source to record; the model path always records `athlete`, summary edits use `edited`. */
  source?: 'athlete' | 'edited';
  rand?: () => number;
}

export interface ApplyResult {
  profile: AthleteProfile;
  accepted: number;
  rejected: RejectedUpdate[];
  /** Paths whose content changed (used to bump follow-up counters and recompute statuses). */
  touched: FieldPath[];
}

type ListLike = { item_id: string; value?: string }[];

/** Apply a batch of untrusted updates to a draft profile. Pure: returns a new profile. */
export function applyProfileUpdates(
  current: AthleteProfile,
  updates: readonly ProfileUpdate[],
  opts: ApplyOptions = {},
): ApplyResult {
  const source = opts.source ?? 'athlete';
  const profile = structuredClone(current);
  const rejected: RejectedUpdate[] = [];
  const touched = new Set<FieldPath>();
  let accepted = 0;

  const reject = (u: ProfileUpdate, reason: RejectReason) =>
    rejected.push({ path: u.path, op: u.op, reason });

  for (const u of updates) {
    if (!isFieldPath(u.path)) {
      reject(u, 'path_not_allowlisted');
      continue;
    }
    const path: FieldPath = u.path;
    const spec: FieldSpec = FIELD_SPECS[path];

    if (profile.field_status[path] === 'skipped') {
      reject(u, 'path_skipped');
      continue;
    }

    if (u.op === 'mark_skipped') {
      if (!spec.sensitive) {
        reject(u, 'skip_not_allowed');
        continue;
      }
      clearPath(profile, path, spec);
      profile.field_status[path] = 'skipped';
      touched.add(path);
      accepted++;
      continue;
    }
    if (u.op === 'mark_unsure') {
      profile.field_status[path] = 'unsure';
      touched.add(path);
      accepted++;
      continue;
    }

    if (u.op === 'set') {
      if (spec.kind === 'text') {
        const v = u.value.trim();
        if (!v) reject(u, 'value_empty');
        else if (v.length > spec.max) reject(u, 'value_too_long');
        else {
          setAtPath(profile, path, { value: v, source });
          clearStatusOverride(profile, path);
          touched.add(path);
          accepted++;
        }
      } else if (spec.kind === 'enum') {
        const parsed = (path === 'sport.level' ? levelSchema : anchorSchema).safeParse(
          u.value.trim().toLowerCase(),
        );
        if (!parsed.success) reject(u, 'invalid_value');
        else {
          setAtPath(profile, path, parsed.data);
          touched.add(path);
          accepted++;
        }
      } else reject(u, 'op_not_valid_for_field');
      continue;
    }

    // Remaining ops act on list-like fields.
    if (spec.kind === 'text' || spec.kind === 'enum') {
      reject(u, 'op_not_valid_for_field');
      continue;
    }
    const items = getAtPath(profile, path) as ListLike;

    if (u.op === 'remove_item') {
      const idx = items.findIndex((i) => i.item_id === u.item_id);
      if (idx < 0) reject(u, 'item_not_found');
      else {
        items.splice(idx, 1);
        touched.add(path);
        accepted++;
      }
      continue;
    }

    if (u.op === 'add_item' && items.length >= (spec.maxCount ?? Infinity)) {
      reject(u, 'too_many_items');
      continue;
    }
    if (u.op === 'replace_item' && !items.some((i) => i.item_id === u.item_id)) {
      reject(u, 'item_not_found');
      continue;
    }

    const built = buildItem(
      spec,
      u.value,
      u.op === 'replace_item' ? u.item_id : generateItemId(opts.rand),
      source,
    );
    if (!built.ok) {
      reject(u, built.reason);
      continue;
    }
    if (u.op === 'add_item') items.push(built.item as ListLike[number]);
    else items[items.findIndex((i) => i.item_id === u.item_id)] = built.item as ListLike[number];
    clearStatusOverride(profile, path);
    touched.add(path);
    accepted++;
  }

  return { profile, accepted, rejected, touched: [...touched] };
}

function buildItem(
  spec: FieldSpec,
  value: string,
  itemId: string,
  source: 'athlete' | 'edited',
): { ok: true; item: unknown } | { ok: false; reason: RejectReason } {
  if (spec.kind === 'list') {
    const v = value.trim();
    if (!v) return { ok: false, reason: 'value_empty' };
    if (v.length > spec.max) return { ok: false, reason: 'value_too_long' };
    return { ok: true, item: { item_id: itemId, value: v, source } };
  }
  const obj = parseJsonObject(value);
  if (obj === undefined) return { ok: false, reason: 'invalid_value' };
  if (spec.kind === 'key_moments') {
    const r = keyMomentValueSchema.safeParse(obj);
    if (!r.success) return { ok: false, reason: 'invalid_value' };
    const item: KeyMoment = { item_id: itemId, ...r.data, source };
    return { ok: true, item };
  }
  const r = ifThenValueSchema.safeParse(obj);
  if (!r.success) return { ok: false, reason: 'invalid_value' };
  const item: IfThen = { item_id: itemId, ...r.data, source };
  return { ok: true, item };
}

function clearPath(profile: AthleteProfile, path: FieldPath, spec: FieldSpec): void {
  setAtPath(profile, path, spec.kind === 'text' ? null : []);
}

/** New content on an `unsure` path replaces that marker; a skipped path is never reached here. */
function clearStatusOverride(profile: AthleteProfile, path: FieldPath): void {
  if (profile.field_status[path] === 'unsure') delete profile.field_status[path];
}

export function parseAssessments(
  raw: IntakeTurnOutput['field_assessments'],
): Partial<Record<FieldPath, ModelQuality>> {
  const out: Partial<Record<FieldPath, ModelQuality>> = {};
  for (const a of raw) if (isFieldPath(a.path)) out[a.path] = a.quality;
  return out;
}

/** Follow-up counters per path. A counter of 2 or more resolves the path for interview flow. */
export const FOLLOW_UP_LIMIT = 2;
export type FollowUpCounters = Partial<Record<FieldPath, number>>;

export function bumpFollowUp(counters: FollowUpCounters, targetPath: FieldPath | null): FollowUpCounters {
  if (!targetPath) return counters;
  return { ...counters, [targetPath]: (counters[targetPath] ?? 0) + 1 };
}

export function isFollowUpExhausted(counters: FollowUpCounters, path: FieldPath): boolean {
  return (counters[path] ?? 0) >= FOLLOW_UP_LIMIT;
}

/** Apply updates then refresh statuses in one step. */
export function applyTurn(
  current: AthleteProfile,
  output: IntakeTurnOutput,
  opts: ApplyOptions = {},
): ApplyResult {
  const result = applyProfileUpdates(current, output.profile_updates, opts);
  result.profile.field_status = recomputeStatuses(result.profile, parseAssessments(output.field_assessments));
  return result;
}

export const TURN_CAP = 40;
export const ACTIVE_MINUTES_CAP = 15;

export interface TerminationInput {
  athleteTurns: number;
  activeMinutes: number;
  profile: AthleteProfile;
  eventReady: boolean;
  followUps: FollowUpCounters;
}

export type TerminationDecision =
  | { ready: true; reason: 'targets_reached' | 'turn_cap' | 'time_cap' }
  | { ready: false; minimumOnly: boolean; missingMinimum: string[] };

/** Termination (CONTRACTS §5): a target or cap is reached AND the generation minimum is met. */
export function checkTermination(input: TerminationInput): TerminationDecision {
  const missingMinimum = generationMinimumMissing(input.profile, input.eventReady);
  const status = input.profile.field_status;
  const targetsReached = FIELD_PATHS.every((p) => {
    if (SENSITIVE_PATHS.includes(p)) return true;
    const s: FieldStatus | undefined = status[p];
    return s === 'complete' || s === 'unsure' || s === 'skipped' || isFollowUpExhausted(input.followUps, p);
  });
  const capReason =
    input.athleteTurns >= TURN_CAP
      ? 'turn_cap'
      : input.activeMinutes >= ACTIVE_MINUTES_CAP
        ? 'time_cap'
        : null;
  const trigger = targetsReached ? 'targets_reached' : capReason;
  if (trigger && missingMinimum.length === 0) return { ready: true, reason: trigger };
  return { ready: false, minimumOnly: capReason !== null, missingMinimum };
}

/** Server appends Skip on sensitive paths and Not sure elsewhere (CONTRACTS §4.2). */
export function withStandardReplies(replies: readonly string[], targetPath: FieldPath | null): string[] {
  const extra = targetPath && FIELD_SPECS[targetPath].sensitive ? 'Skip' : 'Not sure';
  const base = replies.filter((r) => r !== 'Skip' && r !== 'Not sure');
  return [...base, extra];
}
