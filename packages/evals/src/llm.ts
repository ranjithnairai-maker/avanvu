/**
 * Model access for evaluations. Replay mode uses the development model that renders the fictional timeline for
 * the requested profile, so the pipeline, validators and checks are exercised without vendor calls. Real mode
 * needs the Anthropic adapter, which is a placeholder until keys and model configuration exist (CLAUDE.md).
 */
import {
  DevLlm,
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
  type LlmUsage,
} from '@avanvu/backend/evals';
import type { RunMode } from './types';

export interface ModelEnv {
  mode: RunMode;
  client: LlmClient;
  models: { script: string; judge: string; effort: string };
}

export const replayModels = (): ModelEnv => ({
  mode: 'replay',
  client: new DevLlm(),
  models: { script: 'replay', judge: 'replay', effort: 'none' },
});

/** null with a reason when real vendor calls are not possible yet. */
export function realModels(env: NodeJS.ProcessEnv = process.env): { env: ModelEnv } | { reason: string } {
  if (!env.ANTHROPIC_API_KEY) return { reason: 'ANTHROPIC_API_KEY is not set' };
  return {
    reason: 'the Anthropic adapter is not implemented yet (placeholder until keys and models are configured)',
  };
}

export interface RecordedCall {
  task: LlmRequest['task'];
  repair: boolean;
  usage: LlmUsage;
}

/** Records the order and cost of calls without keeping any prompt or output text. */
export class RecordingLlm implements LlmClient {
  calls: RecordedCall[] = [];
  constructor(private readonly inner: LlmClient) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const r = await this.inner.complete(req);
    this.calls.push({ task: req.task, repair: req.repair, usage: r.usage });
    return r;
  }
  take(): RecordedCall[] {
    const c = this.calls;
    this.calls = [];
    return c;
  }
}
