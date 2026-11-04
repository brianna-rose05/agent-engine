import type { Db } from "@/lib/db";
import { openPglite } from "@/lib/pglite";

/**
 * A fresh, empty Postgres with every migration in supabase/migrations applied, in file-name order.
 * Use one per test (they're fast): `const db = await createTestDb();`
 */
export async function createTestDb(): Promise<Db & { close(): Promise<void> }> {
  const { pg, db } = await openPglite();
  return Object.assign(db, { close: () => pg.close() });
}

/** Adds a user to auth.users (as Supabase Auth would on sign-up) and returns their id. */
export async function createUser(db: Db, email: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id",
    [email],
  );
  return rows[0].id;
}
