import { signOut } from "@/lib/auth/actions";
import { roleLabels, type Role } from "@/lib/auth/roles";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "./PageHeader";
import { SignOutButton } from "./SignOutButton";

/** Shared "حسابي" page body: who is signed in, and sign out. */
export function AccountPanel({
  phone,
  role,
  extra,
}: {
  phone: string | undefined;
  role: Role;
  extra?: string | null;
}) {
  return (
    <>
      <PageHeader title="حسابي" />
      <Card className="flex flex-col gap-4">
        <div>
          <p className="text-base text-foreground-muted">رقم الجوال</p>
          <p className="text-right text-xl font-semibold" dir="ltr">
            {phone ? `+${phone.replace(/^\+/, "")}` : "—"}
          </p>
        </div>
        <div>
          <p className="text-base text-foreground-muted">نوع الحساب</p>
          <p className="text-xl font-semibold">{roleLabels[role]}</p>
        </div>
        {extra && (
          <div>
            <p className="text-base text-foreground-muted">المكتب</p>
            <p className="text-xl font-semibold">{extra}</p>
          </div>
        )}
      </Card>
      <form action={signOut} className="mt-6">
        <SignOutButton />
      </form>
    </>
  );
}
