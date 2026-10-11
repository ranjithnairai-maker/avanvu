/**
 * Post-event debrief (SPEC §8.4): a short structured form, a model proposal in the same op schema as the
 * interview, and a checklist the athlete confirms. Only checked items become a new profile version. Exact
 * words (cue phrase, intention, self-talk) and skipped paths are never changed unless the athlete checks that
 * item. Debrief text is sealed. The deterministic safety screen runs before any model call.
 */
import {
  AvanvuError,
  FIELD_PATHS,
  DEBRIEF_SYSTEM_PROMPT,
  LEXICON_VERSION,
  PROTECTED_PATHS,
  applyProfileUpdates,
  buildDebriefUserPayload,
  debriefJsonSchema,
  debriefOutputSchema,
  isFieldPath,
  normalizeDebriefOutput,
  screenMessage,
  AMBIGUOUS_CLARIFICATION_MESSAGE,
  type DebriefAnswers,
  type ProfileUpdate,
} from '@avanvu/core';
import type { Tx } from '../db/tx';
import type { LlmClient, LlmUsage } from '../ports/llm';
import type { UserSealer } from '../security/seal';
import { createProfileVersion, latestProfile } from './profile';

export interface Proposal {
  id: string;
  op: ProfileUpdate['op'];
  path: string;
  item_id: string;
  value: string;
  /** Exact-word fields are never pre-checked. */
  default_checked: boolean;
}

export interface DebriefProposal {
  id: string;
  summary: string;
  proposals: Proposal[];
  learning_stage_change: 'none' | 'advance';
}

export type DebriefResult =
  | { kind: 'proposed'; value: DebriefProposal; usage: LlmUsage[] }
  | { kind: 'clarify'; message: string }
  | { kind: 'crisis'; layer: 'deterministic' | 'model' };

const answersCtx = (id: string) => ({
  table: 'event_debriefs',
  column: 'answers_enc',
  rowId: id,
  schemaVersion: 'debrief_answers_v1',
});
const proposalsCtx = (id: string) => ({
  table: 'event_debriefs',
  column: 'proposals_enc',
  rowId: id,
  schemaVersion: 'debrief_proposals_v1',
});

export async function proposeDebrief(
  trx: Tx,
  deps: { llm: LlmClient; now: Date; timeoutMs: number },
  sealer: UserSealer,
  userId: string,
  eventId: string,
  answers: DebriefAnswers,
): Promise<DebriefResult & { debriefId?: string }> {
  const event = await trx
    .selectFrom('app.events')
    .select(['id', 'starts_at'])
    .where('id', '=', eventId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!event) throw new AvanvuError('NOT_FOUND', 'Event not found.');
  if (new Date(event.starts_at) > deps.now) {
    throw new AvanvuError('VALIDATION_FAILED', 'The debrief opens once your event has started.');
  }
  const existing = await trx
    .selectFrom('app.event_debriefs')
    .select('id')
    .where('event_id', '=', eventId)
    .executeTakeFirst();
  if (existing) throw new AvanvuError('VALIDATION_FAILED', 'You have already debriefed this event.');

  // Layer 1 first, before any model call.
  const text = [answers.went_well, answers.harder, answers.next_time].filter(Boolean).join(' ');
  const screen = screenMessage(text);
  if (screen === 'crisis') return { kind: 'crisis', layer: 'deterministic' };
  if (screen === 'ambiguous') return { kind: 'clarify', message: AMBIGUOUS_CLARIFICATION_MESSAGE };

  const current = await latestProfile(trx, sealer, userId);
  if (!current) throw new AvanvuError('NOT_FOUND', 'No confirmed profile yet.');
  const skipped = FIELD_PATHS.filter((p) => current.profile.field_status[p] === 'skipped');

  const call = async () => {
    const r = await deps.llm.complete({
      task: 'debrief',
      systemPrompt: DEBRIEF_SYSTEM_PROMPT,
      userPayload: buildDebriefUserPayload({
        answers,
        profile: { ...current.profile, field_status: undefined, preferences: undefined },
        skippedPaths: skipped,
        allowedPaths: FIELD_PATHS,
      }),
      jsonSchema: debriefJsonSchema(),
      timeoutMs: deps.timeoutMs,
      repair: false,
    });
    return r;
  };
  let first;
  try {
    first = await call();
  } catch {
    throw new AvanvuError('UPSTREAM_UNAVAILABLE', "We couldn't prepare your learnings. Try again.");
  }
  const parsed = debriefOutputSchema.safeParse(normalizeDebriefOutput(first.output));
  if (!parsed.success)
    throw new AvanvuError('UPSTREAM_UNAVAILABLE', "We couldn't prepare your learnings. Try again.");
  const out = parsed.data;
  if (out.safety_signal === 'crisis') return { kind: 'crisis', layer: 'model' };
  if (out.safety_signal === 'ambiguous') return { kind: 'clarify', message: AMBIGUOUS_CLARIFICATION_MESSAGE };

  // Keep only updates that apply cleanly to the current profile; never anything the model may not touch.
  const proposals: Proposal[] = [];
  out.profile_updates.forEach((u, i) => {
    if (!isFieldPath(u.path) || skipped.includes(u.path as never)) return;
    if (u.op === 'mark_skipped') return;
    const r = applyProfileUpdates(current.profile, [u]);
    if (r.accepted !== 1) return;
    proposals.push({
      id: `p${i + 1}`,
      op: u.op,
      path: u.path,
      item_id: u.item_id,
      value: u.value,
      default_checked: !(PROTECTED_PATHS as readonly string[]).includes(u.path),
    });
  });

  const id = crypto.randomUUID();
  const value: DebriefProposal = {
    id,
    summary: out.summary,
    proposals,
    learning_stage_change: out.learning_stage_change,
  };
  await trx
    .insertInto('app.event_debriefs')
    .values({
      id,
      user_id: userId,
      event_id: eventId,
      overall: answers.overall,
      cue_helped: answers.cue_helped,
      answers_enc: await sealer.seal(answersCtx(id), answers),
      proposals_enc: await sealer.seal(proposalsCtx(id), value),
    } as never)
    .execute();
  return { kind: 'proposed', value, usage: [first.usage], debriefId: id };
}

