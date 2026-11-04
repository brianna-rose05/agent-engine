import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import type { Db } from "./db";

/**
 * A Postgres that runs inside Node (PGlite) with the project's migrations applied. Tests use a fresh one
 * each time (src/test/db.ts); the running app uses one when no DATABASE_URL is set (local mode, see
 * src/lib/runtime.ts). Template file: do not edit.
 */
const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

/** Just enough of Supabase's auth schema for migrations and policies to run without Supabase. */
const AUTH_SHIM = `
  create schema if not exists auth;
  create table if not exists auth.users (id uuid primary key, email text unique);
  create or replace function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  end $$;
  create schema if not exists app_meta;
  create table if not exists app_meta.migrations (name text primary key);
`;

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

/** Opens PGlite (in memory, or in `dataDir` so data survives restarts) and applies new migrations in order. */
export async function openPglite(dataDir?: string): Promise<{ pg: PGlite; db: Db }> {
  const pg = new PGlite(dataDir);
  await pg.exec(AUTH_SHIM);
  const done = new Set((await pg.query<{ name: string }>("select name from app_meta.migrations")).rows.map((r) => r.name));
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    try {
      await pg.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
      await pg.query("insert into app_meta.migrations (name) values ($1)", [f]);
    } catch (e) {
      throw new Error(`migration ${f} failed: ${(e as Error).message}`);
    }
  }
  return { pg, db: wrapPglite(pg) };
}
