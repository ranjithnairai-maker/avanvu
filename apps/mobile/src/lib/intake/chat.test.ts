import { describe, expect, it } from 'vitest';
import {
  canSend,
  chatReducer,
  initialChat,
  nextTurn,
  revealSteps,
  type ChatState,
  type ConversationSnapshot,
} from './chat';

const snap = (over: Partial<ConversationSnapshot> = {}): ConversationSnapshot => ({
  id: 'c1',
  revision: 0,
  state: 'AWAITING_USER',
  turns: [{ seq: 1, role: 'assistant', text: 'What would make this a success?' }],
  quick_replies: [],
  progress: { phase: 'objective', phases_complete: 0, phases_total: 9, minimum_met: false },
  summary_available: false,
  ...over,
});
const hydrated = (): ChatState => chatReducer(initialChat, { type: 'hydrate', snapshot: snap() });
const ids = (() => {
  let n = 0;
  return () => `id-${++n}`;
})();

describe('chat reducer', () => {
  it('hydrates from the server and exposes the latest revision', () => {
    const s = hydrated();
    expect(s).toMatchObject({
      conversationId: 'c1',
      revision: 0,
      convState: 'AWAITING_USER',
      safetyInterrupted: false,
    });
    expect(s.messages).toHaveLength(1);
  });

  it('sends optimistically and clears the composer', () => {
    let s = chatReducer(hydrated(), { type: 'composer', text: 'I want to stay steady' });
    expect(canSend(s)).toBe(true);
    const turn = nextTurn(s, 'I want to stay steady', 'text', ids);
    s = chatReducer(s, { type: 'sendStart', turn });
    expect(s.sending).toBe(true);
    expect(s.composer).toBe('');
    expect(s.messages.at(-1)).toMatchObject({
      role: 'athlete',
      status: 'pending',
      text: 'I want to stay steady',
    });
    expect(canSend(s)).toBe(false);
  });

  it('commits the reply, advances the revision and reveals the assistant message', () => {
    let s = chatReducer(hydrated(), { type: 'composer', text: 'hello there friend' });
    s = chatReducer(s, { type: 'sendStart', turn: nextTurn(s, 'hello there friend', 'text', ids) });
    s = chatReducer(s, {
      type: 'sendOk',
      assistantId: 'a-1',
      reply: {
        revision: 1,
        state: 'AWAITING_USER',
        assistant_message: 'Tell me more.',
        quick_replies: ['Body', 'Not sure'],
        progress: { phase: 'objective', phases_complete: 1, phases_total: 9, minimum_met: false },
        summary_available: false,
      },
    });
    expect(s).toMatchObject({
      revision: 1,
      sending: false,
      pending: null,
      quickReplies: ['Body', 'Not sure'],
      revealing: 'a-1',
    });
    expect(s.messages.map((m) => [m.role, m.status])).toEqual([
      ['assistant', 'sent'],
      ['athlete', 'sent'],
      ['assistant', 'sent'],
    ]);
  });

  it('puts the athlete text back in the composer on a retryable failure and reuses ids on retry', () => {
    let s = chatReducer(hydrated(), { type: 'composer', text: 'a thoughtful answer' });
    const first = nextTurn(s, 'a thoughtful answer', 'text', ids);
    s = chatReducer(s, { type: 'sendStart', turn: first });
    s = chatReducer(s, {
      type: 'sendFail',
      error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Try again.', retryable: true },
    });
    expect(s.composer).toBe('a thoughtful answer');
    expect(s.sending).toBe(false);
    expect(s.messages.some((m) => m.status === 'pending')).toBe(false);
    expect(s.error).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    expect(s.pending).toEqual(first);
    // Retrying the same text reuses the message id and idempotency key (one model call, one committed turn).
    const retry = nextTurn(s, 'a thoughtful answer', 'text', ids);
    expect(retry).toEqual(first);
    // Editing the text starts a new turn.
    expect(nextTurn(s, 'edited answer', 'text', ids).clientMessageId).not.toBe(first.clientMessageId);
  });

  it('does not overwrite what the athlete typed meanwhile when restoring text', () => {
    let s = chatReducer(hydrated(), { type: 'composer', text: 'first' });
    s = chatReducer(s, { type: 'sendStart', turn: nextTurn(s, 'first', 'text', ids) });
    s = chatReducer(s, { type: 'composer', text: 'typing something new' });
    s = chatReducer(s, {
      type: 'sendFail',
      error: { code: 'NETWORK', message: 'Offline.', retryable: true },
    });
    expect(s.composer).toBe('typing something new');
  });

  it('shows the safety screen and stops on SAFETY_INTERRUPTED without restoring the text', () => {
    let s = chatReducer(hydrated(), { type: 'composer', text: 'private words' });
    s = chatReducer(s, { type: 'sendStart', turn: nextTurn(s, 'private words', 'text', ids) });
    s = chatReducer(s, {
      type: 'sendFail',
      error: { code: 'SAFETY_INTERRUPTED', message: 'x', retryable: false },
    });
    expect(s).toMatchObject({
      safetyInterrupted: true,
      convState: 'SAFETY_INTERRUPTED',
      composer: '',
      error: null,
      pending: null,
    });
    s = chatReducer(s, { type: 'composer', text: 'hello again' });
    expect(canSend(s)).toBe(false);
  });

  it('refetching after a conflict resets to the committed state', () => {
    let s = hydrated();
    s = chatReducer(s, { type: 'composer', text: 'answer' });
    s = chatReducer(s, { type: 'sendStart', turn: nextTurn(s, 'answer', 'text', ids) });
    s = chatReducer(s, {
      type: 'sendFail',
      error: { code: 'PROFILE_REVISION_CONFLICT', message: 'x', retryable: false },
    });
    s = chatReducer(s, {
      type: 'hydrate',
      snapshot: snap({
        revision: 3,
        turns: [
          { seq: 1, role: 'assistant', text: 'q' },
          { seq: 2, role: 'athlete', text: 'a' },
          { seq: 3, role: 'assistant', text: 'q2' },
        ],
      }),
    });
    expect(s).toMatchObject({ revision: 3, sending: false, error: null });
    expect(s.messages).toHaveLength(3);
  });

  it('enforces the send limits', () => {
    let s = hydrated();
    expect(canSend(s)).toBe(false); // empty
    s = chatReducer(s, { type: 'composer', text: 'x'.repeat(1001) });
    expect(canSend(s)).toBe(false); // over 1,000 characters
    s = chatReducer(s, { type: 'composer', text: 'ok' });
    expect(canSend({ ...s, convState: 'PAUSED' })).toBe(false);
    expect(canSend({ ...s, convState: 'READY_FOR_SUMMARY' })).toBe(false);
  });

  it('ignores a second send while one is in flight', () => {
    let s = chatReducer(hydrated(), { type: 'composer', text: 'one' });
    s = chatReducer(s, { type: 'sendStart', turn: nextTurn(s, 'one', 'text', ids) });
    const again = chatReducer(s, { type: 'sendStart', turn: nextTurn(s, 'two', 'text', ids) });
    expect(again).toBe(s);
  });
});

describe('typing reveal', () => {
  it('reveals word by word and ends with the full message', () => {
    const steps = revealSteps('Where does it get hard?');
    expect(steps).toEqual([
      'Where',
      'Where does',
      'Where does it',
      'Where does it get',
      'Where does it get hard?',
    ]);
    expect(revealSteps('')).toEqual(['']);
  });
});
