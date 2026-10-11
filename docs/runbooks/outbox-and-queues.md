# Outbox, queues and the scheduler

Work is created as rows plus an `outbox_events` row in the same transaction. After commit the API enqueues a Cloud Task named `{kind}-{job_id}-{dispatch_generation}`. The sweeper (every minute, `POST /internal/outbox/sweep`) enqueues rows still undispatched after 30 seconds. The scheduler tick (every five minutes, `POST /internal/schedule/tick`) generates night-before and primer sessions at T-72 h, sends offline-readiness nudges, re-dispatches stuck render jobs and purges expired data.

## Symptoms

| Symptom | Check |
| --- | --- |
| Sessions stay `queued` | `select count(*), min(created_at) from app.outbox_events where dispatched_at is null;` A growing backlog means enqueue is failing or the sweeper is not running. Check Cloud Scheduler job status and the API logs for `outbox_dispatch_deferred`. |
| Task delivered but nothing happens | The worker returns 200 with `lease_held` when another attempt owns the job or it already finished. Look at `render_jobs.lease_owner` and `lease_expires_at`. |
| Duplicate pushes | Should be impossible: `notification_deliveries` has a unique `(user_id, kind, subject_id)`. If seen, check that nothing writes pushes outside that table. |
| Special sessions not generated | The tick log `special_generation_deferred`; `program_items.state = 'locked'` means the allowance was insufficient (the athlete was notified once); `GENERATION_PAUSED` in the tick report means the cost breaker is open. |

## Manual re-dispatch of one row

Bump the generation so the task name is new, then let the sweeper pick it up:

```sql
update app.outbox_events set dispatch_generation = dispatch_generation + 1, dispatched_at = null where id = '<outbox id>';
```

Duplicate deliveries are harmless: leases, checkpoints, deterministic storage paths and unique constraints make every step idempotent.
