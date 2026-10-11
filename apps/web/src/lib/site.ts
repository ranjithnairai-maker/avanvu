import { getBrand } from '@avanvu/core';

export const brand = getBrand(process.env.AVANVU_ENV === 'production' ? 'production' : 'local');

/** Public site configuration. The support address is not decided yet (D-25), so it comes from the environment. */
export const site = {
  origin: process.env.NEXT_PUBLIC_SITE_ORIGIN ?? `https://${brand.primaryDomain}`,
  supportEmail: process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? brand.supportEmail,
  /** Shown on legal pages until counsel has reviewed them (SPEC §12.8). */
  legalReviewed: process.env.NEXT_PUBLIC_LEGAL_REVIEWED === 'true',
  /** Matches CONSENT_VERSION in the mobile app. */
  documentVersion: '2026-10-11',
} as const;
