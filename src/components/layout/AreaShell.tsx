import type { ReactNode } from "react";
import { BottomNav, type NavItem } from "./BottomNav";

/** Page frame for a role area: content plus that role's bottom navigation. */
export function AreaShell({
  navItems,
  children,
}: {
  navItems: NavItem[];
  children: ReactNode;
}) {
  return (
    <>
      <div className="pb-[calc(6rem+env(safe-area-inset-bottom))]">{children}</div>
      <BottomNav items={navItems} />
    </>
  );
}
