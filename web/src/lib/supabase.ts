import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/** Without Supabase settings the app runs in demo mode on a recorded real run. */
export const liveEnabled = Boolean(url && anon);

let client: SupabaseClient | null = null;
export function supabaseBrowser(): SupabaseClient {
  if (!liveEnabled) throw new Error("Supabase is not configured");
  client ??= createBrowserClient(url!, anon!);
  return client;
}
