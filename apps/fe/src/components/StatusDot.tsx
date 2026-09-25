export type DotTone = "neutral" | "green" | "amber" | "red" | "blue";

const DOTS: Record<DotTone, string> = {
    neutral: "bg-zinc-300",
    green: "bg-emerald-500",
    amber: "bg-amber-500",
    red: "bg-red-500",
    blue: "bg-sky-500",
};

export function StatusDot({
    tone,
    pulsing = false,
}: {
    tone: DotTone;
    pulsing?: boolean;
}) {
    return (
        <span className="relative inline-flex h-2 w-2 shrink-0">
            {pulsing && (
                <span
                    className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-50 ${DOTS[tone]}`}
                />
            )}
            <span
                className={`relative inline-flex h-2 w-2 rounded-full ${DOTS[tone]}`}
            />
        </span>
    );
}
