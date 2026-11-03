import { describe, expect, it } from "vitest";
import { createTestDb, createUser } from "@/test/db";
import { bookSlot, cancelBooking } from "@/server/bookings";

const NOW = new Date("2026-11-08T17:00:00Z");

async function setup() {
  const db = await createTestDb();
  const staff = await createUser(db, "s@example.com");
  const a = await createUser(db, "a@example.com");
  const b = await createUser(db, "b@example.com");
  const { rows } = await db.query<{ id: string }>(
    "insert into slots (starts_at, created_by) values ('2026-11-10T17:00:00Z', $1), ('2026-11-09T16:00:00Z', $1) returning id",
    [staff],
  );
  return { db, a, b, slot: rows[0].id, soon: rows[1].id };
}

describe("bookings", () => {
  it("books an open slot once, trimming the pet name", async () => {
    const { db, a, b, slot } = await setup();
    const bk = await bookSlot(db, { userId: a }, { slotId: slot, petName: "  Rex " }, NOW);
    expect(bk).toMatchObject({ slotId: slot, customerId: a, petName: "Rex", status: "booked" });
    await expect(bookSlot(db, { userId: b }, { slotId: slot, petName: "Mo" }, NOW)).rejects.toMatchObject({ code: "conflict" });
  });

  it("rejects bad input and missing slots", async () => {
    const { db, a, slot } = await setup();
    await expect(bookSlot(db, { userId: a }, { slotId: slot, petName: "   " }, NOW)).rejects.toMatchObject({ code: "invalid" });
    await expect(bookSlot(db, { userId: a }, { slotId: "00000000-0000-0000-0000-000000000000", petName: "Rex" }, NOW))
      .rejects.toMatchObject({ code: "not_found" });
  });

  it("cancels own bookings up to exactly 24h before", async () => {
    const { db, a, b, slot, soon } = await setup();
    const bk = await bookSlot(db, { userId: a }, { slotId: slot, petName: "Rex" }, NOW);
    await expect(cancelBooking(db, { userId: b }, bk.id, NOW)).rejects.toMatchObject({ code: "not_found" });
    const at24 = new Date("2026-11-09T17:00:00Z");
    expect((await cancelBooking(db, { userId: a }, bk.id, at24)).status).toBe("cancelled");
    await expect(cancelBooking(db, { userId: a }, bk.id, at24)).rejects.toMatchObject({ code: "conflict" });
    const late = await bookSlot(db, { userId: b }, { slotId: soon, petName: "Mo" }, NOW);
    await expect(cancelBooking(db, { userId: b }, late.id, new Date("2026-11-08T16:01:00Z"))).rejects.toMatchObject({ code: "invalid" });
  });
});
