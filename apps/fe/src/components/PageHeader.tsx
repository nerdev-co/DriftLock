import type { ReactNode } from "react";

export function PageHeader({
    eyebrow,
    title,
    description,
    actions,
}: {
    eyebrow?: string;
    title: string;
    description?: string;
    actions?: ReactNode;
}) {
    return (
        <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
            <div>
                {eyebrow && (
                    <p className="mb-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-muted)]">
                        {eyebrow}
                    </p>
                )}
                <h1 className="font-display text-[22px] font-semibold tracking-[-0.02em] text-[var(--color-ink)] leading-tight">
                    {title}
                </h1>
                {description && (
                    <p className="mt-1.5 max-w-[560px] font-mono text-[13px] leading-5 text-[var(--color-muted)]">
                        {description}
                    </p>
                )}
            </div>
            {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
    );
}
