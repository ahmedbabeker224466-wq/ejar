import { EmptyState } from "@/components/layout/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { HomeIcon } from "@/components/layout/icons";
import { requireRole } from "@/lib/auth/session";

export default async function LandlordHome() {
  await requireRole("landlord");

  return (
    <>
      <PageHeader title="أملاكي" subtitle="أهلاً بك في عقدي" />
      <EmptyState
        icon={HomeIcon}
        title="لا توجد وحدات بعد"
        text="ستظهر هنا وحداتك وعقودها عندما يضيفها مكتب العقار."
      />
    </>
  );
}
