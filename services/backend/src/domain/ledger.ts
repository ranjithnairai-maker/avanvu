/**
 * Usage ledger operations (CONTRACTS §11, SPEC §5.3, §13). Append-only: reserve, reverse and commit are
 * inserts keyed by deterministic idempotency keys, so duplicates are harmless. Reservation is serialised
 * per user with an advisory lock so two concurrent requests cannot both spend the last session.
 */
import { sql } from 'kysely';
import { AvanvuError, proBucketFor, availableForOnDemand, trialConversionTopUp, type AllowanceType } from '@avanvu/core';
import type { Tx } from '../db/tx';
import { FREE_BUCKET_END } from './accounts';

export interface AllowanceConfig {
  PRO_MONTHLY_ALLOWANCE: number;
  TRIAL_SESSION_ALLOWANCE: number;
}

export interface EntitlementState {
  active: boolean;
  period_type: 'normal' | 'trial' | 'intro' | null;
  original_purchase_at: Date | null;
  expires_at: Date | null;
}

export type SessionContext = 'training' | 'night_before' | 'primer';

export async function loadEntitlement(trx: Tx, userId: string): Promise<EntitlementState | null> {
  const row = await trx.selectFrom('app.entitlements').selectAll().where('user_id', '=', userId).executeTakeFirst();
  if (!row) return null;
  return {
    active: row.active,
    period_type: row.period_type,
    original_purchase_at: row.original_purchase_at ? new Date(row.original_purchase_at) : null,
    expires_at: row.expires_at ? new Date(row.expires_at) : null,
  };
}

/** An entitlement grants Pro only while active and not past its expiry. */
export function isProActive(e: EntitlementState | null, now: Date): e is EntitlementState & { original_purchase_at: Date } {
  return !!e && e.active && e.original_purchase_at !== null && (e.expires_at === null || e.expires_at > now);
}

