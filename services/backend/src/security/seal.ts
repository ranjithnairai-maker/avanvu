/**
 * The only place the backend turns sensitive values into bytea envelopes and back. Encryption itself
 * lives in packages/core/crypto (CLAUDE.md non-negotiable 3); this binds it to table, column, row and user
 * through the AAD so a ciphertext copied to another row or user cannot be decrypted.
 *
 * Connection safety: loading a data key may query the database. Never call `Sealer.seal` or `open` from
 * inside a transaction. Call `forUser(userId)` BEFORE opening the transaction and use the returned
 * `UserSealer` inside it, which is pure CPU after that. (A nested lookup would hold two pooled connections
 * per request and deadlock under load.)
 */
import { buildAad, decryptJson, encryptJson, readKeyVersion, type DataKeyProvider } from '@avanvu/core';

export interface SealContext {
  table: string;
  column: string;
  rowId: string;
  userId: string;
  /** Schema version of the sealed payload, for example `athlete_profile_v1`. */
  schemaVersion: string;
}

/** A sealer bound to one user's already-loaded key. No database access. */
export class UserSealer {
  constructor(
    private readonly userId: string,
    private readonly latest: { key: CryptoKey; keyVersion: number },
    private readonly resolveOlder: (keyVersion: number) => Promise<CryptoKey>,
  ) {}

  async seal(ctx: Omit<SealContext, 'userId'>, value: unknown): Promise<Uint8Array> {
    return encryptJson(
      value,
      this.latest.key,
      this.latest.keyVersion,
      buildAad({ ...ctx, userId: this.userId }),
    );
  }

  async open<T>(ctx: Omit<SealContext, 'userId'>, envelope: Uint8Array | Buffer): Promise<T> {
    const bytes = new Uint8Array(envelope);
    const version = readKeyVersion(bytes);
    // After a key rotation an older version may need a lookup; that path is outside hot transactions.
    const key = version === this.latest.keyVersion ? this.latest.key : await this.resolveOlder(version);
    return decryptJson<T>(bytes, key, buildAad({ ...ctx, userId: this.userId }));
  }
}

export class Sealer {
  constructor(private readonly keys: DataKeyProvider) {}

  /** Load (or create) the user's key. Call before opening a transaction. */
  async forUser(userId: string): Promise<UserSealer> {
    const latest = await this.keys.getKey(userId);
    return new UserSealer(userId, latest, async (v) => (await this.keys.getKey(userId, v)).key);
  }

  async seal(ctx: SealContext, value: unknown): Promise<Uint8Array> {
    const { userId, ...rest } = ctx;
    return (await this.forUser(userId)).seal(rest, value);
  }

  async open<T>(ctx: SealContext, envelope: Uint8Array | Buffer): Promise<T> {
    const { userId, ...rest } = ctx;
    return (await this.forUser(userId)).open<T>(rest, envelope);
  }
}