/** Apply only the checked items. A stage advance needs the explicit `learning_stage` item. */
export async function confirmDebrief(
  trx: Tx,
  sealer: UserSealer,
  userId: string,
  debriefId: string,
  acceptedIds: readonly string[],
  now: Date,
): Promise<{ version: number; applied: number }> {
  const row = await trx
    .selectFrom('app.event_debriefs')
    .select(['id', 'event_id', 'proposals_enc', 'confirmed_at'])
    .where('id', '=', debriefId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!row || !row.proposals_enc) throw new AvanvuError('NOT_FOUND', 'Debrief not found.');
  if (row.confirmed_at) throw new AvanvuError('VALIDATION_FAILED', 'This debrief is already confirmed.');
  const proposal = await sealer.open<DebriefProposal>(proposalsCtx(debriefId), row.proposals_enc);
  const known = new Set(proposal.proposals.map((p) => p.id));
  if (acceptedIds.some((a) => a !== 'learning_stage' && !known.has(a))) {
    throw new AvanvuError('VALIDATION_FAILED', 'Check these fields: accepted_item_ids.');
  }
  const current = await latestProfile(trx, sealer, userId);
  if (!current) throw new AvanvuError('NOT_FOUND', 'No confirmed profile yet.');
  const chosen = proposal.proposals.filter((p) => acceptedIds.includes(p.id));
  const r = applyProfileUpdates(
    current.profile,
    chosen.map(({ op, path, item_id, value }) => ({ op, path, item_id, value })),
    { source: 'edited' },
  );
  const next = r.profile;
  if (
    acceptedIds.includes('learning_stage') &&
    proposal.learning_stage_change === 'advance' &&
    next.learning_stage < 3
  ) {
    next.learning_stage = (next.learning_stage + 1) as 2 | 3;
  }
  const stored = await createProfileVersion(trx, sealer, userId, next, 'debrief', current.event_id);
  await trx
    .updateTable('app.event_debriefs')
    .set({ confirmed_items: JSON.stringify(acceptedIds) as never, confirmed_at: now })
    .where('id', '=', debriefId)
    .execute();
  await trx.updateTable('app.events').set({ status: 'completed' }).where('id', '=', row.event_id).execute();
  return { version: stored.version, applied: r.accepted };
}

export { LEXICON_VERSION };
