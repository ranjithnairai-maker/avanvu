-- Generated from packages/core/src/sports.ts (CONTRACTS §2). Do not edit by hand:
-- run `pnpm --filter @avanvu/backend gen:sports` and commit. A test keeps this file in sync with the registry.
insert into app.sport_engines (id, engine, label) values
  ('running_road', 'endurance_v1', 'Road running'),
  ('running_track_distance', 'endurance_v1', 'Track distance running'),
  ('trail_ultra', 'endurance_v1', 'Trail and ultra running'),
  ('cycling_road', 'endurance_v1', 'Road cycling'),
  ('cycling_track', 'endurance_v1', 'Track cycling'),
  ('cycling_mtb_xc', 'endurance_v1', 'Cross-country mountain biking'),
  ('swimming_pool', 'endurance_v1', 'Pool swimming'),
  ('swimming_open_water', 'endurance_v1', 'Open-water swimming'),
  ('triathlon', 'endurance_v1', 'Triathlon'),
  ('duathlon', 'endurance_v1', 'Duathlon'),
  ('rowing', 'endurance_v1', 'Rowing'),
  ('paddling', 'endurance_v1', 'Paddling'),
  ('race_walking', 'endurance_v1', 'Race walking'),
  ('xc_skiing', 'endurance_v1', 'Cross-country skiing'),
  ('skating_long_distance', 'endurance_v1', 'Long-distance skating'),
  ('custom_endurance', 'endurance_v1', 'Other endurance event'),
  ('soccer', 'field_court_team_v1', 'Soccer'),
  ('basketball', 'field_court_team_v1', 'Basketball'),
  ('cricket', 'bat_ball_team_v1', 'Cricket'),
  ('baseball', 'bat_ball_team_v1', 'Baseball'),
  ('golf', 'closed_skill_v1', 'Golf'),
  ('tennis', 'opponent_rally_v1', 'Tennis'),
  ('badminton', 'opponent_rally_v1', 'Badminton')
on conflict (id) do update set engine = excluded.engine, label = excluded.label;
