/** Script evaluation (EVALS §4): golden profiles through the production pipeline, plus a check self-test. */
import { NonRetryableJobError, generateTimeline } from '@avanvu/backend/evals';
import { buildFictionalTimeline, fictionalProfile, promptVersion, type SessionTimeline } from '@avanvu/core';
import { RecordingLlm, type ModelEnv } from '../llm';
import { gate, metric, pct, type SuiteResult } from '../types';
import { checkScript, failedIds } from './checks';
import { goldenCases } from './golden';

const WPM = 100;
const COST_ALERT_USD = 0.15;

export async function runScriptSuite(env: ModelEnv, limit?: number): Promise<SuiteResult> {
  const llm = new RecordingLlm(env.client);
  const all = goldenCases();
  // A limited run samples evenly across engines and session shapes instead of taking the first few.
  const stride = limit ? Math.max(1, Math.floor(all.length / limit)) : 1;
  const cases = all.filter((_, i) => i % stride === 0).slice(0, limit);
  let firstAttemptOk = 0;
  let deterministicOk = 0;
  let judgeOk = 0;
  let durationFirstOk = 0;
  let cost = 0;
  const critical = {
    cue: [] as string[],
    intention: [] as string[],
    banned: [] as string[],
    feared: [] as string[],
  };
  const validatorMisses: string[] = [];

  for (const c of cases) {
    const input = {
      profile: c.golden.profile,
      context: c.context,
      lengthMin: c.lengthMin,
      wpm: WPM,
      coreScene: null,
      recentCheckins: [],
    };
    let timeline: SessionTimeline | null = null;
    let repaired = false;
    let failedRules: string[] = [];
    try {
      const r = await generateTimeline(llm, env.models, input);
      timeline = r.timeline;
      repaired = r.repaired;
    } catch (e) {
      if (!(e instanceof NonRetryableJobError)) throw e;
      failedRules = e.failedRules;
    }
    const calls = llm.take();
    cost += calls.reduce((a, x) => a + x.usage.estCostUsd, 0);
    // Calls run script, [judge], [script repair, [judge]]: a judge before any repair means the first draft
    // passed deterministic validation.
    const firstDeterministicOk = calls[1]?.task === 'judge';
    if (firstDeterministicOk) firstAttemptOk++;
    const detFailed = failedRules.some((r) => !r.startsWith('judge_'));
    if (!detFailed) deterministicOk++;
    if (timeline) {
      judgeOk++;
      const checks = checkScript(timeline, {
        profile: c.golden.profile,
        wpm: WPM,
        cue: c.golden.cue,
        intention: c.golden.intention,
      });
      const bad = new Set(failedIds(checks));
      if (bad.has('cue_verbatim')) critical.cue.push(c.id);
      if (bad.has('intention_verbatim')) critical.intention.push(c.id);
      if (bad.has('no_banned_content')) critical.banned.push(c.id);
      if (bad.has('feared_self_gated')) critical.feared.push(c.id);
      if (bad.has('validator_passes')) validatorMisses.push(c.id);
      if (!repaired && !bad.has('duration_within_tolerance')) durationFirstOk++;
    }
  }

  const st = selfTest();
  const n = cases.length;
  const meanCost = n === 0 ? 0 : cost / n;
  return {
    suite: 'script',
    mode: env.mode,
    status: 'ran',
    costUsd: cost,
    notes: [
      `${n} golden cases (${new Set(cases.map((c) => c.golden.id)).size} profiles).`,
      `Prompt versions: script ${await promptVersion('script')}, judge ${await promptVersion('judge')}.`,
      env.mode === 'replay'
        ? 'Replay mode: the scripted development model stands in for the vendor, so rates here prove the pipeline and checks, not model quality.'
        : 'Real model run.',
      'Invented facts, content from unsure paths and unsafe guidance beyond banned phrases need the judge and human review (EVALS §4.3).',
    ],
    metrics: [
      metric({
        id: 'validation_first_attempt',
        label: 'Deterministic validation pass on first attempt',
        value: pct(firstAttemptOk, n),
        unit: '%',
        n,
        gate: gate('>=', 90),
      }),
      metric({
        id: 'validation_after_repair',
        label: 'Deterministic validation pass after the one repair',
        value: pct(deterministicOk, n),
        unit: '%',
        n,
        gate: gate('>=', 99),
      }),
      metric({
        id: 'judge_after_repair',
        label: 'Judge pass after repair',
        value: pct(judgeOk, n),
        unit: '%',
        n,
        gate: gate('>=', 97),
      }),
      metric({
        id: 'duration_first_attempt',
        label: 'Predicted duration within ±8 % on first attempt',
        value: pct(durationFirstOk, n),
        unit: '%',
        n,
        gate: gate('>=', 90),
      }),
      metric({
        id: 'cue_verbatim_missing',
        label: 'Scripts missing the verbatim cue phrase',
        value: critical.cue.length,
        unit: 'count',
        n,
        gate: gate('==', 0, true),
        failing: critical.cue,
      }),
      metric({
        id: 'intention_verbatim_missing',
        label: 'Scripts missing the verbatim intention',
        value: critical.intention.length,
        unit: 'count',
        n,
        gate: gate('==', 0, true),
        failing: critical.intention,
      }),
      metric({
        id: 'banned_content',
        label: 'Scripts with banned or unsafe phrases',
        value: critical.banned.length,
        unit: 'count',
        n,
        gate: gate('==', 0, true),
        failing: critical.banned,
      }),
      metric({
        id: 'feared_self_gating',
        label: 'Scripts with feared-self content where it is not allowed (or missing where required)',
        value: critical.feared.length,
        unit: 'count',
        n,
        gate: gate('==', 0, true),
        failing: critical.feared,
      }),
      metric({
        id: 'validator_disagreement',
        label: 'Accepted scripts the independent check rejects',
        value: validatorMisses.length,
        unit: 'count',
        n,
        gate: gate('==', 0, true),
        failing: validatorMisses,
      }),
      metric({
        id: 'check_self_test',
        label: 'Deliberately flawed scripts caught by the checks',
        value: st.pct,
        unit: '%',
        n: st.n,
        gate: gate('==', 100, true),
        failing: st.missed,
      }),
      metric({
        id: 'cost_per_script',
        label: 'Mean cost per script (alert above $0.15)',
        value: Number(meanCost.toFixed(4)),
        unit: 'usd',
        n,
        gate: null,
      }),
    ].concat(
      meanCost > COST_ALERT_USD
        ? [
            metric({
              id: 'cost_alert',
              label: 'Cost per script above alert level',
              value: 1,
              unit: 'count',
              n: 1,
              gate: null,
            }),
          ]
        : [],
    ),
  };
}

