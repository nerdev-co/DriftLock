export function Toggle({
    checked,
    onChange,
    label,
}: {
    checked: boolean;
    onChange: (next: boolean) => void;
    label?: string;
}) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={label}
            onClick={() => onChange(!checked)}
            className={`relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full transition-colors duration-200 ${
                checked ? "bg-[#0a0a0f]" : "bg-zinc-300"
            }`}
        >
            <span
                aria-hidden
                className={`inline-block h-[18px] w-[18px] transform rounded-full bg-[var(--color-surface)] shadow-sm transition-transform duration-200 ${
                    checked ? "translate-x-[18px]" : "translate-x-[2px]"
                }`}
            />
        </button>
    );
}
