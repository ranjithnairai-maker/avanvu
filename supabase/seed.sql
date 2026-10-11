-- LOCAL DEVELOPMENT ONLY. Applied by `supabase db reset` on a developer machine and in CI. Never applied to
-- preview or production. Fictional data only (CLAUDE.md non-negotiable 9).

-- Give the runtime roles a login so `pnpm dev:backend` can connect as the real least-privilege roles.
-- The password is a local-only throwaway. Production passwords live in Secret Manager.
alter role avanvu_api login password 'local-dev-api';
alter role avanvu_worker login password 'local-dev-worker';

-- Placeholder voices for local runs (the real three are a founder decision, D-27).
insert into app.voice_catalog (id, label, provider_voice_id, wpm, settings_version) values
  ('fake_voice_a', 'Local voice A', 'fake_voice_a', 100, 'local-1'),
  ('fake_voice_b', 'Local voice B', 'fake_voice_b', 105, 'local-1'),
  ('fake_voice_c', 'Local voice C', 'fake_voice_c', 95, 'local-1')
on conflict (id) do nothing;
