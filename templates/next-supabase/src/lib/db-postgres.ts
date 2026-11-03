import postgres from "postgres";
import type { Db } from "./db";

/** Production Db: a direct Postgres connection to the Supabase database (DATABASE_URL). Server only. */
export function postgresDb(url = process.env.DATABASE_URL): Db {
  if (!url) throw new Error("DATABASE_URL is not set");
  const sql = postgres(url, { prepare: false });
  const wrap = (run: typeof sql | postgres.TransactionSql): Db => ({
    async query<T>(text: string, params: unknown[] = []) {
      const rows = await run.unsafe(text, params as postgres.ParameterOrJSON<never>[]);
      return { rows: rows as unknown as T[] };
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      if ("begin" in run) return (await run.begin((tx) => fn(wrap(tx)))) as T;
      return fn(wrap(run));
    },
  });
  return wrap(sql);
}
