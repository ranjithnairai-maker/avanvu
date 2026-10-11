/**
 * Render job leases (CONTRACTS §8.2): one worker owns a job at a time. The lease is taken with a single
 * atomic update, heartbeated while working, and lost leases abort the attempt. Duplicate task deliveries
 * find the lease held (or the job finished) and return 200 without doing anything.
 */
import { LEASE_SECONDS } from '@avanvu/core';
import { withSystemTx, type Db } from '../db/tx';

export interface LeasedJob {
  id: string;
  user_id: string;
  session_id: string;
  attempt: number;
}

export class LeaseLostError extends Error {
  constructor() {
    super('lease lost');
    this.name = 'LeaseLostError';
  }
}

export async function acquireLease(
  db: Db,
  jobId: string,
  owner: string,
  now: Date,
): Promise<LeasedJob | null> {
  const until = new Date(now.getTime() + LEASE_SECONDS * 1000);
  return withSystemTx(db, 'worker', async (trx) => {
    const row = await trx
      .updateTable('app.render_jobs')
      .set((eb) => ({
        lease_owner: owner,
        lease_expires_at: until,
        state: 'running',
        attempt: eb('attempt', '+', 1),
      }))
      .where('id', '=', jobId)
      .where('state', 'in', ['queued', 'running'])
      .where((eb) => eb.or([eb('lease_expires_at', 'is', null), eb('lease_expires_at', '<', now)]))
      .returning(['id', 'user_id', 'session_id', 'attempt'])
      .executeTakeFirst();
    return row ?? null;
  });
}

/** Extend the lease. Throws LeaseLostError when another worker has taken over. */
export async function heartbeat(
  db: Db,
  jobId: string,
  owner: string,
  now: Date,
  stage?: string,
): Promise<void> {
  const until = new Date(now.getTime() + LEASE_SECONDS * 1000);
  const r = await withSystemTx(db, 'worker', (trx) =>
    trx
      .updateTable('app.render_jobs')
      .set({ lease_expires_at: until, ...(stage ? { stage } : {}) })
      .where('id', '=', jobId)
      .where('lease_owner', '=', owner)
      .where('state', '=', 'running')
      .executeTakeFirst(),
  );
  if (Number(r.numUpdatedRows) !== 1) throw new LeaseLostError();
}

/** Release the lease after a retryable failure so the next delivery can take it immediately. */
export async function releaseLease(db: Db, jobId: string, owner: string, errorCode: string): Promise<void> {
  await withSystemTx(db, 'worker', (trx) =>
    trx
      .updateTable('app.render_jobs')
      .set({ lease_owner: null, lease_expires_at: null, last_error_code: errorCode })
      .where('id', '=', jobId)
      .where('lease_owner', '=', owner)
      .execute(),
  );
}
