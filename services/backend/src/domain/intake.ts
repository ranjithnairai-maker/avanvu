/**
 * The interview engine: conversation lifecycle and the 12-step turn algorithm (CONTRACTS §4.3, §5).
 *
 * Order matters and is tested: authenticate -> idempotency -> revision check -> lease -> deterministic
 * safety screen -> model call (outside any transaction) -> validate -> apply allowlisted updates -> termination
 * check -> one short compare-and-swap commit that also records the idempotency result.
 * No transaction is ever held open across the model call.
 */
import {
  ACTIVE_MINUTES_CAP,
  AMBIGUOUS_CLARIFICATION_MESSAGE,
  AvanvuError,
  FIELD_PATHS,
  INTAKE_OPENING_MESSAGE,
  INTAKE_SYSTEM_PROMPT,
  LEXICON_VERSION,
  PHASES,
  PHASE_COUNT_TOTAL,
  PHASE_OPENINGS,
  PROFILE_SCHEMA_VERSION,
  TURN_CAP,
  WRAP_UP_MESSAGE,
  applyTurn,
  assistantMessageStyleIssues,
  assistantWordCount,
  buildIntakeUserPayload,
  bumpFollowUp,
  checkTermination,
  createEmptyProfile,
  exhaustedPaths,
  generationMinimumMissing,
  getSport,
  intakeTurnJsonSchema,
  isFieldPath,
  nextPendingPhase,
  parseIntakeOutput,
  phasesResolved,
  pickTargetPath,
  promptVersion,
  recomputeStatuses,
  screenMessage,
  withStandardReplies,
  type AthleteProfile,
  type FieldPath,
  type FollowUpCounters,
  type IntakeTurnOutput,
  type IntakeTurnRequest,
  type Phase,
} from '@avanvu/core';
import type { Tx } from '../db/tx';
import { withUserTx, type Db } from '../db/tx';
import type { IdempotentResult } from '../http/idempotency';
import { Idempotency, type IdempotentRequest } from '../http/idempotency';
import type { Logger } from '../observability/logger';
import { LlmError, type LlmClient, type LlmResponse } from '../ports/llm';
import type { Sealer, UserSealer } from '../security/seal';

export interface IntakeEnv {
  db: Db;
  sealer: Sealer;
  idem: Idempotency;
  llm: LlmClient;
  logger: Logger;
  now: () => Date;
  intakeTimeoutMs: number;
}

const LEASE_MS = 60_000;
const ACTIVE_GAP_CAP_MS = 120_000;
const RECENT_TURNS = 6;
const OPEN_STATES = new Set(['ACTIVE', 'AWAITING_USER', 'RETRYABLE_ERROR']);

interface TurnContent {
  text: string;
  quick_replies?: string[];
}

const turnCtx = (turnId: string) => ({
  table: 'intake_turns',
  column: 'content_enc',
  rowId: turnId,
  schemaVersion: 'intake_turn_v1',
});
const draftCtx = (conversationId: string) => ({
  table: 'athlete_profile_drafts',
  column: 'draft_enc',
  rowId: conversationId,
  schemaVersion: PROFILE_SCHEMA_VERSION,
});

export interface ConversationView {
  id: string;
  event_id: string;
  state: string;
  revision: number;
  phase: string;
  turns: { seq: number; role: 'athlete' | 'assistant'; text: string }[];
  quick_replies: string[];
  progress: { phase: string; phases_complete: number; phases_total: number; minimum_met: boolean };
  summary_available: boolean;
  minimum_missing: string[];
  profile: AthleteProfile;
}

interface ConversationRow {
  id: string;
  event_id: string;
  state: string;
  paused_from: string | null;
  phase: string;
  revision: number;
  follow_up_counters: unknown;
  athlete_turns: number;
  active_seconds: number;
  updated_at: Date;
}

const counters = (row: ConversationRow): FollowUpCounters =>
  (row.follow_up_counters ?? {}) as FollowUpCounters;

