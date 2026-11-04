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
  });
});
