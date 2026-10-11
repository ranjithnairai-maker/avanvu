/**
 * Transactional outbox + dispatcher (D-02, SPEC §9.3). Work rows and an outbox row are written in the same
 * transaction as the triggering change. After commit the API enqueues a Cloud Task named
 * `{kind}-{job_id}-{dispatch_generation}`; a failure there is fine because the 1-minute sweeper enqueues
 * undispatched rows older than 30 s. Duplicate enqueues are harmless (unique task names).
 */
import { sql } from 'kysely';
import { withSystemTx, type Db, type Tx } from '../db/tx';
import type { Logger } from '../observability/logger';
import type { QueueName, TaskQueue, TaskSpec } from '../ports/queue';

export type OutboxKind = 'render' | 'export' | 'delete_account' | 'entitlement_sync' | 'push';

const ROUTES: Record<OutboxKind, { queue: QueueName; path: string }> = {
  render: { queue: 'render', path: '/tasks/render' },
  export: { queue: 'jobs', path: '/tasks/export' },
  delete_account: { queue: 'jobs', path: '/tasks/delete-account' },
  entitlement_sync: { queue: 'jobs', path: '/tasks/entitlement-sync' },
  push: { queue: 'jobs', path: '/tasks/push' },
};

export async function addOutboxEvent(
  trx: Tx,
  input: { userId: string; kind: OutboxKind; subjectId: string },
): Promise<string> {
  const row = await trx
    .insertInto('app.outbox_events')
    .values({ user_id: input.userId, kind: input.kind, subject_id: input.subjectId })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export function taskFor(kind: OutboxKind, subjectId: string, generation: number): TaskSpec {
  const route = ROUTES[kind];
  return {
    queue: route.queue,
    name: `${kind}-${subjectId}-${generation}`,
    path: route.path,
    body: { job_id: subjectId, kind },
  };
}

export class OutboxDispatcher {
  constructor(
    private readonly db: Db,
    private readonly queue: TaskQueue,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Enqueue one outbox row and mark it dispatched. Safe to call twice. */
  async dispatch(outboxId: string): Promise<boolean> {
    const row = await withSystemTx(this.db, 'system', (trx) =>
      trx.selectFrom('app.outbox_events').selectAll().where('id', '=', outboxId).executeTakeFirst(),
    );
    if (!row || row.dispatched_at) return false;
    await this.queue.enqueue(taskFor(row.kind as OutboxKind, row.subject_id, row.dispatch_generation));
    // The task may already exist from an earlier attempt that died before marking; either way it is queued.
    await withSystemTx(this.db, 'system', (trx) =>
      trx
        .updateTable('app.outbox_events')
        .set({ dispatched_at: this.now() })
        .where('id', '=', outboxId)
        .where('dispatched_at', 'is', null)
        .execute(),
    );
    return true;
  }

  /** Called right after the request transaction commits. Errors are swallowed: the sweeper recovers. */
  async dispatchAfterCommit(outboxIds: readonly string[]): Promise<void> {
    for (const id of outboxIds) {
      try {
        await this.dispatch(id);
      } catch {
        this.logger.warn('outbox_dispatch_deferred', {});
      }
    }
  }

  /** Cloud Scheduler, every minute: enqueue undispatched rows older than 30 seconds. */
  async sweep(minAgeMs = 30_000, limit = 100): Promise<number> {
    const cutoff = new Date(this.now().getTime() - minAgeMs);
    const rows = await withSystemTx(this.db, 'system', (trx) =>
      trx
        .selectFrom('app.outbox_events')
        .select('id')
        .where('dispatched_at', 'is', null)
        .where('created_at', '<=', cutoff)
        .orderBy('created_at')
        .limit(limit)
        .execute(),
    );
    let n = 0;
    for (const r of rows) {
      try {
        if (await this.dispatch(r.id)) n++;
      } catch {
        this.logger.warn('outbox_sweep_failed', {});
      }
    }
    return n;
  }

  /**
   * Re-dispatch work whose task was lost: bumps the generation so the task name is new. Used by the
   * stuck-job recovery in the scheduler tick.
   */
  async redispatch(outboxId: string): Promise<void> {
    await withSystemTx(this.db, 'system', (trx) =>
      trx
        .updateTable('app.outbox_events')
        .set({ dispatch_generation: sql`dispatch_generation + 1` as never, dispatched_at: null })
        .where('id', '=', outboxId)
        .execute(),
    );
    await this.dispatch(outboxId);
  }
}
