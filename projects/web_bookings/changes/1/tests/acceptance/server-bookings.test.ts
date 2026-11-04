import { describe, expect, it } from "vitest";
import { createTestDb, createUser } from "@/test/db";
import { bookSlot } from "@/server/bookings";

const NOW = new Date("2026-11-08T17:00:00Z");

async function setup() {
  const db = await createTestDb();
  const staff = await createUser(db, "s@example.com");
  const a = await createUser(db, "a@example.com");
  const { rows } = await db.query<{ id: string }>(
    "insert into slots (starts_at, created_by) values ('2026-11-10T17:00:00Z', $1), ('2026-11-11T17:00:00Z', $1) returning id",
    [staff],
  );
  return { db, a, slot: rows[0].id, other: rows[1].id };
}

describe("pet names up to 40 characters", () => {
  it("rejects a 41-character pet name", async () => {
    const { db, a, slot } = await setup();
    await expect(bookSlot(db, { userId: a }, { slotId: slot, petName: "x".repeat(41) }, NOW))
      .rejects.toMatchObject({ code: "invalid" });
  });

  it("accepts exactly 40 characters, after trimming", async () => {
    const { db, a, slot } = await setup();
    const bk = await bookSlot(db, { userId: a }, { slotId: slot, petName: `  ${"y".repeat(40)}  ` }, NOW);
    expect(bk.petName).toBe("y".repeat(40));
  });

  it("still rejects an empty pet name", async () => {
    const { db, a, other } = await setup();
    await expect(bookSlot(db, { userId: a }, { slotId: other, petName: "   " }, NOW)).rejects.toMatchObject({ code: "invalid" });
  });
});
