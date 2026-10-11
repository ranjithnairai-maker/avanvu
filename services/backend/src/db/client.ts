/** Production database client: Kysely over pg through the Supavisor transaction pooler (D-12). */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { DB } from './schema';
import type { Db } from './tx';

export function createDb(connectionString: string): Db {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    // Transaction-pooler mode: prepared statements are off, so queries are sent unnamed (pg's default).
  });
  return { kysely: new Kysely<DB>({ dialect: new PostgresDialect({ pool }) }), role: null };
}

export async function closeDb(db: Db): Promise<void> {
  await db.kysely.destroy();
}
