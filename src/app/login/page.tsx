import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/PageHeader";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "تسجيل الدخول | عقدي" };

export default function LoginPage() {
  return (
    <>
      <PageHeader title="تسجيل الدخول" subtitle="أدخل رقم جوالك وسنرسل لك رمز تحقق." />
      <LoginForm />
      <p className="mt-8 text-base text-foreground-muted">
        تطبيق خاص غير تابع لمنصة إيجار، والتواريخ للتذكير فقط
      </p>
    </>
  );
}
