"use server";

import { redirect } from "next/navigation";
import { AppError } from "@/lib/errors";
import { getDb } from "@/lib/runtime";
import { getAuth } from "@/lib/session";

export async function signUp(_prev: string, form: FormData): Promise<string> {
  try {
    const { userId } = await (await getAuth()).signUp(String(form.get("email")), String(form.get("password")));
    await (await getDb()).query("insert into profiles (user_id, name, role) values ($1, $2, 'customer')",
                                [userId, String(form.get("name") || "Customer")]);
  } catch (e) {
    if (e instanceof AppError) return e.message;
    throw e;
  }
  redirect("/book");
}
