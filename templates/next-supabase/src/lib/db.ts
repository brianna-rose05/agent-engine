/**
 * The one way app code talks to the database. Server functions take a `Db` as their first argument,
 * so the same code runs against Supabase Postgres in production and an in-memory Postgres in tests.
 * Always use $1, $2... parameters; never build SQL from user input.
 */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Runs fn atomically: if it throws, nothing it wrote is kept. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

/** The signed-in user, as the server sees them. Server functions receive this; they never read cookies. */
export type Actor = { userId: string };
