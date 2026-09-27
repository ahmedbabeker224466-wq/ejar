import { EmptyState } from "@/components/layout/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { BuildingIcon } from "@/components/layout/icons";
import { requireRole } from "@/lib/auth/session";

export default async function OfficeHome() {
  const { account } = await requireRole("office");

  return (
    <>
      <PageHeader title={account.officeName ?? "مكتبي"} subtitle="أهلاً بك في عقدي" />
      <EmptyState
        icon={BuildingIcon}
        title="لا توجد عقود بعد"
        text="قريباً ستضيف من هنا الملاك والوحدات وعقود الإيجار، وتتابع كل مواعيدها."
      />
    </>
  );
}
