import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createServerClient } from "@supabase/ssr";
import type { Actor } from "./db";
import { type Auth, localAuth, supabaseAuth } from "./auth";
import { getDb } from "./runtime";

/**
 * What pages, layouts and server actions use to know who is signed in. Template file: do not edit.
 *
 *   const actor = await requireActor();          // redirects to /sign-in when nobody is signed in
 *   const db = await getDb();                    // from src/lib/runtime.ts
 *   const bookings = await listMyBookings(db, actor);
 *
 * Sign-in, sign-up and sign-out happen in server actions ("use server") through getAuth(), because only
 * server actions and route handlers may set cookies.
 */
export async function getAuth(): Promise<Auth> {
  const jar = await cookies();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (url && key) {
    return supabaseAuth(createServerClient(url, key, {
      cookies: {
        getAll: () => jar.getAll(),
        setAll: (list) => {
          try {
            list.forEach(({ name, value, options }) => jar.set(name, value, options));
          } catch {
            // Called from a server component, where cookies are read-only; the session still works.
          }
        },
      },
    }));
  }
  return localAuth(await getDb(), jar);
}

/** The signed-in user, or null. */
export async function getActor(): Promise<Actor | null> {
  const userId = await (await getAuth()).currentUserId();
  return userId ? { userId } : null;
}

/** The signed-in user; anyone else is sent to `signInPath`. */
export async function requireActor(signInPath = "/sign-in"): Promise<Actor> {
  const actor = await getActor();
  if (!actor) redirect(signInPath);
  return actor;
}
