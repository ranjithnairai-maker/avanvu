/**
 * Object storage port (SPEC §10.2). Buckets are private; the worker writes objects and the API hands out
 * short-lived signed URLs after an ownership check. Paths are server-generated, never client-chosen.
 * The Supabase Storage adapter is an external-API integration and is a placeholder until the project keys
 * exist; MemoryStorage backs tests and local development.
 */
import { AvanvuError } from '@avanvu/core';

export type Bucket = 'audio' | 'jobs' | 'exports' | 'music';

export interface StoredObject {
  path: string;
  bytes: number;
  updatedAt: Date;
}

export interface Storage {
  put(bucket: Bucket, path: string, data: Uint8Array, contentType: string): Promise<void>;
  get(bucket: Bucket, path: string): Promise<Uint8Array | null>;
  delete(bucket: Bucket, path: string): Promise<void>;
  deletePrefix(bucket: Bucket, prefix: string): Promise<number>;
  list(bucket: Bucket, prefix: string): Promise<StoredObject[]>;
  /** Short-lived URL (the API uses 15 minutes). Never logged, never stored. */
  signedUrl(bucket: Bucket, path: string, expiresInSeconds: number): Promise<string>;
}

export class UnconfiguredStorage implements Storage {
  private fail(): never {
    throw new AvanvuError('UPSTREAM_UNAVAILABLE', 'Storage is not configured yet.');
  }
  put = async () => this.fail();
  get = async () => this.fail();
  delete = async () => this.fail();
  deletePrefix = async () => this.fail();
  list = async () => this.fail();
  signedUrl = async () => this.fail();
}

export class MemoryStorage implements Storage {
  private readonly objects = new Map<string, { data: Uint8Array; contentType: string; updatedAt: Date }>();
  /** Test hook: fail the next put with this error. */
  failNextPut: Error | null = null;
  puts = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  private key(bucket: Bucket, path: string) {
    return `${bucket}/${path}`;
  }

  async put(bucket: Bucket, path: string, data: Uint8Array, contentType: string): Promise<void> {
    if (this.failNextPut) {
      const e = this.failNextPut;
      this.failNextPut = null;
      throw e;
    }
    this.puts++;
    this.objects.set(this.key(bucket, path), {
      data: new Uint8Array(data),
      contentType,
      updatedAt: this.now(),
    });
  }

  async get(bucket: Bucket, path: string): Promise<Uint8Array | null> {
    const o = this.objects.get(this.key(bucket, path));
    return o ? new Uint8Array(o.data) : null;
  }

  async delete(bucket: Bucket, path: string): Promise<void> {
    this.objects.delete(this.key(bucket, path));
  }

  async deletePrefix(bucket: Bucket, prefix: string): Promise<number> {
    let n = 0;
    for (const k of [...this.objects.keys()]) {
      if (k.startsWith(this.key(bucket, prefix))) {
        this.objects.delete(k);
        n++;
      }
    }
    return n;
  }

  async list(bucket: Bucket, prefix: string): Promise<StoredObject[]> {
    const start = this.key(bucket, prefix);
    return [...this.objects.entries()]
      .filter(([k]) => k.startsWith(start))
      .map(([k, o]) => ({
        path: k.slice(bucket.length + 1),
        bytes: o.data.byteLength,
        updatedAt: o.updatedAt,
      }));
  }

  async signedUrl(bucket: Bucket, path: string, expiresInSeconds: number): Promise<string> {
    const exp = Math.floor(this.now().getTime() / 1000) + expiresInSeconds;
    return `memory://${bucket}/${path}?exp=${exp}`;
  }

  /** Test helper: has the signed URL expired? */
  urlExpired(url: string): boolean {
    const exp = Number(new URL(url).searchParams.get('exp'));
    return this.now().getTime() / 1000 > exp;
  }

  count(bucket: Bucket, prefix = ''): number {
    return [...this.objects.keys()].filter((k) => k.startsWith(this.key(bucket, prefix))).length;
  }
}
