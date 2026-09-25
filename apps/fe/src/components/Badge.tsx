import type { ReactNode } from "react";

export type BadgeTone = "neutral" | "green" | "amber" | "red" | "blue";

const TONES: Record<BadgeTone, string> = {
    neutral: "bg-[var(--color-surface)] text-zinc-600 border-[var(--color-line)]",
    green: "bg-emerald-50 text-emerald-700 border-emerald-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    red: "bg-red-50 text-red-700 border-red-200",
    blue: "bg-sky-50 text-sky-700 border-sky-200",
};

export function Badge({
    tone = "neutral",
    children,
}: {
    tone?: BadgeTone;
    children: ReactNode;
}) {
    return (
        <span
            className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 tracking-wide ${TONES[tone]}`}
        >
            {children}
        </span>
    );
}
