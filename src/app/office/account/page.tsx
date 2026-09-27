import { AccountPanel } from "@/components/layout/AccountPanel";
import { requireRole } from "@/lib/auth/session";

export default async function OfficeAccount() {
  const { user, account } = await requireRole("office");
  return <AccountPanel phone={user.phone} role="office" extra={account.officeName} />;
}
