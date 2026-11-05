import { PGlite, type Transaction } from "@electric-sql/pglite";
import type { Db } from "./db";
import { migrate, type SqlRunner } from "./migrate";

/**
 * A Postgres that runs inside Node (PGlite) with the project's migrations applied. Tests use a fresh one
 * each time (src/test/db.ts); the running app uses one when no DATABASE_URL is set (local mode, see
 * src/lib/runtime.ts). Template file: do not edit.
 */

export function wrapPglite(run: PGlite | Transaction): Db {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const r = await run.query<T>(sql, params);
      return { rows: r.rows };
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      if (run instanceof PGlite) return (await run.transaction((tx) => fn(wrapPglite(tx)))) as T;
      return fn(wrapPglite(run));
    },
  };
}

/** The connection as migrate (src/lib/migrate.ts) uses it. */
export function pgliteRunner(run: PGlite | Transaction): SqlRunner {
  return { exec: (sql) => run.exec(sql), query: (sql, params) => run.query(sql, params) };
}

/** Opens PGlite (in memory, or in `dataDir` so data survives restarts) and applies new migrations in order. */
export async function openPglite(dataDir?: string): Promise<{ pg: PGlite; db: Db }> {
  const pg = new PGlite(dataDir);
  await migrate(pgliteRunner(pg));
  return { pg, db: wrapPglite(pg) };
}
