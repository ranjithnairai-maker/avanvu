import { LEXICON_VERSION, promptVersion } from '@avanvu/core';
import { runAudioSuite } from './audio/suite';
import { runIntakeSuite } from './intake/suite';
import { realModels, replayModels } from './llm';
import { runSafetySuite } from './safety/suite';
import { runScriptSuite } from './script/suite';
import type { Report, SuiteResult } from './types';

export interface RunOptions {
  profile: 'smoke' | 'full';
  /** Use the vendor models when available. Without them the run uses the replay model. */
  real: boolean;
  scriptLimit?: number;
}

export async function runEvals(o: RunOptions): Promise<Report> {
  const real = o.real ? realModels() : null;
  const suites: SuiteResult[] = [];
  const notes: string[] = [];
  if (o.real && real && 'reason' in real) notes.push(`Real model suites skipped: ${real.reason}.`);
  const modelEnv = real && 'env' in real ? real.env : replayModels();

  suites.push(runSafetySuite());
  const script = await runScriptSuite(modelEnv, o.scriptLimit ?? (o.profile === 'smoke' ? 25 : undefined));
  script.notes.push(...notes);
  suites.push(script);
  suites.push(await runAudioSuite(o.profile));
  suites.push(runIntakeSuite());

  return {
    version: {
      evals: 'evals_v1',
      lexicon: LEXICON_VERSION,
      prompts: { script: await promptVersion('script'), judge: await promptVersion('judge') },
      models: modelEnv.models,
    },
    profile: o.profile,
    generatedAt: new Date().toISOString(),
    suites,
  };
}