async function lockUser(trx: Tx, userId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtext(${userId}))`.execute(trx);
}

async function sumFor(trx: Tx, userId: string, type: AllowanceType, bucketStart: Date): Promise<number> {
  const r = await trx
    .selectFrom('app.usage_ledger')
    .select((eb) => eb.fn.sum<string>('quantity').as('total'))
    .where('user_id', '=', userId)
    .where('allowance_type', '=', type)
    .where('bucket_start', '=', bucketStart)
    .executeTakeFirst();
  return Number(r?.total ?? 0);
}

/**
 * Writes the grant for the current Pro bucket if missing (lazily, the first time it is needed), including
 * the trial allowance and the conversion top-up (CONTRACTS §11).
 */
export async function ensureProGrant(
  trx: Tx,
  userId: string,
  ent: EntitlementState & { original_purchase_at: Date },
  now: Date,
  cfg: AllowanceConfig,
): Promise<{ start: Date; end: Date }> {
  const bucket = proBucketFor(ent.original_purchase_at, now);
  const startIso = bucket.start.toISOString();
  const grant = async (key: string, quantity: number) => {
    if (quantity <= 0) return;
    await trx
      .insertInto('app.usage_ledger')
      .values({
        user_id: userId,
        allowance_type: 'pro',
        bucket_start: bucket.start,
        bucket_end: bucket.end,
        entry_type: 'grant',
        quantity,
        idempotency_key: key,
      })
      .onConflict((oc) => oc.column('idempotency_key').doNothing())
      .execute();
  };

  const key = `grant:${userId}:${startIso}`;
  if (ent.period_type === 'trial') {
    await grant(key, cfg.TRIAL_SESSION_ALLOWANCE);
  } else {
    const existing = await trx
      .selectFrom('app.usage_ledger')
      .select('quantity')
      .where('idempotency_key', '=', key)
      .executeTakeFirst();
    if (!existing) {
      await grant(key, cfg.PRO_MONTHLY_ALLOWANCE);
    } else if (existing.quantity === cfg.TRIAL_SESSION_ALLOWANCE && cfg.TRIAL_SESSION_ALLOWANCE !== cfg.PRO_MONTHLY_ALLOWANCE) {
      // The trial converted inside the bucket that holds the trial grant: top up to the full allowance.
      await grant(
        `topup:${userId}:${startIso}`,
        trialConversionTopUp(cfg.PRO_MONTHLY_ALLOWANCE, cfg.TRIAL_SESSION_ALLOWANCE),
      );
    }
  }
  return bucket;
}

/** Sessions held for upcoming night-before and primer items that start generation inside this bucket. */
export async function heldForEvents(trx: Tx, userId: string, bucketEnd: Date): Promise<number> {
  const r = await trx
    .selectFrom('app.program_items')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('user_id', '=', userId)
    .where('kind', 'in', ['night_before', 'primer'])
    .where('state', '=', 'planned')
    .where('generate_at', '<', bucketEnd)
    .executeTakeFirst();
  return Number(r?.n ?? 0);
}

export interface AllowanceSummary {
  free_training: number;
  free_primer: number;
  pro: null | {
    available: number;
    held_for_events: number;
    available_for_on_demand: number;
    bucket_start: string;
    bucket_end: string;
  };
}

/** Read-only summary for GET /me. Does not write grants. */
export async function allowanceSummary(
  trx: Tx,
  userId: string,
  ent: EntitlementState | null,
  now: Date,
): Promise<AllowanceSummary> {
  const free = async (type: 'free_training' | 'free_primer') => {
    const r = await trx
      .selectFrom('app.usage_ledger')
      .select((eb) => eb.fn.sum<string>('quantity').as('total'))
      .where('user_id', '=', userId)
      .where('allowance_type', '=', type)
      .executeTakeFirst();
    return Number(r?.total ?? 0);
  };
  const summary: AllowanceSummary = { free_training: await free('free_training'), free_primer: await free('free_primer'), pro: null };
  if (isProActive(ent, now)) {
    const bucket = proBucketFor(ent.original_purchase_at, now);
    const available = await sumFor(trx, userId, 'pro', bucket.start);
    const held = await heldForEvents(trx, userId, bucket.end);
    summary.pro = {
      available,
      held_for_events: held,
      available_for_on_demand: availableForOnDemand(available, held),
      bucket_start: bucket.start.toISOString(),
      bucket_end: bucket.end.toISOString(),
    };
  }
  return summary;
}

export interface ReserveInput {
  userId: string;
  sessionId: string;
  context: SessionContext;
  /** True when the reservation is for a program's planned night-before or primer item (scheduler path). */
  fromSpecialItem: boolean;
  now: Date;
  ent: EntitlementState | null;
  cfg: AllowanceConfig;
}

export interface Reservation {
  allowance_type: AllowanceType;
  bucket_start: Date;
  bucket_end: Date;
}

/** Reserve one session (−1). Throws ENTITLEMENT_REQUIRED or ALLOWANCE_EXHAUSTED. Idempotent per session. */
export async function reserveSession(trx: Tx, input: ReserveInput): Promise<Reservation> {
  const { userId, sessionId, context, fromSpecialItem, now, ent, cfg } = input;
  await lockUser(trx, userId);

  const existing = await trx
    .selectFrom('app.usage_ledger')
    .selectAll()
    .where('idempotency_key', '=', `reserve:${sessionId}`)
    .executeTakeFirst();
  if (existing) {
    return {
      allowance_type: existing.allowance_type,
      bucket_start: new Date(existing.bucket_start),
      bucket_end: new Date(existing.bucket_end),
    };
  }

  let type: AllowanceType;
  let start: Date;
  let end: Date;
  let spendable: number;

  if (isProActive(ent, now)) {
    type = 'pro';
    const bucket = await ensureProGrant(trx, userId, ent, now, cfg);
    start = bucket.start;
    end = bucket.end;
    const available = await sumFor(trx, userId, 'pro', start);
    // Special items consume the allowance held for them; everything else sees available minus holds.
    spendable = fromSpecialItem ? available : availableForOnDemand(available, await heldForEvents(trx, userId, end));
  } else {
    if (context === 'night_before') throw new AvanvuError('ENTITLEMENT_REQUIRED', 'This session needs Avanvu Pro.');
    if (context === 'primer' && !fromSpecialItem) {
      throw new AvanvuError('ENTITLEMENT_REQUIRED', 'Personalized primers on demand need Avanvu Pro.');
    }
    type = context === 'primer' ? 'free_primer' : 'free_training';
    const grant = await trx
      .selectFrom('app.usage_ledger')
      .select(['bucket_start', 'bucket_end'])
      .where('user_id', '=', userId)
      .where('allowance_type', '=', type)
      .where('entry_type', '=', 'grant')
      .executeTakeFirst();
    if (!grant) throw new AvanvuError('ENTITLEMENT_REQUIRED', 'Upgrade to create more sessions.');
    start = new Date(grant.bucket_start);
    end = new Date(grant.bucket_end ?? FREE_BUCKET_END);
    spendable = await sumFor(trx, userId, type, start);
  }

  if (spendable < 1) throw new AvanvuError('ALLOWANCE_EXHAUSTED', "You've used this month's new sessions.");

  await trx
    .insertInto('app.usage_ledger')
    .values({
      user_id: userId,
      allowance_type: type,
      bucket_start: start,
      bucket_end: end,
      entry_type: 'reserve',
      quantity: -1,
      session_id: sessionId,
      idempotency_key: `reserve:${sessionId}`,
    })
    .execute();
  return { allowance_type: type, bucket_start: start, bucket_end: end };
}

/** Give the session back (+1) after a failure or cancel. No effect if never reserved or already committed. */
export async function reverseReservation(trx: Tx, userId: string, sessionId: string): Promise<boolean> {
  await lockUser(trx, userId);
  const reserve = await trx
    .selectFrom('app.usage_ledger')
    .selectAll()
    .where('idempotency_key', '=', `reserve:${sessionId}`)
    .executeTakeFirst();
  if (!reserve) return false;
  const committed = await trx
    .selectFrom('app.usage_ledger')
    .select('id')
    .where('idempotency_key', '=', `commit:${sessionId}`)
    .executeTakeFirst();
  if (committed) return false;
  const inserted = await trx
    .insertInto('app.usage_ledger')
    .values({
      user_id: userId,
      allowance_type: reserve.allowance_type,
      bucket_start: reserve.bucket_start,
      bucket_end: reserve.bucket_end,
      entry_type: 'reverse',
      quantity: 1,
      session_id: sessionId,
      idempotency_key: `reverse:${sessionId}`,
    })
    .onConflict((oc) => oc.column('idempotency_key').doNothing())
    .returning('id')
    .executeTakeFirst();
  return !!inserted;
}

/** Mark success for audit (0). Idempotent. */
export async function commitReservation(trx: Tx, userId: string, sessionId: string): Promise<void> {
  const reserve = await trx
    .selectFrom('app.usage_ledger')
    .selectAll()
    .where('idempotency_key', '=', `reserve:${sessionId}`)
    .executeTakeFirst();
  if (!reserve) return;
  await trx
    .insertInto('app.usage_ledger')
    .values({
      user_id: userId,
      allowance_type: reserve.allowance_type,
      bucket_start: reserve.bucket_start,
      bucket_end: reserve.bucket_end,
      entry_type: 'commit',
      quantity: 0,
      session_id: sessionId,
      idempotency_key: `commit:${sessionId}`,
    })
    .onConflict((oc) => oc.column('idempotency_key').doNothing())
    .execute();
}
