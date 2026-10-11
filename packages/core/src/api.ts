/** Request body contracts for the public API (SPEC §11.1), shared by the API and the mobile client. */
import { z } from 'zod';
import { CUSTOM_ENDURANCE_LABEL_MAX, CUSTOM_ENDURANCE_QUESTIONS } from './sports';
import { anchorSchema, levelSchema, musicStyleSchema } from './profile';
import { CONTEXTS } from './timeline';

export const consentsBodySchema = z.object({
  consents: z
    .array(
      z.object({
        kind: z.enum(['privacy', 'terms', 'processing', 'notifications', 'analytics']),
        version: z.string().min(1).max(40),
        accepted: z.boolean(),
      }),
    )
    .min(1)
    .max(5),
});

/** Only a passing result is recorded: under-18 outcomes store nothing (SPEC §8.2). No birth date. */
export const ageAssuranceBodySchema = z.object({
  method: z.enum(['declared_age_range', 'self_attested']),
});

export const waitlistBodySchema = z.object({ sport_label: z.string().trim().min(1).max(60) });

export const deviceBodySchema = z.object({
  push_token: z.string().min(10).max(300),
  app_version: z.string().max(40).optional(),
});

export const EVENT_NAME_MAX = 120;

const localStart = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Expected YYYY-MM-DDTHH:mm');

export const eventCreateBodySchema = z.object({
  name: z.string().trim().min(1).max(EVENT_NAME_MAX),
  starts_local: localStart,
  time_zone: z.string().min(3).max(64),
  supported_sport_id: z.string().min(1).max(60),
  /** Required (and only used) for `custom_endurance`. */
  custom_label: z.string().trim().min(1).max(CUSTOM_ENDURANCE_LABEL_MAX).optional(),
  custom_answers: z.array(z.boolean()).length(CUSTOM_ENDURANCE_QUESTIONS.length).optional(),
  /** Preferred training days for the 21+ day program, 0 = Sunday. Default Tuesday and Saturday. */
  training_days: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
});

export const eventPatchBodySchema = z
  .object({
    name: z.string().trim().min(1).max(EVENT_NAME_MAX),
    starts_local: localStart,
    time_zone: z.string().min(3).max(64),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

export const intakeConversationBodySchema = z.object({ event_id: z.string().uuid() });

/** Athlete edits as ops: the same validation as the model path (SPEC §11.1 PATCH /profile). */
export const profilePatchBodySchema = z.object({
  base_version: z.number().int().min(1),
  updates: z
    .array(
      z.object({
        op: z.enum(['set', 'add_item', 'replace_item', 'remove_item', 'mark_unsure']),
        path: z.string(),
        item_id: z.string(),
        value: z.string(),
      }),
    )
    .min(1)
    .max(40),
});

export const preferencesBodySchema = z.object({
  perspective: z.enum(['first_person', 'third_person']),
  voice_id: z.string().min(1).max(60),
  music_style: musicStyleSchema,
  training_length_min: z.union([z.literal(10), z.literal(15)]),
  primer_length_min: z.union([z.literal(3), z.literal(5)]),
  feared_self_enabled: z.boolean(),
  outcome_anchor: anchorSchema.optional(),
  level: levelSchema.optional(),
});

export const sessionCreateBodySchema = z.object({
  program_item_id: z.string().uuid().nullable(),
  context: z.enum(CONTEXTS),
  length_min: z.union([z.literal(3), z.literal(5), z.literal(10), z.literal(15)]),
});

export const SESSION_LENGTHS: Record<(typeof CONTEXTS)[number], readonly number[]> = {
  training: [10, 15],
  night_before: [15],
  primer: [3, 5],
};

export const playsBodySchema = z.object({
  plays: z
    .array(
      z.object({
        client_event_id: z.string().uuid(),
        mark: z.enum(['start', '25', '50', '80', '100']),
        position_ms: z.number().int().min(0),
        occurred_at: z.string().datetime(),
      }),
    )
    .min(1)
    .max(50),
});

export const downloadVerifiedBodySchema = z.object({
  device_id: z.string().uuid().optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().positive(),
});

export const checkinBodySchema = z.object({
  vividness: z.number().int().min(1).max(5),
  readiness: z.number().int().min(1).max(5),
  useful: z.string().max(280).optional(),
  off: z.string().max(280).optional(),
});

export const debriefBodySchema = z.object({
  event_id: z.string().uuid(),
  overall: z.number().int().min(1).max(5),
  went_well: z.string().max(280).optional(),
  harder: z.string().max(280).optional(),
  cue_helped: z.enum(['yes', 'somewhat', 'no', 'not_used']),
  next_time: z.string().max(280).optional(),
});

export const debriefConfirmBodySchema = z.object({ accepted_item_ids: z.array(z.string()).max(40) });
