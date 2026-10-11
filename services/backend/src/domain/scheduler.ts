/**
 * The 5-minute scheduler tick (SPEC §5.2, §6.6, §10.4): generate night-before and primer sessions at
 * event start minus 72 hours, nudge athletes to save race-day sessions offline, sweep stuck render jobs
 * and purge expired data. Every step is idempotent, so a tick that runs twice (or overlaps) is harmless.
 */
import { AvanvuError, type SessionContext } from '@avanvu/core';
import { withSystemTx, withUserTx, type Db } from '../db/tx';
import type { Logger } from '../observability/logger';
import type { Storage } from '../ports/storage';
import { createSession, type CostGuard } from './sessions';
import { addOutboxEvent, type OutboxDispatcher } from './outbox';
import type { AllowanceConfig } from './ledger';
import { latestProfile } from './profile';
import type { Sealer } from '../security/seal';

export interface SchedulerDeps {
  db: Db;
  sealer: Sealer;
  dispatcher: OutboxDispatcher;
  costGuard: CostGuard;
  storage: Storage;
  logger: Logger;
  now: () => Date;
  config: AllowanceConfig;
}

export interface TickReport {
  generated: number;
  blocked: number;
  /** The cost circuit breaker is open: no new generations this tick. */
  paused: boolean;
  waitingForProfile: number;
  nudges: number;
  redispatched: number;
  purged: Record<string, number>;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export class Scheduler {
  constructor(private readonly d: SchedulerDeps) {}

  async tick(): Promise<TickReport> {
    const report: TickReport = {
      generated: 0,
      blocked: 0,
      paused: false,
      waitingForProfile: 0,
      nudges: 0,
      redispatched: 0,
      purged: {},
    };
    await this.generateDueSpecials(report);
    report.nudges = await this.offlineNudges();
    report.redispatched = await this.recoverStuckJobs();
    report.purged = await this.purge();
    return report;
  }

  /** Night-before and primer items whose generate_at has arrived (SPEC §5.2). */
  async generateDueSpecials(report: TickReport): Promise<void> {
    const { d } = this;
    const now = d.now();
    try {
      await d.costGuard.assertGenerationAllowed();
    } catch (e) {
      if (e instanceof AvanvuError && e.code === 'GENERATION_PAUSED') {
        report.paused = true;
        return;
      }
      throw e;
    }
    const due = await withSystemTx(d.db, 'api_system', (trx) =>
      trx
        .selectFrom('app.program_items as i')
        .innerJoin('app.programs as p', 'p.id', 'i.program_id')
        .innerJoin('app.events as e', 'e.id', 'p.event_id')
        .select(['i.id', 'i.user_id', 'i.kind', 'e.starts_at'])
        .where('i.state', '=', 'planned')
        .where('i.kind', 'in', ['night_before', 'primer'])
        .where('i.generate_at', '<=', now)
        .where('e.status', '=', 'upcoming')
        .where('e.starts_at', '>', now)
        .orderBy('i.generate_at')
        .limit(50)
        .execute(),
    );

    for (const item of due) {
      const sealer = await d.sealer.forUser(item.user_id);
      const context = item.kind as SessionContext;
      try {
        const outboxId = await withUserTx(d.db, item.user_id, async (trx) => {
          const profile = await latestProfile(trx, sealer, item.user_id);
          if (!profile) return 'waiting' as const; // Home prompts the athlete to finish the profile
          const prefs = profile.profile.preferences;
          const lengthMin = (context === 'night_before' ? 15 : prefs.primer_length_min) as 3 | 5 | 15;
          const r = await createSession(trx, {
            userId: item.user_id,
            body: { program_item_id: item.id, context, length_min: lengthMin },
            creationKey: `special:${item.id}`,
            now: d.now(),
            cfg: d.config,
            sealer,
          });
          return r.outboxId;
        });
        if (outboxId === 'waiting') {
          report.waitingForProfile++;
          continue;
        }
        if (outboxId) await d.dispatcher.dispatchAfterCommit([outboxId]);
        report.generated++;
      } catch (e) {
        if (!(e instanceof AvanvuError)) {
          d.logger.error('special_generation_failed', { error_code: 'INTERNAL' });
          continue;
        }
        if (e.code === 'ALLOWANCE_EXHAUSTED' || e.code === 'ENTITLEMENT_REQUIRED') {
          // Not enough allowance (or the plan has none for this session): lock the item so the tick stops
          // retrying; the athlete is told once, and the bundled backup primer stays available.
          await this.lockAndNotify(item.id, item.user_id, e.code === 'ALLOWANCE_EXHAUSTED');
          report.blocked++;
        } else {
          d.logger.warn('special_generation_deferred', { error_code: e.code });
        }
      }
    }
  }

  private async lockAndNotify(itemId: string, userId: string, notify: boolean): Promise<void> {
    await withSystemTx(this.d.db, 'api_system', async (trx) => {
      await trx.updateTable('app.program_items').set({ state: 'locked' }).where('id', '=', itemId).execute();
      if (!notify) return;
      const delivery = await trx
        .insertInto('app.notification_deliveries')
        .values({ user_id: userId, kind: 'generation_blocked', subject_id: itemId } as never)
        .onConflict((oc) => oc.columns(['user_id', 'kind', 'subject_id']).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (delivery) await addOutboxEvent(trx, { userId, kind: 'push', subjectId: delivery.id });
    });
  }

  /**
   * iOS does not guarantee background downloads, so at T-48 h and T-24 h any ready special session not yet
   * verified on a device gets one push nudge (SPEC §6.6). One nudge per (kind, session).
   */
  async offlineNudges(): Promise<number> {
    const { d } = this;
    const now = d.now();
    const rows = await withSystemTx(d.db, 'api_system', (trx) =>
      trx
        .selectFrom('app.sessions as s')
        .innerJoin('app.program_items as i', 'i.session_id', 's.id')
        .innerJoin('app.programs as p', 'p.id', 'i.program_id')
        .innerJoin('app.events as e', 'e.id', 'p.event_id')
        .select(['s.id', 's.user_id', 'e.starts_at'])
        .where('s.state', '=', 'ready')
        .where('i.kind', 'in', ['night_before', 'primer'])
        .where('e.starts_at', '>', now)
        .where('e.starts_at', '<=', new Date(now.getTime() + 48 * HOUR))
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('app.session_downloads as dl')
                .select('dl.id')
                .whereRef('dl.session_id', '=', 's.id'),
            ),
          ),
        )
        .execute(),
    );
    let sent = 0;
    for (const r of rows) {
      const untilStart = new Date(r.starts_at).getTime() - now.getTime();
      const kind = untilStart <= 24 * HOUR ? 'offline_nudge_24h' : 'offline_nudge_48h';
      const outboxId = await withSystemTx(d.db, 'api_system', async (trx) => {
        const delivery = await trx
          .insertInto('app.notification_deliveries')
          .values({ user_id: r.user_id, kind, subject_id: r.id } as never)
          .onConflict((oc) => oc.columns(['user_id', 'kind', 'subject_id']).doNothing())
          .returning('id')
          .executeTakeFirst();
        return delivery
          ? addOutboxEvent(trx, { userId: r.user_id, kind: 'push', subjectId: delivery.id })
          : null;
      });
      if (outboxId) {
        await d.dispatcher.dispatchAfterCommit([outboxId]);
        sent++;
      }
    }
    return sent;
  }

  /**
   * A render job whose lease expired long ago and that is still queued or running lost its task (or its
   * worker). Bump the dispatch generation so a fresh uniquely named task is enqueued.
   */
  async recoverStuckJobs(): Promise<number> {
    const { d } = this;
    const cutoff = new Date(d.now().getTime() - 10 * 60_000);
    const stuck = await withSystemTx(d.db, 'api_system', (trx) =>
      trx
        .selectFrom('app.render_jobs as j')
        .innerJoin('app.outbox_events as o', (join) =>
          join.onRef('o.subject_id', '=', 'j.id').on('o.kind', '=', 'render'),
        )
        .select(['o.id as outbox_id'])
        .where('j.state', 'in', ['queued', 'running'])
        .where('o.dispatched_at', '<', cutoff)
        .where((eb) => eb.or([eb('j.lease_expires_at', 'is', null), eb('j.lease_expires_at', '<', cutoff)]))
        .limit(25)
        .execute(),
    );
    for (const s of stuck) await d.dispatcher.redispatch(s.outbox_id);
    return stuck.length;
  }

  /** Retention (SPEC §10.4). Raw intake turns are purged 90 days after summary confirmation (D-23). */
  async purge(): Promise<Record<string, number>> {
    const { d } = this;
    const now = d.now();
    const out: Record<string, number> = {};
    await withSystemTx(d.db, 'api_system', async (trx) => {
      const count = (r: { numDeletedRows: bigint }) => Number(r.numDeletedRows);
      out.intake_turns = count(
        await trx
          .deleteFrom('app.intake_turns')
          .where((eb) =>
            eb(
              'conversation_id',
              'in',
              eb
                .selectFrom('app.intake_conversations')
                .select('id')
                .where('summary_confirmed_at', '<', new Date(now.getTime() - 90 * DAY)),
            ),
          )
          .executeTakeFirst(),
      );
      out.idempotency_keys = count(
        await trx.deleteFrom('app.idempotency_keys').where('expires_at', '<', now).executeTakeFirst(),
      );
      out.webhook_events = count(
        await trx
          .deleteFrom('app.webhook_events')
          .where('received_at', '<', new Date(now.getTime() - 90 * DAY))
          .executeTakeFirst(),
      );
      const thirteenMonths = new Date(now.getTime() - 395 * DAY);
      out.vendor_usage = count(
        await trx.deleteFrom('app.vendor_usage').where('created_at', '<', thirteenMonths).executeTakeFirst(),
      );
      out.safety_events = count(
        await trx.deleteFrom('app.safety_events').where('created_at', '<', thirteenMonths).executeTakeFirst(),
      );
      out.rate_limit_buckets = count(
        await trx
          .deleteFrom('app.rate_limit_buckets')
          .where('updated_at', '<', new Date(now.getTime() - 2 * DAY))
          .executeTakeFirst(),
      );
    });
    // Render chunk caches older than 24 hours (a crashed job that never cleaned up).
    const stale = (await d.storage.list('jobs', 'jobs/')).filter(
      (o) => now.getTime() - o.updatedAt.getTime() > DAY,
    );
    for (const o of stale) await d.storage.delete('jobs', o.path);
    out.job_chunks = stale.length;

    // Exports expire after 72 hours: remove the file and mark the job.
    const expired = await withSystemTx(d.db, 'api_system', (trx) =>
      trx
        .selectFrom('app.export_jobs')
        .select(['id', 'storage_path'])
        .where('state', '=', 'ready')
        .where('expires_at', '<', now)
        .execute(),
    );
    for (const e of expired) {
      if (e.storage_path) await d.storage.delete('exports', e.storage_path);
      await withSystemTx(d.db, 'api_system', (trx) =>
        trx
          .updateTable('app.export_jobs')
          .set({ state: 'expired', storage_path: null })
          .where('id', '=', e.id)
          .execute(),
      );
    }
    out.exports = expired.length;
    return out;
  }
}
