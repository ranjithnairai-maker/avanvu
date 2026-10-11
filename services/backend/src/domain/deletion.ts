/**
 * Account deletion (SPEC §10.5). The API sets `deleted_at` at once (immediate denial) and queues a job; the
 * worker runs eight idempotent steps and records each, so a retry resumes where it stopped:
 *   1 sign out everywhere   2 revoke Apple token   3 delete RevenueCat customer   4 delete analytics person
 *   5 delete storage objects   6 delete database rows (cascade)   7 delete the auth user   8 deletion ledger
 */
import { withSystemTx, type Db, type Tx } from '../db/tx';
import type { Logger } from '../observability/logger';
import type { Storage } from '../ports/storage';
import type { AccountVendors, AppleAuth, RevenueCatClient } from '../ports/vendors';
import type { Sealer } from '../security/seal';
import { addOutboxEvent } from './outbox';

export const DELETION_STEPS = [
  'sign_out',
  'apple_revoke',
  'revenuecat',
  'analytics',
  'storage',
  'database',
  'auth_user',
  'ledger',
] as const;
export type DeletionStep = (typeof DELETION_STEPS)[number];

/** API side: mark deleted, create the job and its outbox row in the caller's user transaction. */
export async function requestDeletion(
  trx: Tx,
  userId: string,
  now: Date,
): Promise<{ jobId: string; outboxId: string }> {
  await trx
    .updateTable('app.users')
    .set({ deleted_at: now })
    .where('id', '=', userId)
    .where('deleted_at', 'is', null)
    .execute();
  const job = await trx
    .insertInto('app.deletion_jobs')
    .values({ user_id: userId })
    .onConflict((oc) => oc.column('user_id').doUpdateSet({ state: 'queued' }))
    .returning('id')
    .executeTakeFirstOrThrow();
  const jobId = job.id;
  const outboxId = await addOutboxEvent(trx, { userId, kind: 'delete_account', subjectId: jobId });
  return { jobId, outboxId };
}

export interface DeletionDeps {
  db: Db;
  sealer: Sealer;
  storage: Storage;
  apple: AppleAuth;
  revenuecat: RevenueCatClient;
  vendors: AccountVendors;
  logger: Logger;
  now: () => Date;
}

type Steps = Partial<Record<DeletionStep, 'done'>>;

export async function runDeletion(
  deps: DeletionDeps,
  jobId: string,
): Promise<{ status: number; result: string }> {
  const { db } = deps;
  const job = await withSystemTx(db, 'worker', (trx) =>
    trx.selectFrom('app.deletion_jobs').selectAll().where('id', '=', jobId).executeTakeFirst(),
  );
  if (!job) return { status: 200, result: 'unknown_job' };
  const j = { id: job.id, user_id: job.user_id, state: job.state, steps: job.steps as Steps };
  if (j.state === 'completed') return { status: 200, result: 'completed' };
  const userId = j.user_id;
  const steps: Steps = { ...(j.steps ?? {}) };

  const mark = async (s: DeletionStep) => {
    steps[s] = 'done';
    await withSystemTx(db, 'worker', (trx) =>
      trx
        .updateTable('app.deletion_jobs')
        .set({ steps: JSON.stringify(steps) as never, state: 'running', updated_at: deps.now() })
        .where('id', '=', jobId)
        .execute(),
    );
  };

  try {
    // Facts needed by later steps are read first and survive a retry only while the rows still exist.
    const facts = await withSystemTx(db, 'worker', async (trx) => ({
      user: await trx
        .selectFrom('app.users')
        .select(['analytics_id'])
        .where('id', '=', userId)
        .executeTakeFirst(),
      apple: await trx
        .selectFrom('app.apple_tokens')
        .select('refresh_token_enc')
        .where('user_id', '=', userId)
        .executeTakeFirst(),
    }));

    if (!steps.sign_out) {
      await deps.vendors.signOutAll(userId);
      await mark('sign_out');
    }
    if (!steps.apple_revoke) {
      if (facts.apple) {
        const sealer = await deps.sealer.forUser(userId);
        const token = await sealer.open<string>(
          {
            table: 'apple_tokens',
            column: 'refresh_token_enc',
            rowId: userId,
            schemaVersion: 'apple_token_v1',
          },
          facts.apple.refresh_token_enc,
        );
        await deps.apple.revoke(token);
      }
      await mark('apple_revoke');
    }
    if (!steps.revenuecat) {
      await deps.revenuecat.deleteCustomer(userId);
      await mark('revenuecat');
    }
    if (!steps.analytics) {
      if (facts.user) await deps.vendors.deleteAnalyticsPerson(facts.user.analytics_id);
      await mark('analytics');
    }
    if (!steps.storage) {
      await deps.storage.deletePrefix('audio', `audio/${userId}/`);
      await deps.storage.deletePrefix('exports', `exports/${userId}/`);
      await mark('storage');
    }
    if (!steps.database) {
      await withSystemTx(db, 'worker', async (trx) => {
        await trx.deleteFrom('app.rate_limit_buckets').where('subject', '=', userId).execute();
        await trx.deleteFrom('app.users').where('id', '=', userId).execute(); // cascades every user-owned row
      });
      await mark('database');
    }
    if (!steps.auth_user) {
      await deps.vendors.deleteAuthUser(userId);
      await mark('auth_user');
    }
    if (!steps.ledger) {
      await withSystemTx(db, 'worker', async (trx) => {
        await trx
          .insertInto('app.deletion_ledger')
          .values({ user_id: userId, deleted_at: deps.now() })
          .onConflict((oc) => oc.column('user_id').doNothing())
          .execute();
      });
      await mark('ledger');
    }
    await withSystemTx(db, 'worker', (trx) =>
      trx
        .updateTable('app.deletion_jobs')
        .set({ state: 'completed', updated_at: deps.now() })
        .where('id', '=', jobId)
        .execute(),
    );
    deps.logger.info('account_deleted', {});
    return { status: 200, result: 'completed' };
  } catch {
    deps.logger.warn('account_deletion_retry', {});
    return { status: 503, result: 'retry' };
  }
}
