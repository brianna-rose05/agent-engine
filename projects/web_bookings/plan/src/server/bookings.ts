import type { Actor, Db } from "@/lib/db";
import type { BookInput, Booking } from "@/contracts/types";

/**
 * Book an open slot for the actor's pet. petName is trimmed and must be 1 to 60 characters.
 * Throws AppError "invalid" for a bad pet name, "not_found" if the slot doesn't exist, and "conflict" if the
 * slot isn't open (taken, or starts at or before `now`). Two concurrent requests must never both succeed.
 */
export async function bookSlot(db: Db, actor: Actor, input: BookInput, now: Date): Promise<Booking> {
  throw new Error("Not implemented");
}

/**
 * Cancel the actor's own booking. Allowed until 24 hours before the slot starts (exactly 24h is allowed).
 * Throws "not_found" if the booking doesn't exist or isn't the actor's, "conflict" if already cancelled,
 * and "invalid" if it's less than 24 hours before the start. Returns the updated booking.
 */
export async function cancelBooking(db: Db, actor: Actor, bookingId: string, now: Date): Promise<Booking> {
  throw new Error("Not implemented");
}
