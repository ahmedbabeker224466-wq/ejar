import { AreaShell } from "@/components/layout/AreaShell";
import type { NavItem } from "@/components/layout/BottomNav";
import { BuildingIcon, UserIcon } from "@/components/layout/icons";
import { requireRole } from "@/lib/auth/session";

const navItems: NavItem[] = [
  { href: "/office", label: "المكتب", icon: BuildingIcon },
  { href: "/office/account", label: "حسابي", icon: UserIcon },
];

export default async function OfficeLayout({ children }: LayoutProps<"/office">) {
  await requireRole("office");
  return <AreaShell navItems={navItems}>{children}</AreaShell>;
}
