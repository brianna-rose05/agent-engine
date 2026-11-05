"use server";

import { redirect } from "next/navigation";
import { AppError } from "@/lib/errors";
import { claimOwner } from "@/lib/owner";
import { getDb } from "@/lib/runtime";
import { requireActor } from "@/lib/session";

export async function claim(_prev: string, form: FormData): Promise<string> {
  const actor = await requireActor("/sign-up");
  try {
    await claimOwner(await getDb(), actor, String(form.get("code") ?? ""));
  } catch (e) {
    if (e instanceof AppError) return e.message;
    throw e;
  }
  redirect("/");
}
