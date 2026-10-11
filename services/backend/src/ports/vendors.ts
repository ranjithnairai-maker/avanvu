/**
 * Ports for the third-party services the account lifecycle touches (SPEC §10.5, §11.2): RevenueCat,
 * Sign in with Apple, Supabase Auth admin and PostHog. The real adapters are external-API integrations and
 * are placeholders until keys exist; the Fake versions record calls so tests can assert the deletion steps.
 */
import { AvanvuError } from '@avanvu/core';

export interface RcCustomer {
  active: boolean;
  periodType: 'normal' | 'trial' | 'intro' | null;
  product: string | null;
  expiresAt: Date | null;
  originalPurchaseAt: Date | null;
  willRenew: boolean | null;
  billingIssue: boolean;
}

export interface RevenueCatClient {
  /** Current customer state from the REST API (webhooks are only triggers). */
  getCustomer(appUserId: string): Promise<RcCustomer>;
  deleteCustomer(appUserId: string): Promise<void>;
}

export interface AppleAuth {
  /** Exchange the authorization code from native sign-in for a refresh token. */
  exchangeCode(authorizationCode: string): Promise<{ refreshToken: string }>;
  revoke(refreshToken: string): Promise<void>;
}

export interface AccountVendors {
  /** Sign the user out everywhere (Supabase Auth admin API). */
  signOutAll(userId: string): Promise<void>;
  deleteAuthUser(userId: string): Promise<void>;
  /** Delete the PostHog person by analytics id. */
  deleteAnalyticsPerson(analyticsId: string): Promise<void>;
}

const notConfigured = (what: string) =>
  new AvanvuError('UPSTREAM_UNAVAILABLE', `${what} is not configured yet.`);

export class UnconfiguredRevenueCat implements RevenueCatClient {
  getCustomer(): Promise<RcCustomer> {
    return Promise.reject(notConfigured('RevenueCat'));
  }
  deleteCustomer(): Promise<void> {
    return Promise.reject(notConfigured('RevenueCat'));
  }
}

export class UnconfiguredApple implements AppleAuth {
  exchangeCode(): Promise<{ refreshToken: string }> {
    return Promise.reject(notConfigured('Sign in with Apple'));
  }
  revoke(): Promise<void> {
    return Promise.reject(notConfigured('Sign in with Apple'));
  }
}

export class UnconfiguredAccountVendors implements AccountVendors {
  signOutAll(): Promise<void> {
    return Promise.reject(notConfigured('Supabase Auth admin'));
  }
  deleteAuthUser(): Promise<void> {
    return Promise.reject(notConfigured('Supabase Auth admin'));
  }
  deleteAnalyticsPerson(): Promise<void> {
    return Promise.reject(notConfigured('PostHog'));
  }
}

const NONE: RcCustomer = {
  active: false,
  periodType: null,
  product: null,
  expiresAt: null,
  originalPurchaseAt: null,
  willRenew: null,
  billingIssue: false,
};

export class FakeRevenueCat implements RevenueCatClient {
  readonly customers = new Map<string, RcCustomer>();
  readonly deleted: string[] = [];
  fetches = 0;
  failNext = 0;

  async getCustomer(appUserId: string): Promise<RcCustomer> {
    this.fetches++;
    if (this.failNext > 0) {
      this.failNext--;
      throw new AvanvuError('UPSTREAM_UNAVAILABLE', 'revenuecat down');
    }
    return this.customers.get(appUserId) ?? NONE;
  }
  async deleteCustomer(appUserId: string): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new AvanvuError('UPSTREAM_UNAVAILABLE', 'revenuecat down');
    }
    this.deleted.push(appUserId);
  }
}

export class FakeApple implements AppleAuth {
  readonly revoked: string[] = [];
  async exchangeCode(code: string): Promise<{ refreshToken: string }> {
    if (!code.startsWith('valid-')) throw new AvanvuError('VALIDATION_FAILED', 'Sign in with Apple failed.');
    return { refreshToken: `refresh-${code}` };
  }
  async revoke(token: string): Promise<void> {
    this.revoked.push(token);
  }
}

export class FakeAccountVendors implements AccountVendors {
  readonly signedOut: string[] = [];
  readonly authDeleted: string[] = [];
  readonly analyticsDeleted: string[] = [];
  failAnalytics = 0;

  async signOutAll(userId: string): Promise<void> {
    this.signedOut.push(userId);
  }
  async deleteAuthUser(userId: string): Promise<void> {
    this.authDeleted.push(userId);
  }
  async deleteAnalyticsPerson(analyticsId: string): Promise<void> {
    if (this.failAnalytics > 0) {
      this.failAnalytics--;
      throw new AvanvuError('UPSTREAM_UNAVAILABLE', 'posthog down');
    }
    this.analyticsDeleted.push(analyticsId);
  }
}
