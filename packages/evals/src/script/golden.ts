/**
 * Golden fictional profiles (EVALS §4.1): three per engine plus edge profiles, each rendered as the five
 * session shapes the product offers. All data is fictional.
 */
import {
  SESSION_LENGTHS,
  SPORTS,
  fictionalProfile,
  type AthleteProfile,
  type Engine,
  type SessionContext,
} from '@avanvu/core';

export interface GoldenProfile {
  id: string;
  profile: AthleteProfile;
  /** The cue and intention the script must carry verbatim. */
  cue: string;
  intention: string;
}

export interface GoldenCase {
  id: string;
  golden: GoldenProfile;
  context: SessionContext;
  lengthMin: number;
}

const ENGINES: Engine[] = [
  'endurance_v1',
  'field_court_team_v1',
  'bat_ball_team_v1',
  'closed_skill_v1',
  'opponent_rally_v1',
];

const CUES = ['Smooth and steady', 'Quiet hands', 'One point at a time'];
const INTENTIONS = ['I run my own race', 'I trust my preparation', 'I play the next moment'];

export function goldenProfiles(): GoldenProfile[] {
  const out: GoldenProfile[] = [];
  for (const engine of ENGINES) {
    const sports = SPORTS.filter((s) => s.engine === engine);
    // Three profiles per engine; an engine with fewer sports reuses them with different cues and intentions.
    for (let i = 0; i < 3; i++) {
      const sport = sports[i % sports.length]!;
      const cue = CUES[i % CUES.length] as string;
      const intention = INTENTIONS[i % INTENTIONS.length] as string;
      out.push({
        id: `${engine}_${sport.id}_${i}`,
        cue,
        intention,
        profile: fictionalProfile({
          engine,
          sportId: sport.id,
          sportLabel: sport.label,
          cue,
          intention,
          fearedSelf: i === 0,
        }),
      });
    }
  }
  // Edge profiles: feared self disabled, a skipped sensitive field, very long labels.
  const base = SPORTS[0]!;
  out.push({
    id: 'edge_feared_off',
    cue: 'Smooth and steady',
    intention: 'I run my own race',
    profile: fictionalProfile({
      fearedSelf: true,
      engine: base.engine,
      sportId: base.id,
      sportLabel: base.label,
    }),
  });
  out.push({
    id: 'edge_skipped_people',
    cue: 'Quiet hands',
    intention: 'I trust my preparation',
    profile: fictionalProfile({
      cue: 'Quiet hands',
      intention: 'I trust my preparation',
      skipPeople: true,
    }),
  });
  out.push({
    id: 'edge_long_label',
    cue: 'One point at a time',
    intention: 'I play the next moment',
    profile: fictionalProfile({
      cue: 'One point at a time',
      intention: 'I play the next moment',
      sportLabel: 'Fictional twelve stage mountain endurance relay across three valleys',
    }),
  });
  // The "feared self disabled" edge needs the preference turned off.
  const off = out.find((g) => g.id === 'edge_feared_off');
  if (off)
    off.profile = { ...off.profile, preferences: { ...off.profile.preferences, feared_self_enabled: false } };
  return out;
}

export function goldenCases(profiles = goldenProfiles()): GoldenCase[] {
  const cases: GoldenCase[] = [];
  for (const golden of profiles)
    for (const [context, lengths] of Object.entries(SESSION_LENGTHS) as [SessionContext, readonly number[]][])
      for (const lengthMin of lengths)
        cases.push({ id: `${golden.id}:${context}:${lengthMin}`, golden, context, lengthMin });
  return cases;
}
