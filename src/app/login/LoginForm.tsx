"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { normalizeSaudiPhone, toWesternDigits } from "@/lib/phone";
import { createClient } from "@/lib/supabase/client";
import { loginErrorMessage } from "./errors";

const RESEND_SECONDS = 60;
const CONNECTION_ERROR = "تعذّر الاتصال، تحقق من الإنترنت وحاول مرة أخرى";

export function LoginForm() {
  const router = useRouter();
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [phoneInput, setPhoneInput] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const timer = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [secondsLeft]);

  async function sendCode(target: string) {
    setPending(true);
    setError(null);
    try {
      const { error } = await createClient().auth.signInWithOtp({ phone: target });
      if (error) {
        setError(loginErrorMessage(error));
        return false;
      }
      setSecondsLeft(RESEND_SECONDS);
      return true;
    } catch {
      setError(CONNECTION_ERROR);
      return false;
    } finally {
      setPending(false);
    }
  }

  async function onPhoneSubmit(event: FormEvent) {
    event.preventDefault();
    const normalized = normalizeSaudiPhone(phoneInput);
    if (!normalized) {
      setError("رقم الجوال غير صحيح، يبدأ بـ 05 ويتكون من 10 أرقام");
      return;
    }
    if (await sendCode(normalized)) {
      setPhone(normalized);
      setCode("");
      setStep("code");
    }
  }

  async function onCodeSubmit(event: FormEvent) {
    event.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      setError("الرمز يتكون من 6 أرقام");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const { error } = await createClient().auth.verifyOtp({
        phone,
        token: code,
        type: "sms",
      });
      if (error) {
        setError(loginErrorMessage(error));
        setPending(false);
        return;
      }
      // The home page sends the user to /welcome or their own area.
      router.replace("/");
      router.refresh();
    } catch {
      setError(CONNECTION_ERROR);
      setPending(false);
    }
  }

  if (step === "phone") {
    return (
      <form onSubmit={onPhoneSubmit} className="flex flex-col gap-6" noValidate>
        <div className="flex flex-col gap-2">
          <label htmlFor="phone" className="text-lg font-semibold">
            رقم الجوال
          </label>
          <div dir="ltr" className="flex min-h-16 overflow-hidden rounded-2xl border-2 border-border bg-surface focus-within:border-primary">
            <span className="flex items-center border-e-2 border-border bg-surface-muted px-4 text-xl font-semibold text-foreground-muted">
              +966
            </span>
            <input
              id="phone"
              name="phone"
              type="tel"
              inputMode="numeric"
              autoComplete="tel-national"
              placeholder="05xxxxxxxx"
              value={phoneInput}
              onChange={(e) => setPhoneInput(toWesternDigits(e.target.value))}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "login-error" : undefined}
              className="min-w-0 flex-1 bg-transparent px-4 text-2xl tracking-wider text-foreground outline-none placeholder:text-foreground-muted"
            />
          </div>
        </div>
        {error && <ErrorText message={error} />}
        <Button type="submit" disabled={pending}>
          {pending ? "جارٍ الإرسال…" : "أرسل الرمز"}
        </Button>
      </form>
    );
  }

  return (
    <form onSubmit={onCodeSubmit} className="flex flex-col gap-6" noValidate>
      <p className="text-lg">
        أدخل الرمز المرسل إلى{" "}
        <span dir="ltr" className="font-semibold">
          {phone}
        </span>
      </p>
      <div className="flex flex-col gap-2">
        <label htmlFor="code" className="text-lg font-semibold">
          رمز التحقق
        </label>
        <input
          id="code"
          name="code"
          type="text"
          dir="ltr"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="••••••"
          value={code}
          onChange={(e) => setCode(toWesternDigits(e.target.value).replace(/\D/g, ""))}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "login-error" : undefined}
          className="min-h-16 w-full rounded-2xl border-2 border-border bg-surface px-4 text-center text-3xl tracking-[0.5em] text-foreground focus:border-primary"
          autoFocus
        />
      </div>
      {error && <ErrorText message={error} />}
      <Button type="submit" disabled={pending}>
        {pending ? "جارٍ التحقق…" : "تأكيد"}
      </Button>
      <Button
        variant="secondary"
        disabled={pending || secondsLeft > 0}
        onClick={() => sendCode(phone)}
      >
        {secondsLeft > 0
          ? `إعادة إرسال الرمز بعد ${secondsLeft} ثانية`
          : "إعادة إرسال الرمز"}
      </Button>
      <button
        type="button"
        className="min-h-12 text-lg font-semibold text-primary underline"
        onClick={() => {
          setStep("phone");
          setError(null);
        }}
      >
        تغيير رقم الجوال
      </button>
    </form>
  );
}

function ErrorText({ message }: { message: string }) {
  return (
    <p id="login-error" role="alert" className="text-lg font-semibold text-danger">
      {message}
    </p>
  );
}
