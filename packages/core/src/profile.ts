/** Athlete profile contract, field paths, statuses and generation minimum (CONTRACTS §3). 🔒 sensitive. */
import { z } from 'zod';
import type { Engine } from './sports';

export const PROFILE_SCHEMA_VERSION = 'athlete_profile_v1' as const;

export const provenanceSchema = z.enum(['athlete', 'edited', 'default']);
export type Provenance = z.infer<typeof provenanceSchema>;

const textField = (max: number) => z.object({ value: z.string().max(max), source: provenanceSchema });
const listItem = (max: number) =>
  z.object({ item_id: z.string().min(1), value: z.string().max(max), source: provenanceSchema });

export const keyMomentSchema = z.object({
  item_id: z.string().min(1),
  label: z.string().max(60),
  description: z.string().max(300),
  body_feel: z.string().max(200),
  realtime_seconds: z.number().int().min(1).max(120).nullable(),
  source: provenanceSchema,
});

export const ifThenSchema = z.object({
  item_id: z.string().min(1),
  when: z.string().max(160),
  then: z.string().max(200),
  source: provenanceSchema,
});

export const levelSchema = z.enum(['recreational', 'amateur_competitive', 'collegiate', 'semi_pro', 'elite']);
export const anchorSchema = z.enum(['thumb_index_press', 'fist_squeeze', 'hand_on_chest', 'none']);
export const musicStyleSchema = z.enum(['ambient_warm', 'ambient_airy', 'low_drone', 'pulse', 'voice_only']);

export const FIELD_STATUSES = ['missing', 'partial', 'complete', 'skipped', 'unsure'] as const;
export const fieldStatusSchema = z.enum(FIELD_STATUSES);
export type FieldStatus = z.infer<typeof fieldStatusSchema>;

export const athleteProfileSchema = z.object({
  schema_version: z.literal(PROFILE_SCHEMA_VERSION),
  objective: z.object({
    primary: textField(200),
    process_success: textField(300),
    desired_outcome: textField(200).nullable(),
    why_now: textField(300).nullable(),
  }),
  sport: z.object({
    label: textField(60),
    supported_sport_id: z.string(),
    engine: z.string(),
    level: levelSchema,
  }),
  event: z.object({
    stakes: textField(200).nullable(),
    venue: textField(120).nullable(),
  }),
  scene: z.object({
    visual: z.array(listItem(160)).max(8),
    sounds: z.array(listItem(160)).max(6),
    smells: z.array(listItem(120)).max(4),
    weather_temperature: textField(160).nullable(),
    surface_equipment: z.array(listItem(160)).max(5),
    people_context: z.array(listItem(160)).max(5),
  }),
  performance: z.object({
    routine: textField(400).nullable(),
    key_moments: z.array(keyMomentSchema).max(4),
    controllables: z.array(listItem(160)).max(5),
  }),
  obstacles: z.object({
    hardest_moment: textField(300).nullable(),
    negative_self_talk: z.array(listItem(160)).max(3),
    disruptors: z.array(listItem(160)).max(4),
    past_setback: textField(300).nullable(),
  }),
  responses: z.object({
    if_then: z.array(ifThenSchema).max(3),
    cue_phrase: textField(40).nullable(),
  }),
  identity: z.object({
    hoped_self: textField(300).nullable(),
    intention: textField(160).nullable(),
    feared_self: textField(200).nullable(),
  }),
  outcome: z.object({
    visual: textField(200).nullable(),
    body: textField(200).nullable(),
    emotion: textField(120).nullable(),
    people: z.array(listItem(120)).max(4),
    first_action: textField(160).nullable(),
    anchor: anchorSchema,
  }),
  preferences: z.object({
    perspective: z.enum(['first_person', 'third_person']),
    voice_id: z.string(),
    music_style: musicStyleSchema,
    training_length_min: z.union([z.literal(10), z.literal(15)]),
    primer_length_min: z.union([z.literal(3), z.literal(5)]),
    feared_self_enabled: z.boolean(),
  }),
  learning_stage: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  field_status: z.record(z.string(), fieldStatusSchema),
});

export type AthleteProfile = z.infer<typeof athleteProfileSchema>;
export type KeyMoment = z.infer<typeof keyMomentSchema>;
export type IfThen = z.infer<typeof ifThenSchema>;

/** Kinds of field the model may target. */
export type FieldKind = 'text' | 'list' | 'key_moments' | 'if_then' | 'enum';

export interface FieldSpec {
  kind: FieldKind;
  /** Max length of a text value or of each list item's value. */
  max: number;
  /** Max list length (lists only). */
  maxCount?: number;
  sensitive: boolean;
  /** Structural target count for `complete` (lists only). */
  target?: number;
}

