import type { ReactNode } from "react";

export function EmptyState({
  icon,
  title,
  text,
}: {
  icon: ReactNode;
  title: string;
  text: string;
}) {
  return (
    <div className="flex flex-col items-center gap-4 rounded-2xl border-2 border-dashed border-border px-6 py-12 text-center">
      <div className="flex size-16 items-center justify-center rounded-full bg-primary-soft text-primary">
        {icon}
      </div>
      <h2 className="text-xl font-bold">{title}</h2>
      <p className="text-lg text-foreground-muted">{text}</p>
    </div>
  );
}
