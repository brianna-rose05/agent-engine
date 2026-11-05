import type { Db } from "./db";

/**
 * The database the running app uses. Template file: do not edit.
 * - DATABASE_URL set: that Postgres (production: the project's own database). The first use applies the auth
 *   shim and any new migrations (src/lib/migrate.ts), so a fresh, empty database just works.
 * - Not set: local mode, a PGlite database with the migrations applied (in PGLITE_DATA_DIR if set,
 *   otherwise in memory). Lets the app run, and be checked, without any accounts.
 */
const g = globalThis as unknown as { __appDb?: Promise<Db> };

export function isLocalMode(): boolean {
  return !process.env.DATABASE_URL;
}

export function getDb(): Promise<Db> {
  if (!g.__appDb) {
    const opening: Promise<Db> = isLocalMode()
      ? import("./pglite").then((m) => m.openPglite(process.env.PGLITE_DATA_DIR || undefined)).then((x) => x.db)
      : import("./db-postgres").then((m) => m.openPostgres());
    g.__appDb = opening;
    // A failed open (database unreachable, a migration error) is retried by the next request, not cached.
    opening.catch(() => {
      if (g.__appDb === opening) g.__appDb = undefined;
    });
  }
  return g.__appDb;
}
