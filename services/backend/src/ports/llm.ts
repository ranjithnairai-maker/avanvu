/**
 * Language-model port. The adapters call the vendor; everything else (prompts, schemas, validation, repair,
 * safety) lives in core and the domain services, so a vendor or model change touches one file. The real
 * Anthropic adapter is an external-API integration and is a placeholder until keys exist (CLAUDE.md).
 */
import { AvanvuError } from '@avanvu/core';

export type LlmTask = 'intake' | 'script' | 'judge' | 'debrief';

export interface LlmRequest {
  task: LlmTask;
  systemPrompt: string;
  userPayload: string;
  /** JSON Schema for structured outputs (`output_config.format`, type `json_schema`). */
  jsonSchema: Record<string, unknown>;
  timeoutMs: number;
  /** True on the single repair call. */
  repair: boolean;
  /** Optional abort from the caller (for example a request disconnect). */
  signal?: AbortSignal;
}

export interface LlmUsage {
  model: string;
  tokensIn: number;
  tokensOut: number;
  estCostUsd: number;
}

export interface LlmResponse {
  /** Parsed JSON, still untrusted: callers validate it with Zod. */
  output: unknown;
  usage: LlmUsage;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind: 'timeout' | 'unavailable' | 'rejected',
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/** Placeholder until ANTHROPIC_API_KEY and the model configuration are provided. */
export class UnconfiguredLlm implements LlmClient {
  complete(): Promise<never> {
    return Promise.reject(
      new AvanvuError('UPSTREAM_UNAVAILABLE', 'The language model is not configured yet.'),
    );
  }
}

type Scripted = unknown | Error | ((req: LlmRequest) => unknown | Promise<unknown>);

/** Scripted fake for tests and local development: responses are consumed in order per task. */
export class FakeLlm implements LlmClient {
  readonly calls: LlmRequest[] = [];
  private readonly queues = new Map<LlmTask, Scripted[]>();
  private readonly fallbacks = new Map<LlmTask, (req: LlmRequest) => unknown>();

  /** Queue a response for the next call of a task. An Error is thrown; a function is invoked. */
  enqueue(task: LlmTask, ...responses: Scripted[]): this {
    this.queues.set(task, [...(this.queues.get(task) ?? []), ...responses]);
    return this;
  }

  /** Used when the queue for a task is empty. */
  fallback(task: LlmTask, fn: (req: LlmRequest) => unknown): this {
    this.fallbacks.set(task, fn);
    return this;
  }

  /** Forget queued responses, fallbacks and recorded calls. */
  reset(): void {
    this.calls.length = 0;
    this.queues.clear();
    this.fallbacks.clear();
  }

  callsFor(task: LlmTask): LlmRequest[] {
    return this.calls.filter((c) => c.task === task);
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(req);
    const next = this.queues.get(req.task)?.shift();
    const chosen = next !== undefined ? next : this.fallbacks.get(req.task);
    if (chosen === undefined) throw new LlmError(`no scripted response for ${req.task}`, 'unavailable');
    if (chosen instanceof Error) throw chosen;
    const output = typeof chosen === 'function' ? await (chosen as (r: LlmRequest) => unknown)(req) : chosen;
    if (output instanceof Error) throw output;
    return { output, usage: { model: 'fake-model', tokensIn: 1000, tokensOut: 300, estCostUsd: 0.01 } };
  }
}
