import { EmptyState } from "@/components/layout/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { DocumentIcon } from "@/components/layout/icons";
import { requireRole } from "@/lib/auth/session";

export default async function TenantHome() {
  await requireRole("tenant");

  return (
    <>
      <PageHeader title="عقدي" subtitle="أهلاً بك في عقدي" />
      <EmptyState
        icon={DocumentIcon}
        title="عقدك في الطريق"
        text="سيظهر هنا عقدك وتواريخه المهمة قريباً."
      />
    </>
  );
}
