import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Brings a database up to date: the auth shim, then every migration in supabase/migrations not yet recorded in
 * app_meta.migrations, in file-name order. Shared by local mode (PGlite, src/lib/pglite.ts) and production
 * Postgres (src/lib/db-postgres.ts). Template file: do not edit.
 */
export const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

/** What migrate needs from a connection: multi-statement SQL without parameters, and parameterized queries. */
export interface SqlRunner {
  exec(sql: string): Promise<unknown>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * Just enough of Supabase's auth schema for migrations and policies to run without Supabase, plus the tables
 * local sign-in uses. Safe to run again, and on a real Supabase database (it never replaces auth.uid()).
 * Creating roles needs CREATEROLE; a managed Postgres without it skips them (migrations that grant to
 * `authenticated` or `anon` then fail with a clear error).
 */
export const AUTH_SHIM = `
  create schema if not exists auth;
  create table if not exists auth.users (id uuid primary key, email text unique);
  do $$ begin
    if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'auth' and p.proname = 'uid') then
      create function auth.uid() returns uuid language sql stable as
        $f$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
    end if;
  end $$;
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  exception when insufficient_privilege then null;
  end $$;
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  exception when insufficient_privilege then null;
  end $$;
  create schema if not exists app_local_auth;
  create table if not exists app_local_auth.accounts (
    user_id uuid primary key, email text unique not null, salt text not null, hash text not null);
  create table if not exists app_local_auth.secret (id int primary key, value text not null);
  create schema if not exists app_meta;
  create table if not exists app_meta.migrations (name text primary key);
`;

/** Taken before anything else, so two servers starting at once don't migrate the same database together. */
export type MigrationLock = (run: SqlRunner) => Promise<void>;

const LOCK_KEY = 7243019151;

/**
 * A Postgres advisory lock held until the end of the current transaction: call migrate inside one. A
 * transaction-scoped lock (not pg_advisory_lock) also works through a transaction-mode pooler such as Neon's
 * pooled connection string, where a session lock and its unlock could land on different server connections.
 */
export const advisoryXactLock: MigrationLock = async (run) => {
  await run.query(`select pg_advisory_xact_lock(${LOCK_KEY})`);
};

/** Applies the shim and new migrations; returns the names of the migrations it applied. */
export async function migrate(run: SqlRunner, opts: { dir?: string; lock?: MigrationLock } = {}): Promise<string[]> {
  const dir = opts.dir ?? MIGRATIONS_DIR;
  if (opts.lock) await opts.lock(run);
  await run.exec(AUTH_SHIM);
  const done = new Set((await run.query<{ name: string }>("select name from app_meta.migrations")).rows.map((r) => r.name));
  const applied: string[] = [];
  // turbopackIgnore: `dir` is only known at runtime, so Turbopack would trace the whole project into every server
  // bundle. next.config.ts ships supabase/migrations explicitly (outputFileTracingIncludes) instead.
  for (const f of readdirSync(/*turbopackIgnore: true*/ dir).filter((x) => x.endsWith(".sql")).sort()) {
    if (done.has(f)) continue;
    try {
      await run.exec(readFileSync(/*turbopackIgnore: true*/ join(/*turbopackIgnore: true*/ dir, f), "utf8"));
      await run.query("insert into app_meta.migrations (name) values ($1)", [f]);
    } catch (e) {
      throw new Error(`migration ${f} failed: ${(e as Error).message}`);
    }
    applied.push(f);
  }
  return applied;
}
