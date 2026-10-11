/** Reports (EVALS §2): machine-readable results, a markdown summary, and the regression check. */
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { REDTEAM_VERSION } from './safety/redteam';
import { verdict, type Metric, type Report, type SuiteResult } from './types';

export const REGRESSION_POINTS = 2;

const fmt = (m: Metric) =>
  `${m.unit === 'usd' ? '$' : ''}${Number.isInteger(m.value) ? m.value : m.value.toFixed(2)}${m.unit === '%' ? ' %' : m.unit === 'usd' || m.unit === 'count' ? '' : ` ${m.unit}`}`;
const gateText = (m: Metric) =>
  m.gate
    ? `${m.gate.op} ${m.gate.threshold}${m.unit === '%' ? ' %' : ''}${m.gate.critical ? ' (critical)' : ''}`
    : 'report';
const mark = (m: Metric) => (m.passed === null ? '-' : m.passed ? 'pass' : 'FAIL');

export function toMarkdown(r: Report, regressions: string[] = []): string {
  const v = verdict(r);
  const lines = [
    `# Eval report: ${r.profile}`,
    '',
    `Generated ${r.generatedAt}. ${v.ok && regressions.length === 0 ? 'All gates pass.' : 'Gates failing.'}`,
    '',
    `Versions: ${r.version.evals}, lexicon ${r.version.lexicon}, red-team ${REDTEAM_VERSION}, prompts ${Object.entries(
      r.version.prompts,
    )
      .map(([k, x]) => `${k} ${x}`)
      .join(', ')}, models ${Object.entries(r.version.models)
      .map(([k, x]) => `${k} ${x}`)
      .join(', ')}.`,
    '',
  ];
  for (const s of r.suites) {
    lines.push(`## ${s.suite} (${s.mode})`, '');
    if (s.status === 'skipped') {
      lines.push(`Skipped: ${s.skipReason ?? ''}`, '');
      continue;
    }
    lines.push('| Metric | Value | n | Gate | Result |', '| --- | --- | --- | --- | --- |');
    for (const m of s.metrics)
      lines.push(`| ${m.label} | ${fmt(m)} | ${m.n} | ${gateText(m)} | ${mark(m)} |`);
    lines.push('');
    for (const n of s.notes) lines.push(`- ${n}`);
    lines.push('');
  }
  if (v.failedCritical.length) lines.push(`Critical failures: ${v.failedCritical.join(', ')}`, '');
  if (regressions.length)
    lines.push(`Regressions over ${REGRESSION_POINTS} points: ${regressions.join(', ')}`, '');
  return lines.join('\n');
}

/** Metrics that moved the wrong way by more than 2 points against the last committed report. */
export function regressionsAgainst(current: Report, baseline: Report | null): string[] {
  if (!baseline) return [];
  const out: string[] = [];
  for (const s of current.suites) {
    const b = baseline.suites.find((x) => x.suite === s.suite);
    if (!b || b.status !== 'ran' || s.status !== 'ran' || b.mode !== s.mode) continue;
    for (const m of s.metrics) {
      const bm = b.metrics.find((x) => x.id === m.id);
      if (!bm || m.unit !== '%' || !m.gate) continue;
      const worse = m.gate.op === '<=' ? m.value - bm.value : bm.value - m.value;
      if (worse > REGRESSION_POINTS)
        out.push(`${s.suite}.${m.id} (${bm.value.toFixed(1)} to ${m.value.toFixed(1)})`);
    }
  }
  return out;
}

export function readBaseline(dir: string, profile: string): Report | null {
  const p = join(dir, `baseline-${profile}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as Report;
}

export function writeResults(dir: string, r: Report): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${r.profile}-${r.generatedAt.replace(/[:.]/g, '-')}.json`);
  writeFileSync(p, JSON.stringify(r, null, 2) + '\n');
  return p;
}

/** Commit-ready summary and the baseline the next run is compared against. */
export function writeReport(dir: string, r: Report, regressions: string[]): void {
  mkdirSync(dir, { recursive: true });
  const day = r.generatedAt.slice(0, 10);
  writeFileSync(join(dir, `${day}-${r.profile}.md`), toMarkdown(r, regressions));
  writeFileSync(join(dir, `baseline-${r.profile}.json`), JSON.stringify(r, null, 2) + '\n');
}

export const suiteCost = (suites: SuiteResult[]) => suites.reduce((a, s) => a + s.costUsd, 0);
export { dirname };
