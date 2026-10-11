/**
 * The slice of the backend that `packages/evals` runs against, so evaluations use the same code paths as
 * production (EVALS §1): the script pipeline, the LLM port and the renderer.
 */
export { DevLlm } from './dev/devLlm';
export { NonRetryableJobError, generateTimeline } from './domain/generate';
export type { GenerateInput, GenerateResult } from './domain/generate';
export { FakeLlm, LlmError } from './ports/llm';
export type { LlmClient, LlmRequest, LlmResponse, LlmUsage } from './ports/llm';
export { MemoryStorage } from './ports/storage';
export { LOUDNESS_TARGET } from './render/ffmpeg';
export { Renderer } from './render/renderer';
export type { RenderOutput } from './render/renderer';
export type { Pcm } from './render/wav';
