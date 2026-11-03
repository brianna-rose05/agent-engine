import type { Actor, Db } from "@/lib/db";
import type { Slot } from "@/contracts/types";

/**
 * Staff only: publish a slot starting at `startsAt`.
 * Throws AppError "forbidden" if the actor has no profile or isn't staff, and "conflict" if a slot already
 * starts at that exact time.
 */
export async function createSlot(db: Db, actor: Actor, startsAt: Date): Promise<Slot> {
  throw new Error("Not implemented");
}

/**
 * Open slots (no booking with status 'booked') whose start falls on `day` ("YYYY-MM-DD") in the IANA time
 * zone `tz`, earliest first. Cancelled bookings don't make a slot taken.
 */
export async function listOpenSlots(db: Db, day: string, tz: string): Promise<Slot[]> {
  throw new Error("Not implemented");
}

/** True when the slot exists, starts after `now`, and has no 'booked' booking. */
export async function isSlotOpen(db: Db, slotId: string, now: Date): Promise<boolean> {
  throw new Error("Not implemented");
}
