/**
 * Key-wrapping abstraction (CONTRACTS §12, D-04). Production wraps per-user data keys with Cloud KMS using
 * the Cloud Run service identity (no key files). `LocalKms` is for local development and tests only.
 */
import { AvanvuError } from '@avanvu/core';

export interface KmsClient {
  wrap(plain: Uint8Array, aad: Uint8Array): Promise<{ wrapped: Uint8Array; kmsKeyVersion: string }>;
  unwrap(wrapped: Uint8Array, aad: Uint8Array, kmsKeyVersion: string): Promise<Uint8Array>;
}

/** AES-GCM wrapping under a local master key. Never use outside local and test environments. */
export class LocalKms implements KmsClient {
  private constructor(private readonly master: CryptoKey) {}

  static async create(masterKeyHex?: string): Promise<LocalKms> {
    const raw = masterKeyHex
      ? Uint8Array.from(masterKeyHex.match(/.{2}/g)?.map((h) => parseInt(h, 16)) ?? [])
      : crypto.getRandomValues(new Uint8Array(32));
    if (raw.byteLength !== 32) throw new Error('LOCAL_KMS_MASTER_KEY must be 64 hex characters');
    return new LocalKms(
      await crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']),
    );
  }

  async wrap(plain: Uint8Array, aad: Uint8Array) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: aad as BufferSource },
        this.master,
        plain as BufferSource,
      ),
    );
    const wrapped = new Uint8Array(12 + ct.length);
    wrapped.set(iv);
    wrapped.set(ct, 12);
    return { wrapped, kmsKeyVersion: 'local-1' };
  }

  async unwrap(wrapped: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: wrapped.slice(0, 12), additionalData: aad as BufferSource },
        this.master,
        wrapped.slice(12) as BufferSource,
      ),
    );
  }
}

/**
 * Cloud KMS client. PLACEHOLDER: the real implementation (encrypt/decrypt against KMS_KEY_NAME with the
 * service identity) is an external-API integration and is wired up once the GCP project exists.
 */
export class GcpKms implements KmsClient {
  constructor(private readonly keyName: string) {}

  wrap(): Promise<never> {
    return Promise.reject(
      new AvanvuError('INTERNAL', `Cloud KMS is not wired up (${this.keyName.slice(0, 12)})`),
    );
  }

  unwrap(): Promise<never> {
    return Promise.reject(new AvanvuError('INTERNAL', 'Cloud KMS is not wired up'));
  }
}

export const keyWrapAad = (userId: string): Uint8Array => new TextEncoder().encode(`user:${userId}`);
