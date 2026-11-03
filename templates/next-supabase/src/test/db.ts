import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import type { Db } from "@/lib/db";

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

/** Just enough of Supabase's auth schema for migrations and policies to run in tests. */
const AUTH_SHIM = `
  create schema if not exists auth;
  create table if not exists auth.users (id uuid primary key, email text unique);
  create or replace function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  end $$;
`;

function wrap(run: PGlite | Transaction): Db {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const r = await run.query<T>(sql, params);
      return { rows: r.rows };
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      if (run instanceof PGlite) return (await run.transaction((tx) => fn(wrap(tx)))) as T;
      return fn(wrap(run));
    },
  };
}

/**
 * A fresh, empty Postgres with every migration in supabase/migrations applied, in file-name order.
 * Use one per test (they're fast): `const db = await createTestDb();`
 */
export async function createTestDb(): Promise<Db & { close(): Promise<void> }> {
  const pg = new PGlite();
  await pg.exec(AUTH_SHIM);
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    try {
      await pg.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
    } catch (e) {
      throw new Error(`migration ${f} failed: ${(e as Error).message}`);
    }
  }
  return Object.assign(wrap(pg), { close: () => pg.close() });
}

/** Adds a user to auth.users (as Supabase Auth would on sign-up) and returns their id. */
export async function createUser(db: Db, email: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id",
    [email],
  );
  return rows[0].id;
}
