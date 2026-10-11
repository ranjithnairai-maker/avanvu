import { describe, expect, it } from 'vitest';
import {
  InMemoryDataKeyProvider,
  buildAad,
  decryptJson,
  decryptValue,
  encryptJson,
  encryptValue,
  generateRawDataKey,
  importDataKey,
  readKeyVersion,
} from './crypto';

const aad = buildAad({
  table: 'intake_turns',
  column: 'content',
  rowId: 'r1',
  userId: 'u1',
  schemaVersion: 'v1',
});
const plain = new TextEncoder().encode('fictional athlete text');

describe('envelope encryption', () => {
  it('round-trips and records key version', async () => {
    const key = await importDataKey(await generateRawDataKey());
    const env = await encryptValue(plain, key, 7, aad);
    expect(env[0]).toBe(0x01);
    expect(readKeyVersion(env)).toBe(7);
    expect(new TextDecoder().decode(await decryptValue(env, key, aad))).toBe('fictional athlete text');
  });

  it('uses a fresh nonce each time', async () => {
    const key = await importDataKey(await generateRawDataKey());
    const a = await encryptValue(plain, key, 1, aad);
    const b = await encryptValue(plain, key, 1, aad);
    expect(a).not.toEqual(b);
  });

  it('fails on tampered ciphertext', async () => {
    const key = await importDataKey(await generateRawDataKey());
    const env = await encryptValue(plain, key, 1, aad);
    env[env.length - 1] = (env[env.length - 1] ?? 0) ^ 0xff;
    await expect(decryptValue(env, key, aad)).rejects.toThrow();
  });

  it('fails with wrong AAD (copied to another row or user)', async () => {
    const key = await importDataKey(await generateRawDataKey());
    const env = await encryptValue(plain, key, 1, aad);
    const other = buildAad({
      table: 'intake_turns',
      column: 'content',
      rowId: 'r1',
      userId: 'u2',
      schemaVersion: 'v1',
    });
    await expect(decryptValue(env, key, other)).rejects.toThrow();
  });

  it('fails with the wrong key', async () => {
    const k1 = await importDataKey(await generateRawDataKey());
    const k2 = await importDataKey(await generateRawDataKey());
    const env = await encryptValue(plain, k1, 1, aad);
    await expect(decryptValue(env, k2, aad)).rejects.toThrow();
  });

  it('rejects unknown formats and short input', () => {
    expect(() => readKeyVersion(new Uint8Array(3))).toThrow();
    const bad = new Uint8Array(40);
    bad[0] = 9;
    expect(() => readKeyVersion(bad)).toThrow();
  });

  it('round-trips JSON via the in-memory provider, isolated per user', async () => {
    const p = new InMemoryDataKeyProvider();
    const { key, keyVersion } = await p.getKey('u1');
    const env = await encryptJson({ a: 1 }, key, keyVersion, aad);
    expect(await decryptJson(env, key, aad)).toEqual({ a: 1 });
    const other = await p.getKey('u2');
    await expect(decryptJson(env, other.key, aad)).rejects.toThrow();
  });
});
