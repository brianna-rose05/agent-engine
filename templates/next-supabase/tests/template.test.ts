import { describe, expect, it } from "vitest";
import { createTestDb, createUser } from "@/test/db";

describe("template test database", () => {
  it("applies migrations and supports auth users", async () => {
    const db = await createTestDb();
    const id = await createUser(db, "a@example.com");
    const { rows } = await db.query<{ email: string }>("select email from auth.users where id = $1", [id]);
    expect(rows[0].email).toBe("a@example.com");
    await expect(db.transaction(async (tx) => {
      await tx.query("insert into auth.users (id, email) values (gen_random_uuid(), 'b@example.com')");
      throw new Error("roll back");
    })).rejects.toThrow("roll back");
    expect((await db.query("select * from auth.users")).rows).toHaveLength(1);
    await db.close();
  });
});

describe("template sign-in (local mode)", () => {
  const jar = () => {
    const m = new Map<string, string>();
    return {
      m,
      get: (n: string) => (m.has(n) ? { value: m.get(n)! } : undefined),
      set: (n: string, v: string) => m.set(n, v),
      delete: (n: string) => m.delete(n),
    };
  };

  it("signs up, keeps the session in a signed cookie, signs in and out", async () => {
    const { localAuth } = await import("@/lib/auth");
    const db = await createTestDb();
    const c = jar();
    const auth = localAuth(db, c);
    const { userId } = await auth.signUp(" Sam@Example.com ", "secret-pw");
    expect(await auth.currentUserId()).toBe(userId);
    const { rows } = await db.query<{ email: string }>("select email from auth.users where id = $1", [userId]);
    expect(rows[0].email).toBe("sam@example.com");                       // a real auth.users row for foreign keys
    await expect(auth.signUp("sam@example.com", "another-pw")).rejects.toMatchObject({ code: "conflict" });
    await expect(auth.signUp("x@example.com", "short")).rejects.toMatchObject({ code: "invalid" });

    await auth.signOut();
    expect(await auth.currentUserId()).toBeNull();
    await expect(auth.signIn("sam@example.com", "wrong-pw")).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(auth.signIn("nobody@example.com", "secret-pw")).rejects.toMatchObject({ code: "unauthenticated" });
    expect((await auth.signIn("SAM@example.com", "secret-pw")).userId).toBe(userId);

    await auth.changePassword("new-secret");
    await auth.signOut();
    await expect(auth.signIn("sam@example.com", "secret-pw")).rejects.toMatchObject({ code: "unauthenticated" });
    await auth.signIn("sam@example.com", "new-secret");
    await db.close();
  });

  it("rejects a tampered or expired session cookie", async () => {
    const { localAuth } = await import("@/lib/auth");
    const db = await createTestDb();
    const c = jar();
    let t = Date.now();
    const auth = localAuth(db, c, () => t);
    const { userId } = await auth.signUp("a@example.com", "secret-pw");
    const raw = c.m.get("app_session")!;
    const other = await createUser(db, "b@example.com");
    c.m.set("app_session", raw.replace(userId, other));                  // pretend to be someone else
    expect(await auth.currentUserId()).toBeNull();
    c.m.set("app_session", raw);
    expect(await auth.currentUserId()).toBe(userId);
    t += 8 * 24 * 3600 * 1000;                                           // sessions last a week
    expect(await auth.currentUserId()).toBeNull();
    await db.close();
  });

  it("re-opening a saved database applies only new migrations", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { openPglite } = await import("@/lib/pglite");
    const dir = mkdtempSync(join(tmpdir(), "pglite-"));
    const a = await openPglite(dir);
    await createUser(a.db, "keep@example.com");
    await a.pg.close();
    const b = await openPglite(dir);                                      // would fail if migrations ran twice
    expect((await b.db.query("select * from auth.users")).rows).toHaveLength(1);
    await b.pg.close();
  }, 90_000);   // opens a database on disk twice; regression (first ship of Pawfect): over 20s in a busy sandbox
});