async function loadConversation(trx: Tx, userId: string, id: string): Promise<ConversationRow> {
  const row = await trx
    .selectFrom('app.intake_conversations')
    .select([
      'id',
      'event_id',
      'state',
      'paused_from',
      'phase',
      'revision',
      'follow_up_counters',
      'athlete_turns',
      'active_seconds',
      'updated_at',
    ])
    .where('id', '=', id)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!row) throw new AvanvuError('NOT_FOUND', 'Conversation not found.');
  return { ...row, updated_at: new Date(row.updated_at) } as ConversationRow;
}

async function loadDraft(trx: Tx, sealer: UserSealer, conversationId: string): Promise<AthleteProfile> {
  const row = await trx
    .selectFrom('app.athlete_profile_drafts')
    .select('draft_enc')
    .where('conversation_id', '=', conversationId)
    .executeTakeFirstOrThrow();
  return sealer.open<AthleteProfile>(draftCtx(conversationId), row.draft_enc);
}

export async function saveDraft(
  trx: Tx,
  sealer: UserSealer,
  conversationId: string,
  profile: AthleteProfile,
  now: Date,
): Promise<void> {
  await trx
    .updateTable('app.athlete_profile_drafts')
    .set({ draft_enc: await sealer.seal(draftCtx(conversationId), profile), updated_at: now })
    .where('conversation_id', '=', conversationId)
    .execute();
}

async function loadTurns(trx: Tx, sealer: UserSealer, conversationId: string, limit?: number) {
  let q = trx
    .selectFrom('app.intake_turns')
    .select(['id', 'seq', 'role', 'content_enc'])
    .where('conversation_id', '=', conversationId)
    .where('status', '=', 'committed')
    .orderBy('seq', 'desc');
  if (limit) q = q.limit(limit);
  const rows = (await q.execute()).reverse();
  const out: { seq: number; role: 'athlete' | 'assistant'; text: string; quick_replies: string[] }[] = [];
  for (const r of rows) {
    if (!r.content_enc) continue;
    const c = await sealer.open<TurnContent>(turnCtx(r.id), r.content_enc);
    out.push({ seq: r.seq, role: r.role, text: c.text, quick_replies: c.quick_replies ?? [] });
  }
  return out;
}

function progressOf(profile: AthleteProfile, row: ConversationRow, minimumMissing: string[]) {
  const resolved = phasesResolved(profile.field_status, counters(row));
  const ready =
    row.state === 'READY_FOR_SUMMARY' || row.state === 'SUMMARY_CONFIRMED' || row.state === 'COMPLETE';
  return {
    phase: row.phase,
    phases_complete: Math.min(PHASE_COUNT_TOTAL, resolved + (ready ? 1 : 0)),
    phases_total: PHASE_COUNT_TOTAL,
    minimum_met: minimumMissing.length === 0,
  };
}

export async function conversationView(
  trx: Tx,
  sealer: UserSealer,
  userId: string,
  id: string,
): Promise<ConversationView> {
  const row = await loadConversation(trx, userId, id);
  const profile = await loadDraft(trx, sealer, id);
  const turns = await loadTurns(trx, sealer, id);
  const missing = generationMinimumMissing(profile, true);
  const lastAssistant = [...turns].reverse().find((t) => t.role === 'assistant');
  return {
    id: row.id,
    event_id: row.event_id,
    state: row.state,
    revision: row.revision,
    phase: row.phase,
    turns: turns.map(({ seq, role, text }) => ({ seq, role, text })),
    quick_replies: lastAssistant?.quick_replies ?? [],
    progress: progressOf(profile, row, missing),
    summary_available: ['READY_FOR_SUMMARY', 'SUMMARY_CONFIRMED', 'COMPLETE'].includes(row.state),
    minimum_missing: missing,
    profile,
  };
}

