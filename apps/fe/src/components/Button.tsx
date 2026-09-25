import type { ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost";
export type ButtonSize = "sm" | "md";

const VARIANTS: Record<ButtonVariant, string> = {
    primary: "bg-[#0a0a0f] text-[var(--color-paper)] hover:bg-zinc-800 active:scale-[0.98] shadow-[0_1px_2px_rgba(0,0,0,0.12)]",
    secondary:
        "border border-[var(--color-line)] bg-[var(--color-surface)] text-zinc-800 hover:bg-[var(--color-surface)] active:scale-[0.98]",
    ghost: "text-[var(--color-muted)] hover:text-[var(--color-ink)] hover:bg-[var(--color-surface)] active:scale-[0.98]",
};

const SIZES: Record<ButtonSize, string> = {
    sm: "text-xs px-2.5 py-1.5",
    md: "text-[13px] px-3.5 py-2",
};

export function Button({
    variant = "primary",
    size = "md",
    className = "",
    ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant;
    size?: ButtonSize;
    children: ReactNode;
}) {
    return (
        <button
            type="button"
            className={`inline-flex items-center justify-center gap-1.5 rounded-[8px] font-medium transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
            {...props}
        />
    );
}
