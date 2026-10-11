/**
 * Real Postgres (PGlite, WASM) for tests: runs the actual SQL migrations so RLS, grants and constraints
 * are exercised without Docker. The same migrations run under pgTAP in CI against the Supabase stack.
 */
import { PGlite } from '@electric-sql/pglite';
import { Kysely, PostgresDialect } from 'kysely';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '../db/schema';
import type { Db } from '../db/tx';

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, '../../../../supabase/migrations');

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/** A pg.Pool lookalike over one PGlite connection. A mutex keeps interleaved transactions apart. */
function pgPool(pg: PGlite) {
  let tail: Promise<void> = Promise.resolve();
  return {
    async connect() {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const prev = tail;
      tail = prev.then(() => gate);
      await prev;
      return {
        async query(text: string, params?: unknown[]) {
          const r = await pg.query(text, params as never);
          // Kysely reads `command` to decide whether to report affected-row counts.
          return {
            rows: r.rows,
            rowCount: r.affectedRows ?? r.rows.length,
            command: r.command ?? '',
            fields: [],
          };
        },
        release,
      };
    },
    async end() {},
    on() {},
  };
}

export interface TestDb {
  /** Kysely connected as superuser. Use for setup and for assertions that bypass RLS on purpose. */
  admin: Db;
  /** Kysely whose transactions assume the avanvu_api role. */
  api: Db;
  /** Kysely whose transactions assume the avanvu_worker role. */
  worker: Db;
  pg: PGlite;
  close(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const pg = new PGlite({ parsers: { 1082: (v: string) => v, 1114: (v: string) => v } });
  // Supabase ships these roles; create them so the "no access to app" assertions are meaningful.
  await pg.exec('create role anon nologin; create role authenticated nologin;');
  for (const f of migrationFiles()) await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
  const kysely = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: pgPool(pg) as never }),
  });
  return {
    admin: { kysely, role: null },
    api: { kysely, role: 'avanvu_api' },
    worker: { kysely, role: 'avanvu_worker' },
    pg,
    close: async () => {
      await kysely.destroy();
      await pg.close();
    },
  };
}
