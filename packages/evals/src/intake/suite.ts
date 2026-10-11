import { skipped, type SuiteResult } from '../types';

/**
 * Simulated-athlete intake evaluation (EVALS §3.2) needs a real athlete-simulator model and the real
 * interviewer, so it only runs in a real run. The deterministic intake tests (§3.1) run in the backend suite.
 */
export function runIntakeSuite(): SuiteResult {
  return skipped(
    'intake',
    'simulated athletes need the real model (Anthropic adapter not configured); deterministic intake tests run in the backend suite',
  );
}
