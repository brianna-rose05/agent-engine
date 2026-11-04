import type { Actor, Db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import type { BookInput, Booking } from "@/contracts/types";
import { isSlotOpen } from "@/server/slots";

type Row = { id: string; slot_id: string; customer_id: string; pet_name: string; status: "booked" | "cancelled" };
const toBooking = (r: Row): Booking => ({
  id: r.id, slotId: r.slot_id, customerId: r.customer_id, petName: r.pet_name, status: r.status,
});
const COLS = "id, slot_id, customer_id, pet_name, status";

/**
 * Book an open slot for the actor's pet. petName is trimmed and must be 1 to 40 characters.
 * Throws AppError "invalid" for a bad pet name, "not_found" if the slot doesn't exist, and "conflict" if the
 * slot isn't open (taken, or starts at or before `now`). Two concurrent requests must never both succeed.
 */
export async function bookSlot(db: Db, actor: Actor, input: BookInput, now: Date): Promise<Booking> {
  const petName = input.petName.trim();
  if (petName.length < 1 || petName.length > 40) throw new AppError("invalid", "Please enter your pet's name.");
  const exists = await db.query("select 1 from slots where id = $1", [input.slotId]);
  if (!exists.rows.length) throw new AppError("not_found", "That time doesn't exist.");
  return db.transaction(async (tx) => {
    if (!(await isSlotOpen(tx, input.slotId, now))) throw new AppError("conflict", "That time isn't available.");
    try {
      const r = await tx.query<Row>(
        `insert into bookings (slot_id, customer_id, pet_name) values ($1, $2, $3) returning ${COLS}`,
        [input.slotId, actor.userId, petName],
      );
      return toBooking(r.rows[0]);
    } catch {
      throw new AppError("conflict", "That time was just taken.");
    }
  });
}

/**
 * Cancel the actor's own booking. Allowed until 24 hours before the slot starts (exactly 24h is allowed).
 * Throws "not_found" if the booking doesn't exist or isn't the actor's, "conflict" if already cancelled,
 * and "invalid" if it's less than 24 hours before the start. Returns the updated booking.
 */
export async function cancelBooking(db: Db, actor: Actor, bookingId: string, now: Date): Promise<Booking> {
  const r = await db.query<Row & { starts_at: Date }>(
    `select b.${COLS.split(", ").join(", b.")}, s.starts_at from bookings b join slots s on s.id = b.slot_id
      where b.id = $1 and b.customer_id = $2`,
    [bookingId, actor.userId],
  );
  const b = r.rows[0];
  if (!b) throw new AppError("not_found", "We couldn't find that booking.");
  if (b.status === "cancelled") throw new AppError("conflict", "That booking is already cancelled.");
  if (new Date(b.starts_at).getTime() - now.getTime() < 24 * 3600 * 1000) {
    throw new AppError("invalid", "Bookings can only be cancelled up to 24 hours ahead.");
  }
  const u = await db.query<Row>(`update bookings set status = 'cancelled' where id = $1 returning ${COLS}`, [bookingId]);
  return toBooking(u.rows[0]);
}
