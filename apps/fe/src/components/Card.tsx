import type { ReactNode } from "react";

export function Card({
    children,
    className = "",
    onClick,
    style,
}: {
    children: ReactNode;
    className?: string;
    onClick?: () => void;
    style?: React.CSSProperties;
}) {
    return (
        <div
            onClick={onClick}
            style={style}
            className={`rounded-[10px] border border-[var(--color-line)] bg-[var(--color-surface)] shadow-[0_1px_2px_rgba(10,10,15,0.04)] ${className}`}
        >
            {children}
        </div>
    );
}
