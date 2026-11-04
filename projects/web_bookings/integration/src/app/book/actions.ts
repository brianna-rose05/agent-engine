"use server";

import { revalidatePath } from "next/cache";
import { AppError } from "@/lib/errors";
import { getDb } from "@/lib/runtime";
import { requireActor } from "@/lib/session";
import { bookSlot } from "@/server/bookings";

export async function book(slotId: string, petName: string): Promise<string> {
  const actor = await requireActor();
  try {
    await bookSlot(await getDb(), actor, { slotId, petName }, new Date());
  } catch (e) {
    if (e instanceof AppError) return e.message;
    throw e;
  }
  revalidatePath("/book");
  return "Booked!";
}