/** Start (or return) the active conversation for an event. The opening question needs no model call. */
export async function startConversation(
  trx: Tx,
  sealer: UserSealer,
  userId: string,
  eventId: string,
  now: Date,
): Promise<{ created: boolean; view: ConversationView }> {
  const event = await trx
    .selectFrom('app.events')
    .select(['id', 'supported_sport_id', 'engine', 'sport_label_enc'])
    .where('id', '=', eventId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!event) throw new AvanvuError('NOT_FOUND', 'Event not found.');

  const live = await trx
    .selectFrom('app.intake_conversations')
    .select('id')
    .where('event_id', '=', eventId)
    .where('state', 'not in', ['SAFETY_INTERRUPTED', 'COMPLETE'])
    .executeTakeFirst();
  if (live) return { created: false, view: await conversationView(trx, sealer, userId, live.id) };

  const sport = getSport(event.supported_sport_id);
  if (!sport) throw new AvanvuError('UNSUPPORTED_SPORT', "We don't support that sport yet.");
  const label = event.sport_label_enc
    ? await sealer.open<string>(
        { table: 'events', column: 'sport_label_enc', rowId: event.id, schemaVersion: 'sport_label_v1' },
        event.sport_label_enc,
      )
    : sport.label;

  const voice = await trx
    .selectFrom('app.voice_catalog')
    .select('id')
    .where('active', '=', true)
    .orderBy('id')
    .executeTakeFirst();
  const draft = createEmptyProfile({
    supportedSportId: sport.id,
    engine: sport.engine,
    sportLabel: label,
    voiceId: voice?.id ?? '',
  });
  draft.field_status = recomputeStatuses(draft);

  const conversationId = crypto.randomUUID();
  await trx
    .insertInto('app.intake_conversations')
    .values({
      id: conversationId,
      user_id: userId,
      event_id: eventId,
      state: 'AWAITING_USER',
      phase: 'objective',
      revision: 0,
      created_at: now,
      updated_at: now,
    } as never)
    .execute();
  await trx
    .insertInto('app.athlete_profile_drafts')
    .values({
      conversation_id: conversationId,
      user_id: userId,
      draft_enc: await sealer.seal(draftCtx(conversationId), draft),
      updated_at: now,
    })
    .execute();
  const turnId = crypto.randomUUID();
  await trx
    .insertInto('app.intake_turns')
    .values({
      id: turnId,
      user_id: userId,
      conversation_id: conversationId,
      seq: 1,
      role: 'assistant',
      client_message_id: null,
      idempotency_key: null,
      status: 'committed',
      lease_expires_at: null,
      input_mode: null,
      content_enc: await sealer.seal(turnCtx(turnId), { text: INTAKE_OPENING_MESSAGE, quick_replies: [] }),
      safety_result: null,
      versions: null,
    } as never)
    .execute();
  return { created: true, view: await conversationView(trx, sealer, userId, conversationId) };
}

export async function setPaused(
  trx: Tx,
  userId: string,
  id: string,
  pause: boolean,
  now: Date,
): Promise<void> {
  const row = await loadConversation(trx, userId, id);
  if (row.state === 'SAFETY_INTERRUPTED')
    throw new AvanvuError('SAFETY_INTERRUPTED', 'This conversation has ended.');
  if (pause) {
    if (row.state === 'PAUSED') return;
    if (!['ACTIVE', 'AWAITING_USER', 'RETRYABLE_ERROR', 'READY_FOR_SUMMARY'].includes(row.state)) {
      throw new AvanvuError('VALIDATION_FAILED', "This interview can't be paused right now.");
    }
    await trx
      .updateTable('app.intake_conversations')
      .set({ state: 'PAUSED', paused_from: row.state, updated_at: now })
      .where('id', '=', id)
      .execute();
  } else {
    if (row.state !== 'PAUSED') return;
    await trx
      .updateTable('app.intake_conversations')
      .set({ state: (row.paused_from ?? 'AWAITING_USER') as never, paused_from: null, updated_at: now })
      .where('id', '=', id)
      .execute();
  }
}

// ---------------------------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------------------------

export interface TurnResponse {
  revision: number;
  state: string;
  assistant_message: string;
  quick_replies: string[];
  progress: ConversationView['progress'];
  summary_available: boolean;
}

interface Claimed {
  conv: ConversationRow;
  athleteTurnId: string;
  seq: number;
  draft: AthleteProfile;
  recent: { role: 'athlete' | 'assistant'; text: string }[];
}

export class IntakeTurns {
  constructor(private readonly env: IntakeEnv) {}

