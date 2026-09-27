import { AreaShell } from "@/components/layout/AreaShell";
import type { NavItem } from "@/components/layout/BottomNav";
import { DocumentIcon, UserIcon } from "@/components/layout/icons";
import { requireRole } from "@/lib/auth/session";

const navItems: NavItem[] = [
  { href: "/tenant", label: "عقدي", icon: DocumentIcon },
  { href: "/tenant/account", label: "حسابي", icon: UserIcon },
];

export default async function TenantLayout({ children }: LayoutProps<"/tenant">) {
  await requireRole("tenant");
  return <AreaShell navItems={navItems}>{children}</AreaShell>;
}