describe("template migrations (shared by local mode and production Postgres)", () => {
  const tmpMigrations = async (files: Record<string, string>) => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "migrations-"));
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return { dir, add: (name: string, body: string) => writeFileSync(join(dir, name), body) };
  };

  it("applies new migrations in order, records them, and a second run applies nothing", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { migrate } = await import("@/lib/migrate");
    const { pgliteRunner } = await import("@/lib/pglite");
    const m = await tmpMigrations({
      "0002_b.sql": "alter table things add column note text;",
      "0001_a.sql": "create table things (id uuid primary key default gen_random_uuid(), owner uuid references auth.users(id));",
      "README.md": "not a migration",
    });
    const pg = new PGlite();
    const run = pgliteRunner(pg);
    expect(await migrate(run, { dir: m.dir })).toEqual(["0001_a.sql", "0002_b.sql"]);
    expect(await migrate(run, { dir: m.dir })).toEqual([]);              // shim re-runs cleanly, nothing re-applied
    m.add("0003_c.sql", "create index things_owner on things (owner);");
    expect(await migrate(run, { dir: m.dir })).toEqual(["0003_c.sql"]);
    const { rows } = await pg.query<{ name: string }>("select name from app_meta.migrations order by name");
    expect(rows.map((r) => r.name)).toEqual(["0001_a.sql", "0002_b.sql", "0003_c.sql"]);
    await pg.close();
  });

  it("names the migration that failed", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { migrate } = await import("@/lib/migrate");
    const { pgliteRunner } = await import("@/lib/pglite");
    const m = await tmpMigrations({ "0001_bad.sql": "create table oops (;" });
    const pg = new PGlite();
    await expect(migrate(pgliteRunner(pg), { dir: m.dir })).rejects.toThrow(/migration 0001_bad\.sql failed/);
    await pg.close();
  });

  it("production path: takes the lock first, holds the advisory lock for the whole transaction", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { advisoryXactLock, migrate } = await import("@/lib/migrate");
    const { pgliteRunner } = await import("@/lib/pglite");
    const m = await tmpMigrations({ "0001_a.sql": "create table a (id int primary key);" });
    const pg = new PGlite();
    const seen: string[] = [];
    let locksDuring = -1;
    await pg.transaction(async (tx) => {
      const inner = pgliteRunner(tx);
      const spy = {
        exec: (sql: string) => (seen.push(sql.trim().split("\n")[0]), inner.exec(sql)),
        query: <T,>(sql: string, params?: unknown[]) => (seen.push(sql), inner.query<T>(sql, params)),
      };
      await migrate(spy, { dir: m.dir, lock: advisoryXactLock });
      locksDuring = (await tx.query<{ n: number }>(
        "select count(*)::int as n from pg_locks where locktype = 'advisory' and granted")).rows[0].n;
    });
    expect(seen[0]).toMatch(/^select pg_advisory_xact_lock\(\d+\)$/);    // before the shim or any migration
    expect(locksDuring).toBe(1);
    const after = await pg.query<{ n: number }>("select count(*)::int as n from pg_locks where locktype = 'advisory'");
    expect(after.rows[0].n).toBe(0);                                      // released at commit
    await pg.close();
  });

  it("the lock is pluggable and runs before anything else", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { migrate } = await import("@/lib/migrate");
    const { pgliteRunner } = await import("@/lib/pglite");
    const m = await tmpMigrations({ "0001_a.sql": "select 1;" });
    const pg = new PGlite();
    const order: string[] = [];
    const inner = pgliteRunner(pg);
    const spy = { exec: (s: string) => (order.push("exec"), inner.exec(s)), query: inner.query };
    await migrate(spy, { dir: m.dir, lock: async () => void order.push("lock") });
    expect(order[0]).toBe("lock");
    expect(order.length).toBeGreaterThan(1);
    await pg.close();
  });

  it("the shim keeps an existing auth.uid() (a real Supabase database) and is safe to run twice", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { AUTH_SHIM } = await import("@/lib/migrate");
    const pg = new PGlite();
    await pg.exec("create schema auth; create function auth.uid() returns uuid language sql stable as $$ select '00000000-0000-0000-0000-000000000001'::uuid $$;");
    await pg.exec(AUTH_SHIM);
    await pg.exec(AUTH_SHIM);
    expect((await pg.query<{ id: string }>("select auth.uid() as id")).rows[0].id).toBe("00000000-0000-0000-0000-000000000001");
    await pg.close();
  });
});

