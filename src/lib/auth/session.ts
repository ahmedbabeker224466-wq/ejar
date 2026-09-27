import "server-only";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loadAccount } from "./account";
import { destinationFor, type Role } from "./roles";

/** The signed-in user and account, or a redirect to /login. */
export async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const account = await loadAccount(supabase, user.id);
  return { user, account };
}

/**
 * Second line of defence after the proxy: role layouts call this so a user can
 * never render another role's area.
 */
export async function requireRole(role: Role) {
  const { user, account } = await requireUser();
  const home = destinationFor({
    role: account.role,
    hasOffice: account.officeId !== null,
  });
  if (home !== `/${role}`) redirect(home);
  return { user, account };
}
