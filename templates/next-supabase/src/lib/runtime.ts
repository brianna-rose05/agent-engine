import type { Db } from "./db";

/**
 * The database the running app uses. Template file: do not edit.
 * - DATABASE_URL set: the Supabase Postgres (production).
 * - Not set: local mode, a PGlite database with the migrations applied (in PGLITE_DATA_DIR if set,
 *   otherwise in memory). Lets the app run, and be checked, without any accounts.
 */
const g = globalThis as unknown as { __appDb?: Promise<Db> };

export function isLocalMode(): boolean {
  return !process.env.DATABASE_URL;
}

export function getDb(): Promise<Db> {
  g.__appDb ??= isLocalMode()
    ? import("./pglite").then((m) => m.openPglite(process.env.PGLITE_DATA_DIR || undefined)).then((x) => x.db)
    : import("./db-postgres").then((m) => m.postgresDb());
  return g.__appDb;
}
