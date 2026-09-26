import { PageHeader } from "@/components/layout/PageHeader";

export default function Home() {
  return (
    <>
      <PageHeader
        title="عقدي"
        subtitle="ارفع عقد الإيجار، ونذكّرك بالتواريخ المهمة."
      />
      <p className="text-base text-foreground-muted">
        تطبيق خاص غير تابع لمنصة إيجار، والتواريخ للتذكير فقط
      </p>
    </>
  );
}
