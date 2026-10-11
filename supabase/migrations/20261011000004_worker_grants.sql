-- The worker creates outbox rows (push after a session becomes ready) and removes push tokens that Expo
-- reports as invalid. RLS still applies: these run only under the worker or system actor.
grant insert on app.outbox_events to avanvu_worker;
grant delete on app.devices to avanvu_worker;
