/**
 * Push port (SPEC §9.6). Server push is used only for: session ready, offline-readiness nudges and export
 * ready. Every push goes through app.notification_deliveries with a unique (user, kind, subject) key so it is
 * sent at most once. The Expo push adapter is an external-API integration (placeholder until the access
 * token exists). Message copy is fixed and contains no athlete text.
 */
export type PushKind =
  'session_ready' | 'offline_nudge_48h' | 'offline_nudge_24h' | 'export_ready' | 'generation_blocked';

export interface PushMessage {
  token: string;
  kind: PushKind;
  title: string;
  body: string;
  /** Ids only, for deep linking. */
  data: Record<string, string>;
}

export interface PushResult {
  ok: boolean;
  /** The token is no longer valid and should be deleted. */
  invalidToken: boolean;
}

export interface PushClient {
  send(message: PushMessage): Promise<PushResult>;
}

export class UnconfiguredPush implements PushClient {
  async send(): Promise<PushResult> {
    return { ok: false, invalidToken: false };
  }
}

export class FakePush implements PushClient {
  readonly sent: PushMessage[] = [];
  invalidTokens = new Set<string>();
  fail = false;

  async send(message: PushMessage): Promise<PushResult> {
    if (this.fail) return { ok: false, invalidToken: false };
    if (this.invalidTokens.has(message.token)) return { ok: false, invalidToken: true };
    this.sent.push(message);
    return { ok: true, invalidToken: false };
  }
}

export const PUSH_COPY: Record<PushKind, { title: string; body: string }> = {
  session_ready: { title: 'Your session is ready', body: 'Open Avanvu to listen.' },
  offline_nudge_48h: { title: 'Save your race-day sessions', body: 'Open Avanvu to save them for offline.' },
  offline_nudge_24h: { title: 'Save your race-day sessions', body: 'Open Avanvu to save them for offline.' },
  export_ready: { title: 'Your export is ready', body: 'Open Avanvu to download it.' },
  generation_blocked: {
    title: 'We could not create your session',
    body: 'Open Avanvu to see what to do next.',
  },
};
