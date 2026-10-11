/** Filesystem storage for local development only: objects live under `.dev-storage/{bucket}/{path}`. */
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import type { Bucket, Storage, StoredObject } from '../ports/storage';

export class FileStorage implements Storage {
  constructor(
    private readonly root: string,
    private readonly publicBase: string,
  ) {}

  private file(bucket: Bucket, path: string): string {
    const full = normalize(join(this.root, bucket, path));
    if (!full.startsWith(normalize(join(this.root, bucket)))) throw new Error('path escapes the bucket');
    return full;
  }

  async put(bucket: Bucket, path: string, data: Uint8Array): Promise<void> {
    const f = this.file(bucket, path);
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, data);
  }

  async get(bucket: Bucket, path: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.file(bucket, path)));
    } catch {
      return null;
    }
  }

  async delete(bucket: Bucket, path: string): Promise<void> {
    await rm(this.file(bucket, path), { force: true });
  }

  async deletePrefix(bucket: Bucket, prefix: string): Promise<number> {
    const objects = await this.list(bucket, prefix);
    for (const o of objects) await this.delete(bucket, o.path);
    return objects.length;
  }

  async list(bucket: Bucket, prefix: string): Promise<StoredObject[]> {
    const base = join(this.root, bucket);
    const out: StoredObject[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(dir, e);
        const s = await stat(p);
        if (s.isDirectory()) await walk(p);
        else {
          const rel = p.slice(base.length + 1).replaceAll('\\', '/');
          if (rel.startsWith(prefix)) out.push({ path: rel, bytes: s.size, updatedAt: s.mtime });
        }
      }
    };
    await walk(base);
    return out;
  }

  async signedUrl(bucket: Bucket, path: string, expiresInSeconds: number): Promise<string> {
    return `${this.publicBase}/dev-storage/${bucket}/${path}?exp=${Math.floor(Date.now() / 1000) + expiresInSeconds}`;
  }
}
