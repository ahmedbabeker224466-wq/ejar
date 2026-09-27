"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/Button";

export function SignOutButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="secondary" disabled={pending}>
      {pending ? "جارٍ تسجيل الخروج…" : "تسجيل الخروج"}
    </Button>
  );
}
