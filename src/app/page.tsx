import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/layout/PageHeader";
import { buttonClassName } from "@/components/ui/Button";
import { loadAccount } from "@/lib/auth/account";
import { destinationFor } from "@/lib/auth/roles";
import { createClient } from "@/lib/supabase/server";

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    const account = await loadAccount(supabase, user.id);
    redirect(destinationFor({ role: account.role, hasOffice: account.officeId !== null }));
  }

  return (
    <>
      <PageHeader
        title="عقدي"
        subtitle="ارفع عقد الإيجار، ونذكّرك بالتواريخ المهمة."
      />
      <Link href="/login" className={buttonClassName()}>
        تسجيل الدخول
      </Link>
      <p className="mt-6 text-base text-foreground-muted">
        تطبيق خاص غير تابع لمنصة إيجار، والتواريخ للتذكير فقط
      </p>
    </>
  );
}
