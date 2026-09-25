export function Stat({
    label,
    value,
    hint,
    className = "",
}: {
    label: string;
    value: string | number;
    hint?: string;
    className?: string;
}) {
    return (
        <div className={`flex flex-col gap-1 ${className}`}>
            <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--color-muted)]">
                {label}
            </span>
            <span className="text-[22px] font-semibold tabular-nums tracking-[-0.02em] text-[#0a0a0f] leading-none">
                {value}
            </span>
            {hint && (
                <span className="text-xs text-[var(--color-muted)]">{hint}</span>
            )}
        </div>
    );
}
