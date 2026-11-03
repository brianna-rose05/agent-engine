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
