# Render failures and stuck sessions

Alert sources: render queue age, dead jobs (`render_jobs.state = 'failed'`), `session_failed` analytics by `error_code`.

## Reading the state (metadata only)

```sql
-- Failed in the last day, by reason
select last_error_code, count(*) from app.render_jobs
where state = 'failed' and updated_at > now() - interval '1 day' group by 1 order by 2 desc;

-- Jobs that look stuck: running or queued with an expired lease
select j.id, j.state, j.attempt, j.stage, j.lease_expires_at
from app.render_jobs j
where j.state in ('queued', 'running') and (j.lease_expires_at is null or j.lease_expires_at < now() - interval '10 minutes');
```

## Error codes

| Code | Meaning | Action |
| --- | --- | --- |
| `VALIDATION_FAILED_AFTER_REPAIR` | The script failed deterministic rules or the judge twice | Check which rule ids dominate (`session_scripts.versions`, judge failure counts). A spike after a prompt or model change means roll the change back (EVALS §7). Allowance was reversed. |
| `DURATION_UNFITTABLE` | Speech alone does not fit the target length | A word-budget bug or a voice whose calibrated `wpm` is wrong. Recalibrate `voice_catalog.wpm`. Never fix by re-synthesising. |
| `AUDIO_OUT_OF_TOLERANCE` | Encoded file outside loudness or duration tolerance | Renderer bug: reproduce with the golden fixtures (`renderer.test.ts`). |
| `ATTEMPTS_EXHAUSTED` | Three retryable failures (vendor 429/5xx, timeouts) | Check vendor status and the cost breaker. Athletes can retry; their allowance was reversed. |
| `ENTITLEMENT_REVOKED` | Plan lapsed before generation started | Expected. Allowance reversed. |

## Recovery

- The scheduler tick re-dispatches jobs whose task was lost (new task name via `dispatch_generation`). If the tick is not running, see [outbox-and-queues.md](outbox-and-queues.md).
- Chunk caches live under `jobs/{job_id}/` and are removed at job end; a daily sweep removes anything older than 24 h.
- To retry a failed session for an athlete, ask them to create it again. Do not edit ledger rows by hand: the ledger is append-only and reversals are idempotent.
