# Account deletion

The API sets `users.deleted_at` at once (every request then returns `ACCOUNT_DELETED`) and queues a `deletion_jobs` row. The worker runs eight idempotent steps and records each in `deletion_jobs.steps`: `sign_out`, `apple_revoke`, `revenuecat`, `analytics`, `storage`, `database`, `auth_user`, `ledger`. A retry resumes after the last completed step.

## A job is retrying or failed

```sql
select id, state, attempt, steps, updated_at from app.deletion_jobs where state <> 'completed' order by updated_at;
```

- The `steps` keys show which steps finished. The next step is the one failing. Usually a vendor outage: fix or wait, the queue (10 attempts, backoff up to 10 minutes) retries.
- If attempts are exhausted, re-enqueue by bumping the outbox generation (see [outbox-and-queues.md](outbox-and-queues.md)). Do not delete rows by hand: later steps need the earlier facts.
- A completed deletion writes `deletion_ledger (user_id, deleted_at)`. The API checks it, so an unexpired token cannot recreate the account.

## Restoring a backup

Backups still contain deleted athletes until they expire (disclosed in the Privacy Policy). After **any** restore, replay the ledger before the service is opened:

```sql
delete from app.users where id in (select user_id from app.deletion_ledger);
```

The cascade removes every user-owned row. Then delete their storage prefixes (`audio/{id}/`, `exports/{id}/`). The ledger itself is kept for backup retention plus 30 days.
