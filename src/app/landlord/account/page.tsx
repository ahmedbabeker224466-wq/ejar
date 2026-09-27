import { AccountPanel } from "@/components/layout/AccountPanel";
import { requireRole } from "@/lib/auth/session";

export default async function LandlordAccount() {
  const { user } = await requireRole("landlord");
  return <AccountPanel phone={user.phone} role="landlord" />;
}
