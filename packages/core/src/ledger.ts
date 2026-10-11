/** Usage ledger semantics and allowance bucket math (CONTRACTS §11). Pure and unit-testable. */
export type AllowanceType = 'free_training' | 'free_primer' | 'pro';
export type LedgerEntryType = 'grant' | 'reserve' | 'reverse' | 'commit';

export interface LedgerEntry {
  allowance_type: AllowanceType;
  bucket_start: Date;
  bucket_end: Date;
  entry_type: LedgerEntryType;
  quantity: number;
  session_id: string | null;
  idempotency_key: string;
}

const addMonthsUtc = (anchor: Date, months: number): Date => {
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      y,
      m,
      Math.min(anchor.getUTCDate(), lastDay),
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    ),
  );
};

/**
 * Pro bucket k = [anchor + k months, anchor + k+1 months), anchored to the entitlement's original
 * purchase timestamp in UTC. If the anchor day does not exist in a month, use that month's last day.
 */
export function proBucketFor(anchor: Date, now: Date): { index: number; start: Date; end: Date } {
  let k = (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + (now.getUTCMonth() - anchor.getUTCMonth());
  if (now < anchor) throw new Error('now precedes the entitlement anchor');
  while (addMonthsUtc(anchor, k) > now) k--;
  while (addMonthsUtc(anchor, k + 1) <= now) k++;
  return { index: k, start: addMonthsUtc(anchor, k), end: addMonthsUtc(anchor, k + 1) };
}

export const grantKey = (userId: string, bucketStart: Date) => `grant:${userId}:${bucketStart.toISOString()}`;
export const reserveKey = (sessionId: string) => `reserve:${sessionId}`;
export const reverseKey = (sessionId: string) => `reverse:${sessionId}`;
export const commitKey = (sessionId: string) => `commit:${sessionId}`;

export function available(entries: readonly LedgerEntry[], type: AllowanceType, bucketStart: Date): number {
  return entries
    .filter((e) => e.allowance_type === type && e.bucket_start.getTime() === bucketStart.getTime())
    .reduce((sum, e) => sum + e.quantity, 0);
}

/** Pro on-demand availability excludes sessions held for upcoming night-before and primer items. */
export function availableForOnDemand(proAvailable: number, heldForEvents: number): number {
  return Math.max(0, proAvailable - heldForEvents);
}

/** Trial conversion tops the current bucket up to the full monthly allowance. */
export function trialConversionTopUp(proMonthlyAllowance: number, trialAllowance: number): number {
  return Math.max(0, proMonthlyAllowance - trialAllowance);
}
