/* eslint-disable no-console -- the eval CLI prints its own report; it never handles athlete data. */
/**
 * pnpm eval:smoke | pnpm eval:full [--real] [--write-report]
 *
 * Without vendor keys the model-backed suites run in replay mode and say so. Exit code 1 when a gate fails,
 * a critical check fails, or a metric regresses more than 2 points against the last committed report.
 */
import { resolve } from 'node:path';
import { readBaseline, regressionsAgainst, suiteCost, toMarkdown, writeReport, writeResults } from './report';
import { runEvals } from './run';
import { verdict } from './types';

const repoRoot = resolve(import.meta.dirname, '../../..');

async function main() {
  const [profile, ...flags] = process.argv.slice(2);
  if (profile !== 'smoke' && profile !== 'full') {
    console.error('usage: eval smoke|full [--real] [--write-report]');
    process.exit(2);
  }
  const real = flags.includes('--real');
  const budget = Number(process.env.EVAL_BUDGET_USD ?? (profile === 'smoke' ? 3 : 40));

  const report = await runEvals({ profile, real });
  const reportsDir = resolve(repoRoot, 'docs/eval-reports');
  const regressions = regressionsAgainst(report, readBaseline(reportsDir, profile));
  const cost = suiteCost(report.suites);

  console.log(toMarkdown(report, regressions));
  console.log(`Cost: $${cost.toFixed(4)} of $${budget} budget.`);
  const file = writeResults(resolve(repoRoot, 'eval-results'), report);
  console.log(`Results: ${file}`);
  if (flags.includes('--write-report')) writeReport(reportsDir, report, regressions);

  const v = verdict(report);
  const overBudget = cost > budget;
  if (!v.ok || regressions.length > 0 || overBudget) {
    if (overBudget) console.error('Over budget.');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
