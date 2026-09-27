"use client";

import { Button } from "@/components/ui/Button";

/** Friendly error screen for a role area; shows no technical details. */
export function AreaError({ retry }: { retry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-4 pt-16 text-center">
      <h1 className="text-2xl font-bold">حدث خطأ غير متوقع</h1>
      <p className="text-lg text-foreground-muted">
        تأكد من اتصالك بالإنترنت ثم حاول مرة أخرى.
      </p>
      <Button onClick={() => retry()}>حاول مرة أخرى</Button>
    </div>
  );
}
