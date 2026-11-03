import { describe, expect, it } from "vitest";
import { createTestDb, createUser } from "@/test/db";
import { AppError } from "@/lib/errors";
import { createSlot, isSlotOpen, listOpenSlots } from "@/server/slots";

async function setup() {
  const db = await createTestDb();
  const staff = await createUser(db, "staff@example.com");
  const cust = await createUser(db, "c@example.com");
  await db.query("insert into profiles values ($1, 'Sam', 'staff'), ($2, 'Cara', 'customer')", [staff, cust]);
  return { db, staff, cust };
}
const at = (iso: string) => new Date(iso);

describe("slots", () => {
  it("staff create slots; customers can't; duplicates conflict", async () => {
    const { db, staff, cust } = await setup();
    const s = await createSlot(db, { userId: staff }, at("2026-11-10T17:00:00Z"));
    expect(s.startsAt.toISOString()).toBe("2026-11-10T17:00:00.000Z");
    await expect(createSlot(db, { userId: cust }, at("2026-11-10T18:00:00Z"))).rejects.toMatchObject({ code: "forbidden" });
    await expect(createSlot(db, { userId: staff }, at("2026-11-10T17:00:00Z"))).rejects.toBeInstanceOf(AppError);
  });

  it("lists a local day's open slots, earliest first", async () => {
    const { db, staff, cust } = await setup();
    const late = await createSlot(db, { userId: staff }, at("2026-11-11T01:30:00Z")); // 5:30 PM Nov 10 in LA
    const early = await createSlot(db, { userId: staff }, at("2026-11-10T17:00:00Z")); // 9:00 AM Nov 10
    const taken = await createSlot(db, { userId: staff }, at("2026-11-10T18:00:00Z"));
    await createSlot(db, { userId: staff }, at("2026-11-11T17:00:00Z")); // Nov 11
    await db.query("insert into bookings (slot_id, customer_id, pet_name) values ($1, $2, 'Rex')", [taken.id, cust]);
    const open = await listOpenSlots(db, "2026-11-10", "America/Los_Angeles");
    expect(open.map((s) => s.id)).toEqual([early.id, late.id]);
  });

  it("cancelled bookings free the slot; past slots aren't open", async () => {
    const { db, staff, cust } = await setup();
    const s = await createSlot(db, { userId: staff }, at("2026-11-10T17:00:00Z"));
    await db.query("insert into bookings (slot_id, customer_id, pet_name, status) values ($1, $2, 'Rex', 'cancelled')", [s.id, cust]);
    expect(await isSlotOpen(db, s.id, at("2026-11-09T00:00:00Z"))).toBe(true);
    expect(await isSlotOpen(db, s.id, at("2026-11-10T17:00:00Z"))).toBe(false);
    expect((await listOpenSlots(db, "2026-11-10", "America/Los_Angeles")).length).toBe(1);
  });
});