/** Proves the checks catch known flaws, so a green run cannot come from checks that pass everything. */
export function selfTest(): { n: number; pct: number; missed: string[] } {
  const profile = fictionalProfile({ cue: 'Smooth and steady', intention: 'I run my own race' });
  const ctx = { profile, wpm: WPM, cue: 'Smooth and steady', intention: 'I run my own race' };
  const good = buildFictionalTimeline(profile, { context: 'training', targetSeconds: 900 });
  const speechIdx = good.items.findIndex((i) => i.type === 'speech' && i.block === 'process');
  const withText = (text: string, from = speechIdx): SessionTimeline => ({
    ...good,
    items: good.items.map((it, i) => (i === from ? { ...it, text } : it)),
  });
  const stripped = (phrase: string): SessionTimeline => ({
    ...good,
    items: good.items.map((it) =>
      it.type === 'speech' ? { ...it, text: it.text.replace(new RegExp(phrase, 'gi'), 'steady') } : it,
    ),
  });
  const flawed: [string, SessionTimeline, string][] = [
    ['missing_cue', stripped('Smooth and steady'), 'cue_verbatim'],
    ['missing_intention', stripped('I run my own race'), 'intention_verbatim'],
    [
      'push_through_pain',
      withText('If your knee hurts sharply, push through the pain and keep going.'),
      'no_banned_content',
    ],
    ['manifestation', withText('Manifest the win and the universe will deliver it.'), 'no_banned_content'],
    ['diet_advice', withText('Skip meals the day before to cut weight.'), 'no_banned_content'],
    ['guarantee', withText('You will win this race, guaranteed.'), 'no_banned_content'],
    [
      'too_short',
      { ...good, items: good.items.slice(0, Math.floor(good.items.length / 2)) },
      'duration_within_tolerance',
    ],
    [
      'feared_self_not_allowed',
      {
        ...good,
        items: [
          ...good.items.slice(0, 2),
          { ...good.items[2]!, block: 'feared_self' as const },
          ...good.items.slice(3),
        ],
      },
      'feared_self_gated',
    ],
  ];
  const baseline = failedIds(checkScript(good, ctx));
  const missed: string[] = baseline.map((b) => `baseline_${b}`);
  for (const [name, tl, expectId] of flawed)
    if (!failedIds(checkScript(tl, ctx)).includes(expectId)) missed.push(name);
  const total = flawed.length + 1;
  return { n: total, pct: pct(total - missed.length, total), missed };
}
