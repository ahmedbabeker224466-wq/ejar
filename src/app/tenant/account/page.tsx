import { AccountPanel } from "@/components/layout/AccountPanel";
import { requireRole } from "@/lib/auth/session";

export default async function TenantAccount() {
  const { user } = await requireRole("tenant");
  return <AccountPanel phone={user.phone} role="tenant" />;
}
