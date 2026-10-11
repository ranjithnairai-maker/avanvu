/**
 * Cloud Tasks OIDC verification (CONTRACTS §8.2 step 1): audience = the worker URL, email = the tasks invoker
 * service account. The job id in the request body is never authority by itself.
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { AvanvuError } from '@avanvu/core';

export interface TaskAuth {
  verify(authorizationHeader: string | undefined): Promise<void>;
}

export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export function createGoogleTaskAuth(opts: {
  audience: string;
  serviceAccountEmail: string;
  keys?: JWTVerifyGetKey;
  issuers?: string[];
}): TaskAuth {
  const keys = opts.keys ?? createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  return {
    async verify(header) {
      const m = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(header ?? '');
      if (!m?.[1]) throw new AvanvuError('UNAUTHENTICATED', 'Not allowed.');
      try {
        const { payload } = await jwtVerify(m[1], keys, {
          issuer: opts.issuers ?? GOOGLE_ISSUERS,
          audience: opts.audience,
          algorithms: ['RS256', 'ES256'],
        });
        if (payload.email !== opts.serviceAccountEmail || payload.email_verified === false)
          throw new Error('wrong caller');
      } catch {
        throw new AvanvuError('UNAUTHENTICATED', 'Not allowed.');
      }
    },
  };
}

/** Local development and tests only: accepts a fixed shared token. Never construct this in production. */
export function createStaticTaskAuth(token: string): TaskAuth {
  return {
    async verify(header) {
      if (header !== `Bearer ${token}`) throw new AvanvuError('UNAUTHENTICATED', 'Not allowed.');
    },
  };
}