  async run(
    userId: string,
    req: IntakeTurnRequest,
    idemReq: IdempotentRequest,
    requestId: string,
  ): Promise<IdempotentResult> {
    const { env } = this;
    const sealer = await env.sealer.forUser(userId); // load the key before any transaction
    const started = await env.idem.begin(idemReq, sealer);
    if (started.kind === 'replay') return started.result;
    try {
      return await this.process(userId, req, idemReq, requestId, sealer);
    } catch (e) {
      await env.idem.release(idemReq).catch(() => undefined);
      throw e;
    }
  }

  private async process(
    userId: string,
    req: IntakeTurnRequest,
    idemReq: IdempotentRequest,
    requestId: string,
    sealer: UserSealer,
  ): Promise<IdempotentResult> {
    const { env } = this;
    const startedAt = env.now();

    // Steps 3 and 4: revision check and turn lease, in one short transaction.
    const claimed = await withUserTx(env.db, userId, (trx) =>
      this.claim(trx, sealer, userId, req, idemReq, startedAt),
    );

    // Step 5: deterministic safety screen, before any model call.
    const layer1 = screenMessage(req.content);
    if (layer1 === 'crisis') {
      return this.interrupt(userId, claimed, idemReq, requestId, sealer, 'deterministic');
    }

    let output: IntakeTurnOutput;
    let modelInfo: { model: string; repaired: boolean; prompt: string } | null = null;
    const usages: LlmResponse['usage'][] = [];
    if (layer1 === 'ambiguous') {
      // Reviewed clarification instead of a model question; nothing from this turn updates the profile.
      output = {
        assistant_message: AMBIGUOUS_CLARIFICATION_MESSAGE,
        quick_replies: [],
        profile_updates: [],
        field_assessments: [],
        safety_signal: 'ambiguous',
        next_focus: (PHASES.includes(claimed.conv.phase as Phase)
          ? claimed.conv.phase
          : 'objective') as Phase,
      };
    } else {
      // Step 6 to 8: the model call happens with no transaction open.
      try {
        const r = await this.callModel(claimed, req, usages);
        output = r.output;
        modelInfo = r.info;
      } catch (e) {
        await withUserTx(env.db, userId, (trx) => this.releaseLease(trx, claimed, startedAt));
        if (e instanceof AvanvuError) throw e;
        throw new AvanvuError(
          'UPSTREAM_UNAVAILABLE',
          "We couldn't reach the interviewer. Your answer is saved; try again.",
        );
      }
      // Step 7: model-reported safety.
      if (output.safety_signal === 'crisis') {
        return this.interrupt(userId, claimed, idemReq, requestId, sealer, 'model');
      }
      if (output.safety_signal === 'ambiguous') {
        output = {
          ...output,
          assistant_message: AMBIGUOUS_CLARIFICATION_MESSAGE,
          quick_replies: [],
          profile_updates: [],
          field_assessments: [],
        };
      }
    }

    // Steps 9 to 12.
    return this.commit(userId, claimed, output, modelInfo, usages, idemReq, sealer, startedAt);
  }

