/** Result shapes shared by every suite (EVALS §2). Nothing here carries athlete text; fixtures are fictional. */

export type GateOp = '>=' | '<=' | '==';

export interface Gate {
  op: GateOp;
  threshold: number;
  /** A failing critical check blocks promotion regardless of averages (EVALS §1). */
  critical: boolean;
}

export interface Metric {
  id: string;
  label: string;
  value: number;
  unit: '%' | 'count' | 's' | 'usd' | 'LU' | 'dB';
  /** Number of items the value was computed over. */
  n: number;
  gate: Gate | null;
  /** null when the metric is report-only. */
  passed: boolean | null;
  /** Ids of failing items, to find them; never text. */
  failing?: string[];
}

export type SuiteName = 'safety' | 'script' | 'audio' | 'intake';
export type RunMode = 'replay' | 'real';

export interface SuiteResult {
  suite: SuiteName;
  /** replay: scripted or recorded model; real: vendor calls. */
  mode: RunMode;
  status: 'ran' | 'skipped';
  skipReason?: string;
  metrics: Metric[];
  costUsd: number;
  notes: string[];
}

export interface Versions {
  evals: 'evals_v1';
  lexicon: string;
  prompts: Record<string, string>;
  models: Record<string, string>;
}

export interface Report {
  version: Versions;
  profile: 'smoke' | 'full';
  generatedAt: string;
  suites: SuiteResult[];
}

export const gate = (op: GateOp, threshold: number, critical = false): Gate => ({ op, threshold, critical });

export function passes(value: number, g: Gate): boolean {
  switch (g.op) {
    case '>=':
      return value >= g.threshold - 1e-9;
    case '<=':
      return value <= g.threshold + 1e-9;
    case '==':
      return Math.abs(value - g.threshold) < 1e-9;
  }
}

export function metric(m: Omit<Metric, 'passed' | 'gate'> & { gate?: Gate | null }): Metric {
  const g = m.gate ?? null;
  return { ...m, gate: g, passed: g ? passes(m.value, g) : null };
}

export const pct = (num: number, den: number): number => (den === 0 ? 100 : (100 * num) / den);

export function skipped(suite: SuiteName, reason: string): SuiteResult {
  return { suite, mode: 'real', status: 'skipped', skipReason: reason, metrics: [], costUsd: 0, notes: [] };
}

export interface Verdict {
  ok: boolean;
  failedCritical: string[];
  failedGates: string[];
}

export function verdict(report: Report): Verdict {
  const failedCritical: string[] = [];
  const failedGates: string[] = [];
  for (const s of report.suites)
    for (const m of s.metrics)
      if (m.passed === false) (m.gate?.critical ? failedCritical : failedGates).push(`${s.suite}.${m.id}`);
  return { ok: failedCritical.length === 0 && failedGates.length === 0, failedCritical, failedGates };
}
