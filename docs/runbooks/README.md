# Runbooks

Every alert links to a short runbook here (SPEC §11.5). Queries below read metadata only: never select or decrypt sensitive columns, and never paste athlete text into a ticket.

| Runbook | When |
| --- | --- |
| [go-live.md](go-live.md) | Before the first deploy: adapters to implement, accounts to create, order of operations |
| [render-failures.md](render-failures.md) | Sessions stuck or failing, render queue age, dead jobs |
| [cost-breaker.md](cost-breaker.md) | `GENERATION_PAUSED`, daily cost cap reached |
| [safety-events.md](safety-events.md) | A crisis interruption was recorded; reviewer feedback loop; lexicon changes |
| [account-deletion.md](account-deletion.md) | A deletion job is retrying or failed; restoring a backup |
| [outbox-and-queues.md](outbox-and-queues.md) | Tasks not arriving, duplicate pushes, scheduler not ticking |
