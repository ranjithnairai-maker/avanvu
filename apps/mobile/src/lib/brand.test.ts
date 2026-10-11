import { describe, expect, it } from 'vitest';
import { getBrand } from '@avanvu/core';
import config from '../../app.config';

describe('app config matches brand config', () => {
  it('uses the Avanvu name and deep-link scheme', () => {
    const brand = getBrand();
    expect(config.name).toBe(brand.productName);
    expect(config.scheme).toBe(brand.deepLinkScheme);
  });

  it('never carries the retired working name', () => {
    expect(JSON.stringify(config).toLowerCase()).not.toContain('envision');
  });

  it('declares the age-range entitlement and no encryption exemption prompt', () => {
    expect(config.ios?.entitlements?.['com.apple.developer.declared-age-range']).toBe(true);
    expect(config.ios?.infoPlist?.ITSAppUsesNonExemptEncryption).toBe(false);
  });
});