/** The closed set of model-writable paths (CONTRACTS §3.1) with their limits. */
export const FIELD_SPECS = {
  'objective.primary': { kind: 'text', max: 200, sensitive: false },
  'objective.process_success': { kind: 'text', max: 300, sensitive: false },
  'objective.desired_outcome': { kind: 'text', max: 200, sensitive: false },
  'objective.why_now': { kind: 'text', max: 300, sensitive: false },
  'sport.label': { kind: 'text', max: 60, sensitive: false },
  'sport.level': { kind: 'enum', max: 0, sensitive: false },
  'event.stakes': { kind: 'text', max: 200, sensitive: false },
  'event.venue': { kind: 'text', max: 120, sensitive: false },
  'scene.visual': { kind: 'list', max: 160, maxCount: 8, sensitive: false, target: 3 },
  'scene.sounds': { kind: 'list', max: 160, maxCount: 6, sensitive: false, target: 2 },
  'scene.smells': { kind: 'list', max: 120, maxCount: 4, sensitive: false, target: 1 },
  'scene.weather_temperature': { kind: 'text', max: 160, sensitive: false },
  'scene.surface_equipment': { kind: 'list', max: 160, maxCount: 5, sensitive: false, target: 1 },
  'scene.people_context': { kind: 'list', max: 160, maxCount: 5, sensitive: true, target: 1 },
  'performance.routine': { kind: 'text', max: 400, sensitive: false },
  'performance.key_moments': { kind: 'key_moments', max: 300, maxCount: 4, sensitive: false, target: 2 },
  'performance.controllables': { kind: 'list', max: 160, maxCount: 5, sensitive: false, target: 1 },
  'obstacles.hardest_moment': { kind: 'text', max: 300, sensitive: false },
  'obstacles.negative_self_talk': { kind: 'list', max: 160, maxCount: 3, sensitive: true, target: 1 },
  'obstacles.disruptors': { kind: 'list', max: 160, maxCount: 4, sensitive: false, target: 1 },
  'obstacles.past_setback': { kind: 'text', max: 300, sensitive: true },
  'responses.if_then': { kind: 'if_then', max: 200, maxCount: 3, sensitive: false, target: 1 },
  'responses.cue_phrase': { kind: 'text', max: 40, sensitive: false },
  'identity.hoped_self': { kind: 'text', max: 300, sensitive: false },
  'identity.intention': { kind: 'text', max: 160, sensitive: false },
  'identity.feared_self': { kind: 'text', max: 200, sensitive: true },
  'outcome.visual': { kind: 'text', max: 200, sensitive: false },
  'outcome.body': { kind: 'text', max: 200, sensitive: false },
  'outcome.emotion': { kind: 'text', max: 120, sensitive: false },
  'outcome.people': { kind: 'list', max: 120, maxCount: 4, sensitive: true, target: 1 },
  'outcome.first_action': { kind: 'text', max: 160, sensitive: false },
  'outcome.anchor': { kind: 'enum', max: 0, sensitive: false },
} as const satisfies Record<string, FieldSpec>;

export type FieldPath = keyof typeof FIELD_SPECS;
export const FIELD_PATHS = Object.keys(FIELD_SPECS) as FieldPath[];
export const SENSITIVE_PATHS = FIELD_PATHS.filter((p) => FIELD_SPECS[p].sensitive);

export function isFieldPath(p: string): p is FieldPath {
  return Object.prototype.hasOwnProperty.call(FIELD_SPECS, p);
}

export function getAtPath(profile: AthleteProfile, path: FieldPath): unknown {
  const [group, key] = path.split('.') as [keyof AthleteProfile, string];
  return (profile[group] as Record<string, unknown>)[key];
}

export function setAtPath(profile: AthleteProfile, path: FieldPath, value: unknown): void {
  const [group, key] = path.split('.') as [keyof AthleteProfile, string];
  (profile[group] as Record<string, unknown>)[key] = value;
}

export interface NewProfileInput {
  supportedSportId: string;
  engine: Engine;
  sportLabel: string;
  voiceId: string;
}

/** A new draft profile: everything empty, preferences at their documented defaults. */
export function createEmptyProfile(input: NewProfileInput): AthleteProfile {
  const profile: AthleteProfile = {
    schema_version: PROFILE_SCHEMA_VERSION,
    objective: {
      primary: { value: '', source: 'athlete' },
      process_success: { value: '', source: 'athlete' },
      desired_outcome: null,
      why_now: null,
    },
    sport: {
      label: { value: input.sportLabel, source: 'athlete' },
      supported_sport_id: input.supportedSportId,
      engine: input.engine,
      level: 'recreational',
    },
    event: { stakes: null, venue: null },
    scene: {
      visual: [],
      sounds: [],
      smells: [],
      weather_temperature: null,
      surface_equipment: [],
      people_context: [],
    },
    performance: { routine: null, key_moments: [], controllables: [] },
    obstacles: { hardest_moment: null, negative_self_talk: [], disruptors: [], past_setback: null },
    responses: { if_then: [], cue_phrase: null },
    identity: { hoped_self: null, intention: null, feared_self: null },
    outcome: {
      visual: null,
      body: null,
      emotion: null,
      people: [],
      first_action: null,
      anchor: 'thumb_index_press',
    },
    preferences: {
      perspective: 'first_person',
      voice_id: input.voiceId,
      music_style: 'ambient_warm',
      training_length_min: 15,
      primer_length_min: 5,
      feared_self_enabled: true,
    },
    learning_stage: 1,
    field_status: {},
  };
  return profile;
}

