export type Role = "office" | "landlord" | "tenant";

export const ROLES: readonly Role[] = ["office", "landlord", "tenant"];

export const roleLabels: Record<Role, string> = {
  office: "مكتب عقار",
  landlord: "مؤجر",
  tenant: "مستأجر",
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** The role whose area a path belongs to, or null for shared pages. */
export function areaForPath(pathname: string): Role | null {
  for (const role of ROLES) {
    if (pathname === `/${role}` || pathname.startsWith(`/${role}/`)) return role;
  }
  return null;
}

/**
 * Where a signed-in user belongs. Users without a role, and offices that have
 * not created their office yet, finish setup on /welcome first.
 */
export function destinationFor(account: {
  role: Role | null;
  hasOffice: boolean;
}): string {
  if (!account.role) return "/welcome";
  if (account.role === "office" && !account.hasOffice) return "/welcome";
  return `/${account.role}`;
}
