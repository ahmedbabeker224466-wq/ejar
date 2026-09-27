import { AreaShell } from "@/components/layout/AreaShell";
import type { NavItem } from "@/components/layout/BottomNav";
import { HomeIcon, UserIcon } from "@/components/layout/icons";
import { requireRole } from "@/lib/auth/session";

const navItems: NavItem[] = [
  { href: "/landlord", label: "أملاكي", icon: HomeIcon },
  { href: "/landlord/account", label: "حسابي", icon: UserIcon },
];

export default async function LandlordLayout({ children }: LayoutProps<"/landlord">) {
  await requireRole("landlord");
  return <AreaShell navItems={navItems}>{children}</AreaShell>;
}