  /** Steps 3 and 4. */
  private async claim(
    trx: Tx,
    sealer: UserSealer,
    userId: string,
    req: IntakeTurnRequest,
    idemReq: IdempotentRequest,
    now: Date,
  ): Promise<Claimed> {
    const conv = await loadConversation(trx, userId, req.conversation_id);
    if (conv.state === 'SAFETY_INTERRUPTED') {
      throw new AvanvuError('SAFETY_INTERRUPTED', 'This conversation has ended.');
    }
    if (conv.revision !== req.expected_revision) {
      throw new AvanvuError(
        'PROFILE_REVISION_CONFLICT',
        'This interview changed on another device. Refreshing.',
        {
          latest: { revision: conv.revision, state: conv.state },
        },
      );
    }

    const processing = await trx
      .selectFrom('app.intake_turns')
      .select(['id', 'lease_expires_at', 'client_message_id'])
      .where('conversation_id', '=', conv.id)
      .where('status', '=', 'processing')
      .executeTakeFirst();
    if (processing) {
      const leaseLive = processing.lease_expires_at && new Date(processing.lease_expires_at) > now;
      if (leaseLive && processing.client_message_id !== req.client_message_id) {
        throw new AvanvuError('TURN_IN_PROGRESS', 'Your previous answer is still being processed.', {
          retryAfterMs: 2000,
        });
      }
      // Expired lease (a crashed request) or the same message being retried: take it over.
      await trx
        .updateTable('app.intake_turns')
        .set({ status: 'retryable_error', lease_expires_at: null })
        .where('id', '=', processing.id)
        .execute();
    } else if (!OPEN_STATES.has(conv.state) && conv.state !== 'PROCESSING_TURN') {
      throw new AvanvuError('VALIDATION_FAILED', "The interview isn't accepting answers right now.");
    }

    const sameMessage = await trx
      .selectFrom('app.intake_turns')
      .select(['id', 'status', 'seq'])
      .where('conversation_id', '=', conv.id)
      .where('client_message_id', '=', req.client_message_id)
      .executeTakeFirst();
    if (sameMessage?.status === 'committed') {
      throw new AvanvuError('PROFILE_REVISION_CONFLICT', 'That answer was already recorded.', {
        latest: { revision: conv.revision, state: conv.state },
      });
    }

    let turnId: string;
    let seq: number;
    const leaseUntil = new Date(now.getTime() + LEASE_MS);
    if (sameMessage) {
      turnId = sameMessage.id;
      seq = sameMessage.seq;
      await trx
        .updateTable('app.intake_turns')
        .set({
          status: 'processing',
          lease_expires_at: leaseUntil,
          idempotency_key: idemReq.key,
          input_mode: req.input_mode,
          content_enc: await sealer.seal(turnCtx(turnId), { text: req.content }),
        })
        .where('id', '=', turnId)
        .execute();
    } else {
      turnId = crypto.randomUUID();
      const max = await trx
        .selectFrom('app.intake_turns')
        .select((eb) => eb.fn.max('seq').as('m'))
        .where('conversation_id', '=', conv.id)
        .executeTakeFirst();
      seq = Number(max?.m ?? 0) + 1;
      try {
        await trx
          .insertInto('app.intake_turns')
          .values({
            id: turnId,
            user_id: userId,
            conversation_id: conv.id,
            seq,
            role: 'athlete',
            client_message_id: req.client_message_id,
            idempotency_key: idemReq.key,
            status: 'processing',
            lease_expires_at: leaseUntil,
            input_mode: req.input_mode,
            content_enc: await sealer.seal(turnCtx(turnId), { text: req.content }),
            safety_result: null,
            versions: null,
          } as never)
          .execute();
      } catch {
        throw new AvanvuError('TURN_IN_PROGRESS', 'Your previous answer is still being processed.', {
          retryAfterMs: 2000,
        });
      }
    }
    await trx
      .updateTable('app.intake_conversations')
      .set({ state: 'PROCESSING_TURN' })
      .where('id', '=', conv.id)
      .execute();

    const draft = await loadDraft(trx, sealer, conv.id);
    const recent = (await loadTurns(trx, sealer, conv.id, RECENT_TURNS)).map(({ role, text }) => ({
      role,
      text,
    }));
    return { conv, athleteTurnId: turnId, seq, draft, recent };
  }

  private async releaseLease(trx: Tx, c: Claimed, now: Date): Promise<void> {
    await trx
      .updateTable('app.intake_turns')
      .set({ status: 'retryable_error', lease_expires_at: null })
      .where('id', '=', c.athleteTurnId)
      .execute();
    await trx
      .updateTable('app.intake_conversations')
      .set({ state: 'RETRYABLE_ERROR', updated_at: now })
      .where('id', '=', c.conv.id)
      .execute();
  }

