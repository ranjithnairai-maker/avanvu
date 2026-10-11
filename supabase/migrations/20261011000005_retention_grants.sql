-- Retention purges (SPEC §10.4) run as the system actor from the scheduler tick: vendor usage and safety
-- events are kept 13 months, metadata only. RLS still applies (system actor only).
grant delete on app.vendor_usage, app.safety_events to avanvu_api;
grant update on app.safety_events to avanvu_api;
