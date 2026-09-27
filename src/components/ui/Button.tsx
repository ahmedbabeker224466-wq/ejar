import type { ButtonHTMLAttributes } from "react";

type ButtonVariant = "primary" | "secondary";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  fullWidth?: boolean;
};

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-primary text-primary-foreground hover:bg-primary-hover disabled:opacity-50",
  secondary:
    "bg-surface text-primary border-2 border-primary hover:bg-primary-soft disabled:opacity-50",
};

/** Button styling, also used for links that should look like buttons. */
export function buttonClassName(variant: ButtonVariant = "primary", fullWidth = true) {
  return `inline-flex min-h-14 items-center justify-center gap-2 rounded-2xl px-6 text-lg font-semibold transition-colors disabled:cursor-not-allowed ${
    fullWidth ? "w-full" : ""
  } ${variantClasses[variant]}`;
}

export function Button({
  variant = "primary",
  fullWidth = true,
  type = "button",
  className = "",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`${buttonClassName(variant, fullWidth)} ${className}`}
      {...props}
    />
  );
}
