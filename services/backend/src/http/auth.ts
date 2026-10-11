/**
 * JWT verification (SPEC §10.2): signature through the project JWKS, `iss`, `aud = authenticated`, `exp`.
 * Only asymmetric algorithms are accepted. Account state (deleted) is checked separately and cached 60 s.
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { AvanvuError } from '@avanvu/core';

export interface Authenticator {
  /** Returns the athlete's user id (the JWT `sub`), or throws UNAUTHENTICATED. */
  authenticate(authorizationHeader: string | undefined): Promise<{ userId: string }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASYMMETRIC = ['ES256', 'ES384', 'RS256', 'RS384', 'RS512', 'EdDSA', 'PS256'];

export interface JwtAuthOptions {
  issuer: string;
  keys: JWTVerifyGetKey;
  audience?: string;
}

export function remoteJwks(jwksUrl: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(jwksUrl), { cooldownDuration: 30_000 });
}

export function createJwtAuthenticator(opts: JwtAuthOptions): Authenticator {
  return {
    async authenticate(header) {
      const m = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(header ?? '');
      if (!m?.[1]) throw new AvanvuError('UNAUTHENTICATED', 'Please sign in again.');
      try {
        const { payload } = await jwtVerify(m[1], opts.keys, {
          issuer: opts.issuer,
          audience: opts.audience ?? 'authenticated',
          algorithms: ASYMMETRIC,
        });
        if (typeof payload.sub !== 'string' || !UUID.test(payload.sub)) throw new Error('bad subject');
        return { userId: payload.sub.toLowerCase() };
      } catch {
        // Never reveal why a token failed.
        throw new AvanvuError('UNAUTHENTICATED', 'Please sign in again.');
      }
    },
  };
}
