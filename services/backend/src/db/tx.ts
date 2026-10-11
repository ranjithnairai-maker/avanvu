/**
 * Transaction helpers (SPEC §10.2). Every query runs inside one of these two wrappers:
 *  - withUserTx(userId, fn): API request on behalf of one athlete. Sets `app.user_id`.
 *  - withSystemTx(actor, fn): worker, webhook and scheduler code. Sets `app.actor`.
 * Settings are transaction-local (`set_config(..., true)`), so a pooled connection never leaks identity.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from './schema';

export type SystemActor = 'worker' | 'webhook' | 'system' | 'api_system';

export interface Db {
  readonly kysely: Kysely<DB>;
  /**
   * Role to assume inside each transaction. Production connects directly as avanvu_api or
   * avanvu_worker so this is null; tests connect as a superuser and set it to prove RLS.
   */
  readonly role: string | null;
}

export type Tx = Transaction<DB>;

async function begin(trx: Tx, role: string | null, userId: string, actor: string): Promise<void> {
  if (role) {
    if (!/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error('invalid role name');
    await sql.raw(`set local role ${role}`).execute(trx);
  }
  await sql`select set_config('app.user_id', ${userId}, true), set_config('app.actor', ${actor}, true)`.execute(
    trx,
  );
}

export function withUserTx<T>(db: Db, userId: string, fn: (trx: Tx) => Promise<T>): Promise<T> {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error('withUserTx requires a user id');
  return db.kysely.transaction().execute(async (trx) => {
    await begin(trx, db.role, userId, 'user');
    return fn(trx);
  });
}

export function withSystemTx<T>(db: Db, actor: SystemActor, fn: (trx: Tx) => Promise<T>): Promise<T> {
  return db.kysely.transaction().execute(async (trx) => {
    await begin(trx, db.role, '', actor);
    return fn(trx);
  });
}
