/**
 * JSON Schemas for Claude structured outputs (CONTRACTS §4.2). Generated from the Zod contracts so the
 * model-facing schema and the server-side validation cannot drift. The schemas avoid unions and optional
 * properties; lengths and counts are not enforced by the API and are checked by Zod after the call.
 */
import { z } from 'zod';
import { intakeTurnOutputSchema } from './intake';
import { judgementSchema } from './judge';
import { sessionTimelineSchema } from './timeline';

const toSchema = (schema: z.ZodType): Record<string, unknown> => {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
};

export const intakeTurnJsonSchema = () => toSchema(intakeTurnOutputSchema);
export const timelineJsonSchema = () => toSchema(sessionTimelineSchema);
export const judgementJsonSchema = () => toSchema(judgementSchema);