const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** Deterministic structural status (CONTRACTS §3.2 step 1). */
export function structuralStatus(
  profile: AthleteProfile,
  path: FieldPath,
): 'missing' | 'partial' | 'complete' {
  const spec: FieldSpec = FIELD_SPECS[path];
  const v = getAtPath(profile, path);
  switch (spec.kind) {
    case 'enum':
      return v ? 'complete' : 'missing';
    case 'text': {
      const t = (v as { value: string } | null)?.value ?? '';
      if (!t.trim()) return 'missing';
      // A cue phrase or intention is deliberately short; apply the 3-word rule to prose fields only.
      if (path === 'responses.cue_phrase' || path === 'identity.intention' || path === 'sport.label')
        return 'complete';
      return wordCount(t) < 3 ? 'partial' : 'complete';
    }
    case 'key_moments': {
      const items = v as KeyMoment[];
      if (items.length === 0) return 'missing';
      const full = items.filter((m) => m.label.trim() && m.description.trim()).length;
      return full >= (spec.target ?? 1) ? 'complete' : 'partial';
    }
    case 'if_then': {
      const items = v as IfThen[];
      if (items.length === 0) return 'missing';
      const full = items.filter((m) => m.when.trim() && m.then.trim()).length;
      return full >= (spec.target ?? 1) ? 'complete' : 'partial';
    }
    case 'list': {
      const items = v as { value: string }[];
      if (items.length === 0) return 'missing';
      return items.length >= (spec.target ?? 1) ? 'complete' : 'partial';
    }
  }
}

const RANK: Record<'missing' | 'partial' | 'complete', number> = { missing: 0, partial: 1, complete: 2 };

export type ModelQuality = 'missing' | 'partial' | 'complete';

/**
 * Final status: the lower of structural and model-proposed quality. The model can lower but never raise.
 * `skipped` and `unsure` come only from the athlete's choice and override both (CONTRACTS §3.2).
 */
export function computeFieldStatus(
  profile: AthleteProfile,
  path: FieldPath,
  previous: FieldStatus | undefined,
  modelQuality?: ModelQuality,
): FieldStatus {
  if (previous === 'skipped' || previous === 'unsure') return previous;
  const structural = structuralStatus(profile, path);
  if (!modelQuality) return structural;
  return RANK[modelQuality] < RANK[structural] ? modelQuality : structural;
}

export function recomputeStatuses(
  profile: AthleteProfile,
  assessments: Partial<Record<FieldPath, ModelQuality>> = {},
): Record<string, FieldStatus> {
  const out: Record<string, FieldStatus> = {};
  for (const p of FIELD_PATHS) {
    out[p] = computeFieldStatus(profile, p, profile.field_status[p], assessments[p]);
  }
  return out;
}

/** Generation minimum (CONTRACTS §3.3). `eventReady` = an events row with name, local start and zone exists. */
export function generationMinimumMissing(profile: AthleteProfile, eventReady: boolean): string[] {
  const missing: string[] = [];
  const complete = (p: FieldPath) => structuralStatus(profile, p) === 'complete';
  for (const p of [
    'objective.primary',
    'objective.process_success',
    'obstacles.hardest_moment',
    'responses.cue_phrase',
    'identity.intention',
  ] as FieldPath[]) {
    if (!complete(p)) missing.push(p);
  }
  if (!profile.sport.label.value.trim() || !profile.sport.engine) missing.push('sport.label');
  if (!eventReady) missing.push('event');
  if (profile.scene.visual.length < 1) missing.push('scene.visual');
  if (profile.scene.sounds.length < 1) missing.push('scene.sounds');
  if (profile.performance.key_moments.filter((m) => m.label.trim() && m.description.trim()).length < 2) {
    missing.push('performance.key_moments');
  }
  if (profile.responses.if_then.filter((m) => m.when.trim() && m.then.trim()).length < 1) {
    missing.push('responses.if_then');
  }
  if (!profile.outcome.visual?.value.trim() && !profile.outcome.body?.value.trim())
    missing.push('outcome.visual_or_body');
  if (!profile.preferences.voice_id) missing.push('preferences.voice_id');
  return missing;
}

export function meetsGenerationMinimum(profile: AthleteProfile, eventReady: boolean): boolean {
  return generationMinimumMissing(profile, eventReady).length === 0;
}