  /** Steps 6 to 8: call the model, validate, repair once. Never logs prompts or outputs. */
  private async callModel(c: Claimed, req: IntakeTurnRequest, usages: LlmResponse['usage'][]) {
    const { env } = this;
    const fu = counters(c.conv);
    const missingMinimum = generationMinimumMissing(c.draft, true).filter(isFieldPath);
    const minimumOnly = c.conv.athlete_turns >= TURN_CAP || c.conv.active_seconds / 60 >= ACTIVE_MINUTES_CAP;
    const phase = (PHASES.includes(c.conv.phase as Phase) ? c.conv.phase : 'objective') as Phase;
    const skipped = FIELD_PATHS.filter((p) => c.draft.field_status[p] === 'skipped');
    const focusHint = minimumOnly
      ? `Ask only for these missing essentials: ${missingMinimum.filter((p) => !fu[p] || fu[p] < 2).join(', ')}.`
      : `${phase}. A good next opening if you move on: ${PHASE_OPENINGS[nextPendingPhase(c.draft.field_status, fu, phase) ?? phase]}`;
    const userPayload = buildIntakeUserPayload({
      engine: c.draft.sport.engine as never,
      draft: stripServerOwned(c.draft),
      statuses: c.draft.field_status,
      skippedPaths: skipped,
      exhaustedPaths: exhaustedPaths(fu),
      allowedPaths: FIELD_PATHS,
      focusHint,
      recentTurns: c.recent,
      athleteMessage: req.content,
    });
    const jsonSchema = intakeTurnJsonSchema();
    const prompt = await promptVersion('intake');

    const attempt = async (repair: boolean, payload: string) => {
      const r = await withTimeout(
        env.llm.complete({
          task: 'intake',
          systemPrompt: INTAKE_SYSTEM_PROMPT,
          userPayload: payload,
          jsonSchema,
          timeoutMs: env.intakeTimeoutMs,
          repair,
        }),
        env.intakeTimeoutMs,
      );
      usages.push(r.usage);
      return r;
    };

    const first = await attempt(false, userPayload);
    const parsed = parseIntakeOutput(first.output);
    const issues = parsed.ok
      ? assistantMessageStyleIssues(parsed.value.assistant_message)
      : ['invalid_structure'];
    if (parsed.ok && issues.length === 0) {
      return {
        output: finalizeMessage(parsed.value),
        info: { model: first.usage.model, repaired: false, prompt },
      };
    }

    // One repair call, then accept what is acceptable.
    try {
      const second = await attempt(
        true,
        `${userPayload}\n\nYour previous reply failed these checks: ${issues.join(', ')}. Return a corrected result.`,
      );
      const again = parseIntakeOutput(second.output);
      if (again.ok) {
        env.logger.info('intake_model_repaired', { issues: issues.join(',') });
        return {
          output: finalizeMessage(again.value),
          info: { model: second.usage.model, repaired: true, prompt },
        };
      }
    } catch {
      /* fall through to the first answer when it is usable */
    }
    if (parsed.ok && assistantWordCount(parsed.value.assistant_message) <= 60) {
      env.logger.warn('intake_message_over_limit_accepted', { issues: issues.join(',') });
      return {
        output: finalizeMessage(parsed.value),
        info: { model: first.usage.model, repaired: false, prompt },
      };
    }
    throw new AvanvuError(
      'UPSTREAM_UNAVAILABLE',
      "We couldn't reach the interviewer. Your answer is saved; try again.",
    );
  }

  /** Crisis path (step 5 or 7): end the conversation, keep metadata only, never retain the text. */
  private async interrupt(
    userId: string,
    c: Claimed,
    idemReq: IdempotentRequest,
    requestId: string,
    sealer: UserSealer,
    layer: 'deterministic' | 'model',
  ): Promise<IdempotentResult> {
    const { env } = this;
    const now = env.now();
    const err = new AvanvuError('SAFETY_INTERRUPTED', 'Support is available.');
    const result: IdempotentResult = { status: 409, body: err.toBody(requestId) };
    await withUserTx(env.db, userId, async (trx) => {
      await trx
        .updateTable('app.intake_turns')
        .set({
          status: 'safety_interrupted',
          content_enc: null,
          lease_expires_at: null,
          safety_result: 'crisis',
        })
        .where('id', '=', c.athleteTurnId)
        .execute();
      await trx
        .updateTable('app.intake_conversations')
        .set({ state: 'SAFETY_INTERRUPTED', updated_at: now })
        .where('id', '=', c.conv.id)
        .execute();
      // Metadata only: no text, no profile, no model output.
      await trx
        .insertInto('app.safety_events')
        .values({
          user_id: userId,
          conversation_id: c.conv.id,
          layer,
          outcome: 'crisis',
          lexicon_version: LEXICON_VERSION,
        })
        .execute();
      await env.idem.completeInTx(trx, idemReq, result, sealer);
    });
    return result;
  }

