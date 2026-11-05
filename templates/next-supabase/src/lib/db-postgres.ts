import postgres from "postgres";
import type { Db } from "./db";
import { advisoryXactLock, migrate, type SqlRunner } from "./migrate";

/** Production Db: a Postgres connection (DATABASE_URL), for example the project's Neon database. Server only. */
export function postgresDb(url = process.env.DATABASE_URL): Db {
  return wrapPostgres(connect(url));
}

function connect(url: string | undefined) {
  if (!url) throw new Error("DATABASE_URL is not set");
  // prepare: false works through transaction-mode poolers (Neon's pooled URL, Supabase's pooler). Serverless runs
  // many small instances: few connections each, closed when idle, so they don't use up the server's limit.
  // The shim's "already exists, skipping" notices are not worth a log line on every cold start.
  return postgres(url, { prepare: false, max: 5, idle_timeout: 20, onnotice: () => {} });
}

function wrapPostgres(run: postgres.Sql | postgres.TransactionSql): Db {
  return {
    async query<T>(text: string, params: unknown[] = []) {
      const rows = await run.unsafe(text, params as postgres.ParameterOrJSON<never>[]);
      return { rows: rows as unknown as T[] };
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      if ("begin" in run) return (await run.begin((tx) => fn(wrapPostgres(tx)))) as T;
      return fn(wrapPostgres(run));
    },
  };
}

/** The connection as migrate (src/lib/migrate.ts) uses it. */
export function postgresRunner(run: postgres.Sql | postgres.TransactionSql): SqlRunner {
  return {
    exec: (sql) => run.unsafe(sql).simple(),
    query: async <T>(sql: string, params: unknown[] = []) =>
      ({ rows: (await run.unsafe(sql, params as postgres.ParameterOrJSON<never>[])) as unknown as T[] }),
  };
}

/**
 * Opens the production database and brings it up to date first (auth shim + new migrations), in one
 * transaction under an advisory lock: servers that cold-start together wait for each other, and a failed
 * migration leaves the database as it was (the next request tries again).
 */
export async function openPostgres(url = process.env.DATABASE_URL): Promise<Db> {
  const sql = connect(url);
  try {
    await sql.begin((tx) => migrate(postgresRunner(tx), { lock: advisoryXactLock }));
  } catch (e) {
    await sql.end({ timeout: 5 }).catch(() => {});
    throw e;
  }
  return wrapPostgres(sql);
}
