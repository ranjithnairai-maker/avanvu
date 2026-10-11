/** Single environment-aware brand config (SPEC §1.1). The retired working name must never appear here. */
export type AvanvuEnv = 'local' | 'preview' | 'production';

export interface BrandConfig {
  readonly productName: 'Avanvu';
  readonly wordmark: 'AVANVU';
  readonly tagline: string;
  readonly supportingLine: string;
  readonly appStoreSubtitle: string;
  readonly primaryDomain: string;
  readonly defensiveDomain: string;
  readonly deepLinkScheme: 'avanvu';
  /** Chosen once the legal entity and App Store record exist (D-25); never changes after release. */
  readonly bundleIdentifier: string | null;
  readonly supportEmail: string | null;
  readonly legalEntityName: string | null;
}

const base = {
  productName: 'Avanvu',
  wordmark: 'AVANVU',
  tagline: "You've been here before.",
  supportingLine: 'See it before you live it.',
  appStoreSubtitle: 'Mental rehearsal for athletes',
  primaryDomain: 'avanvu.com',
  defensiveDomain: 'avanvu.app',
  deepLinkScheme: 'avanvu',
  bundleIdentifier: null,
  supportEmail: null,
  legalEntityName: null,
} as const satisfies BrandConfig;

const byEnv: Record<AvanvuEnv, Partial<BrandConfig>> = {
  local: {},
  preview: {},
  production: {},
};

export function getBrand(env: AvanvuEnv = 'local'): BrandConfig {
  return { ...base, ...byEnv[env] };
}