  /** Steps 9 to 12. */
  private async commit(
    userId: string,
    c: Claimed,
    modelOutput: IntakeTurnOutput,
    info: { model: string; repaired: boolean; prompt: string } | null,
    usages: LlmResponse['usage'][],
    idemReq: IdempotentRequest,
    sealer: UserSealer,
    startedAt: Date,
  ): Promise<IdempotentResult> {
    const { env } = this;
    const now = env.now();

    // Step 9: apply allowlisted updates, recompute statuses, bump the follow-up counter.
    const applied = applyTurn(c.draft, modelOutput);
    for (const r of applied.rejected) {
      env.logger.info('intake_update_rejected', { path: r.path.slice(0, 60), op: r.op, reason: r.reason });
    }
    const profile = applied.profile;
    let fu = counters(c.conv);
    const gapMs = Math.max(0, startedAt.getTime() - c.conv.updated_at.getTime());
    const activeSeconds = c.conv.active_seconds + (gapMs <= ACTIVE_GAP_CAP_MS ? Math.round(gapMs / 1000) : 0);
    const athleteTurns = c.conv.athlete_turns + 1;
    const capMode = athleteTurns >= TURN_CAP || activeSeconds / 60 >= ACTIVE_MINUTES_CAP;

    const modelPhase = modelOutput.next_focus;
    let phase: Phase | null = modelPhase === 'wrap_up' ? null : (modelPhase as Phase);
    let targetPath: FieldPath | null = phase ? pickTargetPath(phase, profile.field_status, fu) : null;
    if (phase && !targetPath) {
      // Everything in the model's phase is resolved: steer to the next phase that still needs something.
      phase = nextPendingPhase(profile.field_status, fu, phase);
      targetPath = phase ? pickTargetPath(phase, profile.field_status, fu) : null;
    }

    // Past a cap with the minimum unmet, the interview asks only for the missing essentials, at most twice
    // each, then moves to the summary where the rest become inline "Add" rows (CONTRACTS §5).
    let capExhausted = false;
    if (capMode && generationMinimumMissing(profile, true).length > 0) {
      const askable = askableMinimumPaths(profile, fu);
      if (askable.length === 0) capExhausted = true;
      else targetPath = askable[0] as FieldPath;
    }
    fu = bumpFollowUp(fu, targetPath);

    // Step 10: termination.
    const decision = checkTermination({
      athleteTurns,
      activeMinutes: activeSeconds / 60,
      profile,
      eventReady: true,
      followUps: fu,
    });
    const ready = decision.ready || capExhausted;

    let message = modelOutput.assistant_message;
    let quick: string[];
    if (ready) {
      message = WRAP_UP_MESSAGE;
      quick = [];
    } else if (modelOutput.safety_signal === 'ambiguous') {
      quick = [];
    } else {
      quick = withStandardReplies(modelOutput.quick_replies.slice(0, 4), targetPath);
    }
    const state = ready ? 'READY_FOR_SUMMARY' : 'AWAITING_USER';
    const nextPhase = ready ? (c.conv.phase as Phase) : (phase ?? (c.conv.phase as Phase));

    const minimumMissing = generationMinimumMissing(profile, true);
    const newRevision = c.conv.revision + 1;
    const assistantId = crypto.randomUUID();
    const draftEnc = await sealer.seal(draftCtx(c.conv.id), profile);
    const assistantEnc = await sealer.seal(turnCtx(assistantId), { text: message, quick_replies: quick });

    const rowAfter: ConversationRow = {
      ...c.conv,
      state,
      phase: nextPhase,
      revision: newRevision,
      follow_up_counters: fu,
      athlete_turns: athleteTurns,
      active_seconds: activeSeconds,
    };
    const body: TurnResponse = {
      revision: newRevision,
      state,
      assistant_message: message,
      quick_replies: quick,
      progress: progressOf(profile, rowAfter, minimumMissing),
      summary_available: ready,
    };
    const result: IdempotentResult = { status: 200, body };

    // Steps 11 and 12: one short transaction. The revision compare-and-swap is the guard.
    await withUserTx(env.db, userId, async (trx) => {
      const cas = await trx
        .updateTable('app.intake_conversations')
        .set({
          state,
          phase: nextPhase,
          revision: newRevision,
          follow_up_counters: JSON.stringify(fu) as never,
          athlete_turns: athleteTurns,
          active_seconds: activeSeconds,
          updated_at: now,
        })
        .where('id', '=', c.conv.id)
        .where('revision', '=', c.conv.revision)
        .executeTakeFirst();
      if (Number(cas.numUpdatedRows) !== 1) {
        throw new AvanvuError(
          'PROFILE_REVISION_CONFLICT',
          'This interview changed on another device. Refreshing.',
        );
      }
      await trx
        .updateTable('app.intake_turns')
        .set({
          status: 'committed',
          lease_expires_at: null,
          safety_result: modelOutput.safety_signal === 'none' ? 'none' : 'ambiguous',
        })
        .where('id', '=', c.athleteTurnId)
        .execute();
      await trx
        .insertInto('app.intake_turns')
        .values({
          id: assistantId,
          user_id: userId,
          conversation_id: c.conv.id,
          seq: c.seq + 1,
          role: 'assistant',
          client_message_id: null,
          idempotency_key: null,
          status: 'committed',
          lease_expires_at: null,
          input_mode: null,
          content_enc: assistantEnc,
          safety_result: null,
          versions: JSON.stringify({
            prompt: info?.prompt ?? null,
            schema: 'intake_turn_output_v1',
            model: info?.model ?? null,
            repaired: info?.repaired ?? false,
            lexicon: LEXICON_VERSION,
          }) as never,
        } as never)
        .execute();
      await trx
        .updateTable('app.athlete_profile_drafts')
        .set({ draft_enc: draftEnc, updated_at: now })
        .where('conversation_id', '=', c.conv.id)
        .execute();
      for (const u of usages) {
        await trx
          .insertInto('app.vendor_usage')
          .values({
            user_id: userId,
            vendor: 'anthropic',
            kind: 'intake',
            model: u.model,
            tokens_in: u.tokensIn,
            tokens_out: u.tokensOut,
            characters: null,
            compute_seconds: null,
            est_cost_usd: u.estCostUsd,
          })
          .execute();
      }
      await env.idem.completeInTx(trx, idemReq, result, sealer);
    });
    return result;
  }
}

