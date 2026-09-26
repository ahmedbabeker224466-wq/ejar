import type { InputHTMLAttributes } from "react";

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  id: string;
  label: string;
  hint?: string;
  error?: string;
};

export function Input({
  id,
  label,
  hint,
  error,
  className = "",
  ...props
}: InputProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-lg font-semibold">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`min-h-14 w-full rounded-2xl border-2 bg-surface px-4 text-lg text-foreground placeholder:text-foreground-muted ${
          error ? "border-danger" : "border-border focus:border-primary"
        } ${className}`}
        {...props}
      />
      {hint && (
        <p id={hintId} className="text-base text-foreground-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-base font-semibold text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
