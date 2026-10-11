-- pgTAP: isolation and hardening checks that mirror services/backend/src/db/isolation.test.ts.
-- Run with `supabase test db` (CI) against the real Supabase stack.
begin;
select plan(12);

select has_schema('app', 'schema app exists');
select ok(not has_schema_privilege('anon', 'app', 'usage'), 'anon has no access to app');
select ok(not has_schema_privilege('authenticated', 'app', 'usage'), 'authenticated has no access to app');

select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'app' and c.relkind = 'r'
     and c.relname not in ('sport_engines', 'voice_catalog', 'music_catalog')
     and not (c.relrowsecurity and c.relforcerowsecurity)),
  0, 'every user table has RLS enabled and forced');

select ok(not (select rolbypassrls or rolsuper from pg_roles where rolname = 'avanvu_api'), 'avanvu_api has no BYPASSRLS');
select ok(not (select rolbypassrls or rolsuper from pg_roles where rolname = 'avanvu_worker'), 'avanvu_worker has no BYPASSRLS');

select is((select count(*)::int from app.sport_engines), 23, 'sport registry is seeded');

-- Two athletes.
insert into app.users (id) values ('11111111-1111-4111-8111-111111111111'), ('22222222-2222-4222-8222-222222222222');
insert into app.waitlist_entries (user_id, sport_label) values
  ('11111111-1111-4111-8111-111111111111', 'Curling'), ('22222222-2222-4222-8222-222222222222', 'Bowls');

set local role avanvu_api;
select set_config('app.user_id', '11111111-1111-4111-8111-111111111111', true);
select set_config('app.actor', 'user', true);

select is((select count(*)::int from app.waitlist_entries), 1, 'a user transaction sees only its own rows');
select is((select sport_label from app.waitlist_entries), 'Curling', 'and they are the right rows');
select throws_ok(
  $$insert into app.waitlist_entries (user_id, sport_label) values ('22222222-2222-4222-8222-222222222222', 'x')$$,
  '42501', null, 'cannot insert a row for another user');

select set_config('app.user_id', '', true);
select is((select count(*)::int from app.waitlist_entries), 0, 'with no identity nothing is visible');

select * from finish();
rollback;
