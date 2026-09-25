export function EmptyState({
    title,
    hint,
}: {
    title: string;
    hint?: string;
}) {
    return (
        <div className="flex flex-col items-center gap-1.5 rounded-[10px] border border-dashed border-[var(--color-line)] bg-[var(--color-surface)]/60 px-6 py-10 text-center">
            <div className="mb-1 flex h-8 w-8 items-center justify-center rounded-full bg-[var(--color-surface)] border border-[var(--color-line)] text-[var(--color-muted)]">
                <span className="text-sm">◯</span>
            </div>
            <p className="text-[13px] font-medium text-[var(--color-ink)]">{title}</p>
            {hint && <p className="max-w-sm text-xs leading-4 text-[var(--color-muted)]">{hint}</p>}
        </div>
    );
}
