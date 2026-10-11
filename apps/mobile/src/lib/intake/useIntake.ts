import * as Crypto from 'expo-crypto';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import {
  canSend,
  chatReducer,
  initialChat,
  nextTurn,
  type ConversationSnapshot,
  type PendingTurn,
} from './chat';

interface Reply {
  revision: number;
  state: string;
  assistant_message: string;
  quick_replies: string[];
  progress: ConversationSnapshot['progress'];
  summary_available: boolean;
}

/**
 * Drives one interview: loads or starts the conversation, sends turns with a stable idempotency key per message
 * (so a retry never double-spends a model call), keeps the athlete's text on failure, and refetches on a conflict.
 */
export function useIntake(params: { id?: string | undefined; event?: string | undefined }) {
  const [state, dispatch] = useReducer(chatReducer, initialChat);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const startKey = useRef(Crypto.randomUUID());
  const stateRef = useRef(state);
  stateRef.current = state;

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const snap = params.id
        ? await api.get<ConversationSnapshot>(`/v1/intake/conversations/${params.id}`)
        : await api.post<ConversationSnapshot>(
            '/v1/intake/conversations',
            { event_id: params.event },
            { idempotencyKey: startKey.current },
          );
      dispatch({ type: 'hydrate', snapshot: snap });
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
    } finally {
      setLoading(false);
    }
  }, [params.id, params.event]);

  useEffect(() => {
    void load();
  }, [load]);

  const send = useCallback(
    async (text: string, mode: PendingTurn['inputMode'] = 'text') => {
      const s = stateRef.current;
      if (!s.conversationId || !text.trim()) return;
      const turn = nextTurn(s, text, mode, () => Crypto.randomUUID());
      dispatch({ type: 'sendStart', turn });
      try {
        const reply = await api.post<Reply>(
          '/v1/intake/turns',
          {
            conversation_id: s.conversationId,
            client_message_id: turn.clientMessageId,
            expected_revision: s.revision,
            input_mode: turn.inputMode,
            content: turn.content,
          },
          { idempotencyKey: turn.idempotencyKey },
        );
        dispatch({ type: 'sendOk', assistantId: `assistant-${reply.revision}`, reply });
      } catch (e) {
        const err =
          e instanceof ApiError
            ? e
            : new ApiError('NETWORK', "We couldn't reach Avanvu. Your answer is saved in the box.", 0, true);
        dispatch({
          type: 'sendFail',
          error: { code: err.code, message: err.message, retryable: err.retryable },
        });
        if (err.code === 'PROFILE_REVISION_CONFLICT' || err.code === 'TURN_IN_PROGRESS') {
          // Another device (or an earlier attempt) moved the interview on: show the committed state.
          setTimeout(() => void load(), err.retryAfterMs ?? 0);
        }
      }
    },
    [load],
  );

  const pause = useCallback(async () => {
    if (!stateRef.current.conversationId) return;
    await api.post(`/v1/intake/conversations/${stateRef.current.conversationId}/pause`);
  }, []);

  const resume = useCallback(async () => {
    if (!stateRef.current.conversationId) return;
    await api.post(`/v1/intake/conversations/${stateRef.current.conversationId}/resume`);
    await load();
  }, [load]);

  return { state, dispatch, loading, loadError, reload: load, send, pause, resume, canSend: canSend(state) };
}