describe("template owner setup (src/lib/owner.ts)", () => {
  const withEnv = async (vars: Record<string, string | undefined>, fn: () => Promise<void>) => {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    const put = (k: string, v: string | undefined) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    for (const [k, v] of Object.entries(vars)) put(k, v);
    try {
      await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) put(k, v);
    }
  };
  const local = { APP_SETUP_CODE: undefined, DATABASE_URL: undefined };

  it("local mode without a code: open, any code claims, then claimed; isOwner/requireOwner follow", async () => {
    const { claimOwner, getOwnerId, isOwner, ownerSetupState, requireOwner } = await import("@/lib/owner");
    await withEnv(local, async () => {
      const db = await createTestDb();
      const a = { userId: await createUser(db, "a@example.com") };
      const b = { userId: await createUser(db, "b@example.com") };
      expect(await ownerSetupState(db)).toBe("open");
      expect(await getOwnerId(db)).toBeNull();
      expect(await isOwner(db, a)).toBe(false);
      expect(await isOwner(db, null)).toBe(false);
      await expect(requireOwner(db, a)).rejects.toMatchObject({ code: "forbidden", message: "Only the owner can do this." });
      await claimOwner(db, a, "anything");
      expect(await ownerSetupState(db)).toBe("claimed");
      expect(await getOwnerId(db)).toBe(a.userId);
      expect(await isOwner(db, a)).toBe(true);
      expect(await isOwner(db, b)).toBe(false);
      await requireOwner(db, a);
      await expect(requireOwner(db, b)).rejects.toMatchObject({ code: "forbidden" });
      await expect(claimOwner(db, b, "anything")).rejects.toMatchObject(
        { code: "conflict", message: "This app already has an owner." });
      await expect(claimOwner(db, a, "anything")).rejects.toMatchObject({ code: "conflict" });
      expect(await getOwnerId(db)).toBe(a.userId);                         // the second claim changed nothing
      await db.close();
    });
  });

  it("with APP_SETUP_CODE: a wrong code is refused; the right one (any case, spaces around) claims", async () => {
    const { claimOwner, getOwnerId, ownerSetupState } = await import("@/lib/owner");
    await withEnv({ APP_SETUP_CODE: "K7PQ-M2XR-9TVD", DATABASE_URL: "postgres://x/y" }, async () => {
      const db = await createTestDb();
      const a = { userId: await createUser(db, "a@example.com") };
      expect(await ownerSetupState(db)).toBe("open");
      for (const wrong of ["", "K7PQ-M2XR-9TVE", "K7PQ-M2XR-9TV", "K7PQ-M2XR-9TVDX"]) {
        await expect(claimOwner(db, a, wrong)).rejects.toMatchObject(
          { code: "forbidden", message: "That setup code isn't right." });
      }
      expect(await getOwnerId(db)).toBeNull();
      await claimOwner(db, a, "  k7pq-m2xr-9tvd \n");
      expect(await getOwnerId(db)).toBe(a.userId);
      expect(await ownerSetupState(db)).toBe("claimed");
      await db.close();
    });
  });

  it("local mode with APP_SETUP_CODE still requires the code", async () => {
    const { claimOwner, getOwnerId } = await import("@/lib/owner");
    await withEnv({ APP_SETUP_CODE: "ABCD-EFGH-JKMN", DATABASE_URL: undefined }, async () => {
      const db = await createTestDb();
      const a = { userId: await createUser(db, "a@example.com") };
      await expect(claimOwner(db, a, "nope")).rejects.toMatchObject({ code: "forbidden" });
      await claimOwner(db, a, "abcd-efgh-jkmn");
      expect(await getOwnerId(db)).toBe(a.userId);
      await db.close();
    });
  });

  it("a deployed app (DATABASE_URL) without a code is not configured and refuses every claim", async () => {
    const { claimOwner, getOwnerId, ownerSetupState } = await import("@/lib/owner");
    await withEnv({ APP_SETUP_CODE: "   ", DATABASE_URL: "postgres://x/y" }, async () => {
      const db = await createTestDb();
      const a = { userId: await createUser(db, "a@example.com") };
      expect(await ownerSetupState(db)).toBe("not_configured");
      await expect(claimOwner(db, a, "")).rejects.toMatchObject(
        { code: "forbidden", message: "Owner setup isn't configured for this app." });
      await expect(claimOwner(db, a, "K7PQ-M2XR-9TVD")).rejects.toMatchObject({ code: "forbidden" });
      expect(await getOwnerId(db)).toBeNull();
      await db.close();
    });
  });

  it("two claims at the same moment: exactly one wins", async () => {
    const { claimOwner, getOwnerId } = await import("@/lib/owner");
    await withEnv(local, async () => {
      const db = await createTestDb();
      const ids = await Promise.all(["a", "b", "c", "d"].map((n) => createUser(db, `${n}@example.com`)));
      const results = await Promise.allSettled(ids.map((userId) => claimOwner(db, { userId }, "x")));
      const won = results.filter((r) => r.status === "fulfilled");
      const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(won).toHaveLength(1);
      expect(lost.map((r) => r.reason.code)).toEqual(["conflict", "conflict", "conflict"]);
      expect(await getOwnerId(db)).toBe(ids[results.findIndex((r) => r.status === "fulfilled")]);
      expect((await db.query("select * from app_owner.owner")).rows).toHaveLength(1);
      await db.close();
    });
  });

  it("the owner survives re-opening a saved database (the table is created once, on first use)", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { openPglite } = await import("@/lib/pglite");
    const { claimOwner, getOwnerId } = await import("@/lib/owner");
    await withEnv(local, async () => {
      const dir = mkdtempSync(join(tmpdir(), "pglite-owner-"));
      const a = await openPglite(dir);
      const userId = await createUser(a.db, "keep@example.com");
      await claimOwner(a.db, { userId }, "x");
      await a.pg.close();
      const b = await openPglite(dir);
      expect(await getOwnerId(b.db)).toBe(userId);
      await b.pg.close();
    });
  }, 90_000);   // a database on disk, opened twice: over 20s in a busy sandbox
});
