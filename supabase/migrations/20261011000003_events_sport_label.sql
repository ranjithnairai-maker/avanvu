-- The athlete's own words for their sport ("half Ironman", or a custom endurance event) are captured on the
-- event setup screen, before the interview exists. Athlete-supplied text is sensitive, so it is sealed (🔒).
alter table app.events add column sport_label_enc bytea;
