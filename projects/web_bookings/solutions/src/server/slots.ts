import type { Actor, Db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import type { Slot } from "@/contracts/types";

type Row = { id: string; starts_at: Date };
const toSlot = (r: Row): Slot => ({ id: r.id, startsAt: new Date(r.starts_at) });

export async function createSlot(db: Db, actor: Actor, startsAt: Date): Promise<Slot> {
  const { rows } = await db.query<{ role: string }>("select role from profiles where user_id = $1", [actor.userId]);
  if (rows[0]?.role !== "staff") throw new AppError("forbidden", "Only staff can add times.");
  const taken = await db.query("select 1 from slots where starts_at = $1", [startsAt]);
  if (taken.rows.length) throw new AppError("conflict", "There's already a slot at that time.");
  const r = await db.query<Row>(
    "insert into slots (starts_at, created_by) values ($1, $2) returning id, starts_at",
    [startsAt, actor.userId],
  );
  return toSlot(r.rows[0]);
}

export async function listOpenSlots(db: Db, day: string, tz: string): Promise<Slot[]> {
  const r = await db.query<Row>(
    `select s.id, s.starts_at from slots s
      where (s.starts_at at time zone $2)::date = $1::date
        and not exists (select 1 from bookings b where b.slot_id = s.id and b.status = 'booked')
      order by s.starts_at`,
    [day, tz],
  );
  return r.rows.map(toSlot);
}

export async function isSlotOpen(db: Db, slotId: string, now: Date): Promise<boolean> {
  const r = await db.query(
    `select 1 from slots s where s.id = $1 and s.starts_at > $2
        and not exists (select 1 from bookings b where b.slot_id = s.id and b.status = 'booked')`,
    [slotId, now],
  );
  return r.rows.length > 0;
}
