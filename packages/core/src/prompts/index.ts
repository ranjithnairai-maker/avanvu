/** Prompt registry: content hashes recorded on every AI artifact (SPEC §9.5). */
import {
  CONTEXT_SCRIPT_RULES,
  DEBRIEF_SYSTEM_PROMPT,
  ENGINE_SCRIPT_PROMPTS,
  JUDGE_SYSTEM_PROMPT,
  SCRIPT_SYSTEM_PROMPT,
} from './script';
import { INTAKE_ENGINE_HINTS, INTAKE_SYSTEM_PROMPT, PHASE_OPENINGS, WRAP_UP_MESSAGE } from './intake';

export * from './intake';
export * from './script';

async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

const PARTS = {
  intake: () => [
    INTAKE_SYSTEM_PROMPT,
    JSON.stringify(INTAKE_ENGINE_HINTS),
    JSON.stringify(PHASE_OPENINGS),
    WRAP_UP_MESSAGE,
  ],
  script: () => [
    SCRIPT_SYSTEM_PROMPT,
    JSON.stringify(ENGINE_SCRIPT_PROMPTS),
    JSON.stringify(CONTEXT_SCRIPT_RULES),
  ],
  judge: () => [JUDGE_SYSTEM_PROMPT],
  debrief: () => [DEBRIEF_SYSTEM_PROMPT],
} as const;

export type PromptKind = keyof typeof PARTS;

/** Short content hash of a prompt family, e.g. `intake:3fa9c1d20b7e`. */
export async function promptVersion(kind: PromptKind): Promise<string> {
  return `${kind}:${(await sha256Hex(PARTS[kind]().join('\n---\n'))).slice(0, 12)}`;
}
