import { createBrowserClient } from "@supabase/ssr";
import { supabaseAnonKey, supabaseUrl } from "./env";

/** Supabase client for Client Components. Uses the signed-in user's session. */
export function createClient() {
  return createBrowserClient(supabaseUrl(), supabaseAnonKey());
}
