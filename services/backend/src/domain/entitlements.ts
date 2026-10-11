/**
 * Entitlement sync (SPEC §11.2): RevenueCat webhooks are TRIGGERS only. The sync fetches the customer's
 * current state from the REST API and upserts a snapshot, which makes duplicate and out-of-order webhooks
 * harmless. Grants are written lazily by the ledger the first time they are needed.
 */
import { timingSafeEqual, createHash } from 'node:crypto';
import { withSystemTx, type Db } from '../db/tx';
import type { RcCustomer, RevenueCatClient } from '../ports/vendors';
import { addOutboxEvent } from './outbox';

export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export async function syncEntitlement(db: Db, rc: RevenueCatClient, userId: string): Promise<RcCustomer> {
  const c = await rc.getCustomer(userId);
  await withSystemTx(db, 'worker', (trx) =>
    trx
      .insertInto('app.entitlements')
      .values({
        user_id: userId,
        active: c.active,
        period_type: c.periodType,
        product: c.product,
        expires_at: c.expiresAt,
        original_purchase_at: c.originalPurchaseAt,
        will_renew: c.willRenew,
        billing_issue: c.billingIssue,
      })
      .onConflict((oc) =>
        oc.column('user_id').doUpdateSet({
          active: c.active,
          period_type: c.periodType,
          product: c.product,
          expires_at: c.expiresAt,
          original_purchase_at: c.originalPurchaseAt,
          will_renew: c.willRenew,
          billing_issue: c.billingIssue,
        }),
      )
      .execute(),
  );
  return c;
}

export interface RevenueCatWebhookEvent {
  id: string;
  appUserId: string;
  type: string;
}

export function parseRevenueCatWebhook(body: unknown): RevenueCatWebhookEvent | null {
  const e = (body as { event?: Record<string, unknown> } | null)?.event;
  if (!e || typeof e.id !== 'string' || typeof e.app_user_id !== 'string' || typeof e.type !== 'string')
    return null;
  return { id: e.id, appUserId: e.app_user_id.toLowerCase(), type: e.type };
}

/**
 * Store the event by vendor id (duplicates are ignored) and queue a sync for the user. Returns the outbox id
 * to dispatch, or null for a duplicate or an unknown user. Responds quickly: the heavy work is the task.
 */
export async function recordRevenueCatEvent(db: Db, ev: RevenueCatWebhookEvent): Promise<string | null> {
  return withSystemTx(db, 'webhook', async (trx) => {
    const inserted = await trx
      .insertInto('app.webhook_events')
      .values({ vendor: 'revenuecat', vendor_event_id: ev.id })
      .onConflict((oc) => oc.columns(['vendor', 'vendor_event_id']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!inserted) return null;
    if (!/^[0-9a-f-]{36}$/.test(ev.appUserId)) return null;
    const user = await trx
      .selectFrom('app.users')
      .select('id')
      .where('id', '=', ev.appUserId)
      .executeTakeFirst();
    if (!user) return null;
    return addOutboxEvent(trx, { userId: ev.appUserId, kind: 'entitlement_sync', subjectId: ev.appUserId });
  });
}
