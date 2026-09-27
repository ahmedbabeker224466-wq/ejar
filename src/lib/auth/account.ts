import type { SupabaseClient } from "@supabase/supabase-js";
import { isRole, type Role } from "./roles";

export type Account = {
  role: Role | null;
  officeId: string | null;
  officeName: string | null;
};

/**
 * Loads the user's role and (for offices) their office. Works with any client:
 * RLS lets users read their own profile and their own office.
 */
export async function loadAccount(
  supabase: SupabaseClient,
  userId: string,
): Promise<Account> {
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;

  const role = isRole(profile?.role) ? profile.role : null;
  if (role !== "office") return { role, officeId: null, officeName: null };

  const { data: office, error: officeError } = await supabase
    .from("offices")
    .select("id, name")
    .eq("owner_id", userId)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (officeError) throw officeError;

  return { role, officeId: office?.id ?? null, officeName: office?.name ?? null };
}
