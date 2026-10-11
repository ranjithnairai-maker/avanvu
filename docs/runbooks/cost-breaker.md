# Cost circuit breaker

`GENERATION_PAUSED` (503, retryable) is returned for new sessions, and the scheduler stops generating special sessions, when estimated vendor cost over the last 24 hours reaches `COST_CAP_DAILY_USD` (SPEC §11.3). Intake continues under its own cap. Athletes see an honest message and their allowance is not used.

## Check

```sql
select vendor, kind, round(sum(est_cost_usd)::numeric, 2) as usd, count(*) as calls
from app.vendor_usage where created_at > now() - interval '24 hours' group by 1, 2 order by usd desc;
```

## Decide

1. Is the spend real demand or abuse? Check session creations per user (`select user_id, count(*) from app.sessions where created_at > now() - interval '1 day' group by 1 order by 2 desc limit 20;`). Per-user limits are 10 sessions a day and 2 in progress.
2. If it is real demand and the unit economics hold (SPEC §13.2, D-22), raise `COST_CAP_DAILY_USD` through a reviewed config change.
3. If it is abuse, do not raise the cap. Review the free-tier abuse controls (D-26).
4. Never silently switch a context to a cheaper TTS tier to stay under the cap (SPEC §13.3: never silently degrade quality).

Estimated cost per call comes from configuration (`TTS_COST_PER_1K_CHARS`) and the vendor responses; keep them in step with the vendor invoices.