/** Missing generation-minimum fields the interview can still ask about (fewer than two asks each). */
function askableMinimumPaths(profile: AthleteProfile, fu: FollowUpCounters): FieldPath[] {
  const paths = generationMinimumMissing(profile, true).map((k) =>
    k === 'outcome.visual_or_body' ? 'outcome.visual' : k,
  );
  return paths.filter(isFieldPath).filter((p) => (fu[p] ?? 0) < 2) as FieldPath[];
}

/** Server-owned fields never reach the model (CONTRACTS §3.1). */
function stripServerOwned(p: AthleteProfile): unknown {
  const { preferences: _p, learning_stage: _l, field_status: _f, schema_version: _s, ...rest } = p;
  const sport = { label: p.sport.label, level: p.sport.level };
  return { ...rest, sport };
}

/** Deterministic cleanup of style slips and over-long messages (after the repair attempt). */
function finalizeMessage(o: IntakeTurnOutput): IntakeTurnOutput {
  let m = o.assistant_message.replaceAll('!', '.').replaceAll('—', ',').replace(/\s+/g, ' ').trim();
  const words = m.split(' ');
  if (words.length > 60) m = words.slice(0, 60).join(' ');
  return { ...o, assistant_message: m };
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LlmError('model call timed out', 'timeout')), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
