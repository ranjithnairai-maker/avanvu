/**
 * Interview chat state (SPEC §4, CONTRACTS §4, §5). A pure reducer so the behaviour that matters is unit-tested
 * off the device: optimistic sending, keeping the athlete's text when a send fails, reusing the same client
 * message id and idempotency key on retry, revision tracking, and the safety interrupt.
 */
import type { ErrorCode } from '@avanvu/core';

export interface ChatMessage {
  id: string;
  role: 'athlete' | 'assistant';
  text: string;
  status: 'sent' | 'pending';
}

export interface Progress {
  phase: string;
  phases_complete: number;
  phases_total: number;
  minimum_met: boolean;
}

export interface PendingTurn {
  clientMessageId: string;
  idempotencyKey: string;
  content: string;
  inputMode: 'text' | 'dictation' | 'quick_reply';
}

export interface ConversationSnapshot {
  id: string;
  revision: number;
  state: string;
  turns: { seq: number; role: 'athlete' | 'assistant'; text: string }[];
  quick_replies: string[];
  progress: Progress;
  summary_available: boolean;
}

export interface ChatState {
  conversationId: string | null;
  revision: number;
  convState: string;
  messages: ChatMessage[];
  composer: string;
  sending: boolean;
  pending: PendingTurn | null;
  quickReplies: string[];
  progress: Progress | null;
  summaryAvailable: boolean;
  safetyInterrupted: boolean;
  error: { code: ErrorCode | 'NETWORK' | 'BAD_RESPONSE'; message: string; retryable: boolean } | null;
  /** Id of the assistant message that should be revealed progressively (typing effect, D-07). */
  revealing: string | null;
}

export const initialChat: ChatState = {
  conversationId: null,
  revision: 0,
  convState: 'ACTIVE',
  messages: [],
  composer: '',
  sending: false,
  pending: null,
  quickReplies: [],
  progress: null,
  summaryAvailable: false,
  safetyInterrupted: false,
  error: null,
  revealing: null,
};

export type ChatAction =
  | { type: 'hydrate'; snapshot: ConversationSnapshot }
  | { type: 'composer'; text: string }
  | { type: 'sendStart'; turn: PendingTurn }
  | {
      type: 'sendOk';
      assistantId: string;
      reply: {
        revision: number;
        state: string;
        assistant_message: string;
        quick_replies: string[];
        progress: Progress;
        summary_available: boolean;
      };
    }
  | {
      type: 'sendFail';
      error: { code: ErrorCode | 'NETWORK' | 'BAD_RESPONSE'; message: string; retryable: boolean };
    }
  | { type: 'dismissError' }
  | { type: 'revealDone' };

export function chatReducer(s: ChatState, a: ChatAction): ChatState {
  switch (a.type) {
    case 'hydrate': {
      const snap = a.snapshot;
      return {
        ...s,
        conversationId: snap.id,
        revision: snap.revision,
        convState: snap.state,
        messages: snap.turns.map((t) => ({
          id: `turn-${t.seq}`,
          role: t.role,
          text: t.text,
          status: 'sent' as const,
        })),
        quickReplies: snap.quick_replies,
        progress: snap.progress,
        summaryAvailable: snap.summary_available,
        safetyInterrupted: snap.state === 'SAFETY_INTERRUPTED',
        sending: false,
        // A pending retry survives a refetch only while the athlete has not moved on.
        pending: snap.revision === s.revision || !s.pending ? s.pending : null,
        error: null,
        revealing: null,
      };
    }
    case 'composer':
      return { ...s, composer: a.text };
    case 'sendStart': {
      if (s.sending || !a.turn.content.trim()) return s;
      return {
        ...s,
        sending: true,
        pending: a.turn,
        composer: s.composer === a.turn.content ? '' : s.composer,
        quickReplies: [],
        error: null,
        messages: [
          ...s.messages.filter((m) => m.id !== `pending-${a.turn.clientMessageId}`),
          {
            id: `pending-${a.turn.clientMessageId}`,
            role: 'athlete',
            text: a.turn.content,
            status: 'pending',
          },
        ],
      };
    }
    case 'sendOk': {
      const pendingId = s.pending ? `pending-${s.pending.clientMessageId}` : null;
      return {
        ...s,
        sending: false,
        pending: null,
        revision: a.reply.revision,
        convState: a.reply.state,
        messages: [
          ...s.messages.map((m) =>
            m.id === pendingId ? { ...m, id: `sent-${m.id}`, status: 'sent' as const } : m,
          ),
          { id: a.assistantId, role: 'assistant', text: a.reply.assistant_message, status: 'sent' },
        ],
        quickReplies: a.reply.quick_replies,
        progress: a.reply.progress,
        summaryAvailable: a.reply.summary_available,
        revealing: a.assistantId,
        error: null,
      };
    }
    case 'sendFail': {
      const interrupted = a.error.code === 'SAFETY_INTERRUPTED';
      const pendingId = s.pending ? `pending-${s.pending.clientMessageId}` : null;
      return {
        ...s,
        sending: false,
        safetyInterrupted: interrupted,
        convState: interrupted ? 'SAFETY_INTERRUPTED' : s.convState,
        // The text goes back into the composer so nothing the athlete wrote is lost (CONTRACTS §4.3 step 6).
        composer: !interrupted && s.pending && !s.composer ? s.pending.content : s.composer,
        // Keep `pending` for a retryable failure so the retry reuses the same message id and key.
        pending: a.error.retryable && !interrupted ? s.pending : null,
        messages: pendingId ? s.messages.filter((m) => m.id !== pendingId) : s.messages,
        error: interrupted ? null : a.error,
      };
    }
    case 'dismissError':
      return { ...s, error: null };
    case 'revealDone':
      return { ...s, revealing: null };
  }
}

/** Builds the turn to send: reuses the pending ids when the athlete retries the same text. */
export function nextTurn(
  s: ChatState,
  text: string,
  inputMode: PendingTurn['inputMode'],
  newId: () => string,
): PendingTurn {
  if (s.pending && s.pending.content === text) return s.pending;
  return { clientMessageId: newId(), idempotencyKey: newId(), content: text, inputMode };
}

export function canSend(s: ChatState): boolean {
  return (
    !s.sending &&
    !s.safetyInterrupted &&
    s.composer.trim().length > 0 &&
    s.composer.length <= 1000 &&
    ['ACTIVE', 'AWAITING_USER', 'RETRYABLE_ERROR'].includes(s.convState)
  );
}

/** Cumulative text at each step of a word-by-word reveal. VoiceOver is told only once it completes. */
export function revealSteps(text: string): string[] {
  const words = text.split(/(\s+)/);
  const steps: string[] = [];
  let acc = '';
  for (const w of words) {
    acc += w;
    if (w.trim()) steps.push(acc);
  }
  return steps.length > 0 ? steps : [text];
}
