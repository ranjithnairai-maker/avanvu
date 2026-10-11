/**
 * Envelope encryption (CONTRACTS §12). The only place sensitive values are encrypted.
 * Layout: [0x01][key version u32 BE][12-byte nonce][AES-256-GCM ciphertext + 16-byte tag].
 * Runtime-neutral: WebCrypto only, no Node-only APIs.
 */
const FORMAT_VERSION = 0x01;
const HEADER_BYTES = 1 + 4 + 12;
const TAG_BYTES = 16;

export interface AadParts {
  table: string;
  column: string;
  rowId: string;
  userId: string;
  schemaVersion: string;
}

export function buildAad(p: AadParts): Uint8Array {
  return new TextEncoder().encode(`${p.table}:${p.column}:${p.rowId}:${p.userId}:${p.schemaVersion}`);
}

export async function importDataKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.byteLength !== 32) throw new Error('Data key must be 256 bits');
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function generateRawDataKey(): Promise<Uint8Array> {
  return crypto.getRandomValues(new Uint8Array(32));
}

export async function encryptValue(
  plaintext: Uint8Array,
  key: CryptoKey,
  keyVersion: number,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: aad as BufferSource, tagLength: 128 },
      key,
      plaintext as BufferSource,
    ),
  );
  const out = new Uint8Array(HEADER_BYTES + ct.byteLength);
  out[0] = FORMAT_VERSION;
  new DataView(out.buffer).setUint32(1, keyVersion, false);
  out.set(nonce, 5);
  out.set(ct, HEADER_BYTES);
  return out;
}

export function readKeyVersion(envelope: Uint8Array): number {
  if (envelope.byteLength < HEADER_BYTES + TAG_BYTES) throw new Error('Envelope too short');
  if (envelope[0] !== FORMAT_VERSION) throw new Error('Unsupported envelope format');
  return new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength).getUint32(1, false);
}

export async function decryptValue(
  envelope: Uint8Array,
  key: CryptoKey,
  aad: Uint8Array,
): Promise<Uint8Array> {
  readKeyVersion(envelope);
  const nonce = envelope.slice(5, HEADER_BYTES);
  const ct = envelope.slice(HEADER_BYTES);
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: aad as BufferSource, tagLength: 128 },
      key,
      ct as BufferSource,
    ),
  );
}

export async function encryptJson(
  value: unknown,
  key: CryptoKey,
  keyVersion: number,
  aad: Uint8Array,
): Promise<Uint8Array> {
  return encryptValue(new TextEncoder().encode(JSON.stringify(value)), key, keyVersion, aad);
}

export async function decryptJson<T = unknown>(
  envelope: Uint8Array,
  key: CryptoKey,
  aad: Uint8Array,
): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await decryptValue(envelope, key, aad))) as T;
}

/**
 * Supplies per-user data keys. The production implementation (Cloud KMS unwrap, 5-minute LRU cache)
 * lives in the backend and is an API integration; tests use an in-memory provider.
 */
export interface DataKeyProvider {
  getKey(userId: string, keyVersion?: number): Promise<{ key: CryptoKey; keyVersion: number }>;
}

export class InMemoryDataKeyProvider implements DataKeyProvider {
  private readonly keys = new Map<string, { key: CryptoKey; keyVersion: number }>();

  async getKey(userId: string): Promise<{ key: CryptoKey; keyVersion: number }> {
    let entry = this.keys.get(userId);
    if (!entry) {
      entry = { key: await importDataKey(await generateRawDataKey()), keyVersion: 1 };
      this.keys.set(userId, entry);
    }
    return entry;
  }
}
