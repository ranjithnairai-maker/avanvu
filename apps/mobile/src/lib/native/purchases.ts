/**
 * Purchases through RevenueCat over Apple In-App Purchase (SPEC §13, §12.6). Prices, periods, trials and savings
 * come ONLY from StoreKit through RevenueCat's localized strings; nothing is hard-coded. Configured after sign-in
 * with the Supabase user id as the app user id, logged out on sign-out. Without a key the paywall explains that
 * purchases are unavailable and free access continues.
 */
import Purchases, { type PurchasesPackage } from 'react-native-purchases';
import { api } from '@/lib/api';
import { config, configured } from '@/lib/config';

let ready = false;

export async function configurePurchases(userId: string): Promise<void> {
  if (!configured.purchases) return;
  if (!ready) {
    Purchases.configure({ apiKey: config.revenueCatIosKey, appUserID: userId });
    ready = true;
  } else {
    await Purchases.logIn(userId);
  }
}

export async function logOutPurchases(): Promise<void> {
  if (ready) await Purchases.logOut().catch(() => undefined);
}

export interface PlanOption {
  id: string;
  pkg: PurchasesPackage;
  kind: 'monthly' | 'annual';
  /** Localized price string from StoreKit, for example "$12.99". */
  price: string;
  period: string;
  /** Localized introductory offer text from StoreKit, for example "7 days free", or null. */
  trial: string | null;
}

const periodText = (unit: string, n: number) =>
  `${n === 1 ? '' : `${n} `}${unit.toLowerCase()}${n === 1 ? '' : 's'}`.trim();

export async function loadPlans(): Promise<PlanOption[]> {
  if (!ready) return [];
  const offerings = await Purchases.getOfferings();
  const pkgs = offerings.current?.availablePackages ?? [];
  const out: PlanOption[] = [];
  for (const pkg of pkgs) {
    const kind = pkg.packageType === 'ANNUAL' ? 'annual' : pkg.packageType === 'MONTHLY' ? 'monthly' : null;
    if (!kind) continue;
    const intro = pkg.product.introPrice;
    out.push({
      id: pkg.identifier,
      pkg,
      kind,
      price: pkg.product.priceString,
      period: kind === 'annual' ? 'year' : 'month',
      trial:
        intro && intro.price === 0 ? `${periodText(intro.periodUnit, intro.periodNumberOfUnits)} free` : null,
    });
  }
  return out.sort((a, b) => (a.kind === 'annual' ? -1 : 1) - (b.kind === 'annual' ? -1 : 1));
}

export type PurchaseResult = { ok: true } | { ok: false; cancelled: boolean; message: string };

export async function purchase(plan: PlanOption): Promise<PurchaseResult> {
  try {
    await Purchases.purchasePackage(plan.pkg);
    await api.post('/v1/purchases/refresh');
    return { ok: true };
  } catch (e) {
    if ((e as { userCancelled?: boolean }).userCancelled) return { ok: false, cancelled: true, message: '' };
    return {
      ok: false,
      cancelled: false,
      message: "The purchase didn't go through. You haven't been charged. Try again.",
    };
  }
}

export async function restore(): Promise<{ found: boolean }> {
  if (!ready) return { found: false };
  const info = await Purchases.restorePurchases();
  await api.post('/v1/purchases/refresh').catch(() => undefined);
  return { found: Object.keys(info.entitlements.active).length > 0 };
}
