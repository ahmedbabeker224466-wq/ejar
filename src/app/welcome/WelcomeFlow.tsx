"use client";

import { useActionState, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/layout/PageHeader";
import { BuildingIcon, DocumentIcon } from "@/components/layout/icons";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { createOffice, type OfficeFormState } from "./actions";

type Step = "choose" | "office" | "invite";

export function WelcomeFlow({ initialStep }: { initialStep: Step }) {
  const [step, setStep] = useState<Step>(initialStep);

  if (step === "office") return <OfficeStep onBack={() => setStep("choose")} />;
  if (step === "invite") return <InviteStep onBack={() => setStep("choose")} />;

  return (
    <>
      <PageHeader title="أهلاً بك في عقدي" subtitle="اختر ما يناسبك للبدء" />
      <div className="flex flex-col gap-4">
        <ChoiceButton icon={BuildingIcon} label="أنا مكتب عقار" onClick={() => setStep("office")} />
        <ChoiceButton icon={DocumentIcon} label="عندي كود دعوة" onClick={() => setStep("invite")} />
      </div>
    </>
  );
}

function ChoiceButton({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-24 items-center gap-4 rounded-2xl border-2 border-border bg-surface px-5 text-start text-xl font-bold hover:border-primary"
    >
      <span className="flex size-14 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary">
        {icon}
      </span>
      {label}
    </button>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-2 min-h-12 w-full text-lg font-semibold text-primary underline"
    >
      رجوع
    </button>
  );
}

function OfficeStep({ onBack }: { onBack: () => void }) {
  const [state, formAction, pending] = useActionState<OfficeFormState, FormData>(
    createOffice,
    { error: null },
  );

  return (
    <>
      <PageHeader title="بيانات المكتب" subtitle="اكتب اسم مكتبك كما يعرفه عملاؤك." />
      <form action={formAction} className="flex flex-col gap-6">
        <Input
          id="name"
          name="name"
          label="اسم المكتب"
          placeholder="مثال: مكتب الريادة العقاري"
          maxLength={80}
          required
          error={state.error ?? undefined}
        />
        <Button type="submit" disabled={pending}>
          {pending ? "جارٍ الحفظ…" : "إنشاء المكتب"}
        </Button>
      </form>
      <BackButton onClick={onBack} />
    </>
  );
}

function InviteStep({ onBack }: { onBack: () => void }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/invites/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || typeof result.redirect !== "string") {
        setError(result.error ?? "تعذّر تفعيل الكود الآن، حاول مرة أخرى");
        setPending(false);
        return;
      }
      router.replace(result.redirect);
      router.refresh();
    } catch {
      setError("تعذّر الاتصال، تحقق من الإنترنت وحاول مرة أخرى");
      setPending(false);
    }
  }

  return (
    <>
      <PageHeader
        title="كود الدعوة"
        subtitle="اكتب الكود المكوّن من 8 حروف وأرقام الذي أرسله لك مكتب العقار."
      />
      <form onSubmit={onSubmit} className="flex flex-col gap-6" noValidate>
        <Input
          id="code"
          name="code"
          label="الكود"
          dir="ltr"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={12}
          placeholder="ABCD2345"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          className="text-center text-2xl tracking-[0.3em]"
          error={error ?? undefined}
        />
        <Button type="submit" disabled={pending || code.trim().length === 0}>
          {pending ? "جارٍ التحقق…" : "تفعيل الكود"}
        </Button>
      </form>
      <BackButton onClick={onBack} />
    </>
  );
}
