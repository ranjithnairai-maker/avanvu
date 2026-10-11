-- The API creates the deletion job inside the athlete's own transaction (so that "mark deleted" and "queue the
-- job" commit together), so deletion_jobs is user-scoped like other tables, plus system access for the worker.
drop policy if exists internal_only on app.deletion_jobs;
create policy user_isolation on app.deletion_jobs for all
  using (user_id = app.current_user_id() or app.is_system())
  with check (user_id = app.current_user_id() or app.is_system());
