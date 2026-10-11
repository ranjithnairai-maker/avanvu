/** Supported-sport registry (CONTRACTS §2). Changing it is a scope change needing a founder decision. */
export const ENGINES = [
  'endurance_v1',
  'field_court_team_v1',
  'bat_ball_team_v1',
  'closed_skill_v1',
  'opponent_rally_v1',
] as const;
export type Engine = (typeof ENGINES)[number];

export interface SupportedSport {
  id: string;
  engine: Engine;
  label: string;
  aliases: readonly string[];
}

const s = (id: string, engine: Engine, label: string, aliases: readonly string[] = []): SupportedSport => ({
  id,
  engine,
  label,
  aliases,
});

export const SPORTS: readonly SupportedSport[] = [
  s('running_road', 'endurance_v1', 'Road running', ['marathon', 'half marathon', '10k', '5k']),
  s('running_track_distance', 'endurance_v1', 'Track distance running', ['1500m', '5000m', '10000m']),
  s('trail_ultra', 'endurance_v1', 'Trail and ultra running', ['ultramarathon', 'trail running']),
  s('cycling_road', 'endurance_v1', 'Road cycling', ['gran fondo', 'criterium']),
  s('cycling_track', 'endurance_v1', 'Track cycling', ['velodrome']),
  s('cycling_mtb_xc', 'endurance_v1', 'Cross-country mountain biking', ['xc mtb', 'mountain biking']),
  s('swimming_pool', 'endurance_v1', 'Pool swimming'),
  s('swimming_open_water', 'endurance_v1', 'Open-water swimming'),
  s('triathlon', 'endurance_v1', 'Triathlon', ['ironman', 'half ironman', '70.3']),
  s('duathlon', 'endurance_v1', 'Duathlon'),
  s('rowing', 'endurance_v1', 'Rowing'),
  s('paddling', 'endurance_v1', 'Paddling', ['canoe', 'kayak', 'dragon boat']),
  s('race_walking', 'endurance_v1', 'Race walking'),
  s('xc_skiing', 'endurance_v1', 'Cross-country skiing', ['nordic skiing']),
  s('skating_long_distance', 'endurance_v1', 'Long-distance skating', ['speed skating']),
  s('custom_endurance', 'endurance_v1', 'Other endurance event'),
  s('soccer', 'field_court_team_v1', 'Soccer', ['football']),
  s('basketball', 'field_court_team_v1', 'Basketball'),
  s('cricket', 'bat_ball_team_v1', 'Cricket'),
  s('baseball', 'bat_ball_team_v1', 'Baseball'),
  s('golf', 'closed_skill_v1', 'Golf'),
  s('tennis', 'opponent_rally_v1', 'Tennis'),
  s('badminton', 'opponent_rally_v1', 'Badminton'),
];

export const SPORT_IDS = SPORTS.map((x) => x.id);

export function getSport(id: string): SupportedSport | undefined {
  return SPORTS.find((x) => x.id === id);
}

export function searchSports(query: string): SupportedSport[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...SPORTS];
  return SPORTS.filter(
    (x) => x.label.toLowerCase().includes(q) || x.aliases.some((a) => a.toLowerCase().includes(q)),
  );
}

/** Custom endurance eligibility (SPEC §2.3): all four answers must be yes. */
export const CUSTOM_ENDURANCE_QUESTIONS = [
  'Is it mainly sustained effort over a time or distance?',
  'Can you describe it as a start, stages, a hard moment and a finish?',
  'Can you rehearse it without needing step-by-step technique for a dangerous manoeuvre?',
  'Are you comfortable describing your environment, equipment, pacing intent, hard moment and finish?',
] as const;

export function isCustomEnduranceEligible(answers: readonly boolean[]): boolean {
  return answers.length === CUSTOM_ENDURANCE_QUESTIONS.length && answers.every((a) => a === true);
}

export const CUSTOM_ENDURANCE_LABEL_MAX = 60;
