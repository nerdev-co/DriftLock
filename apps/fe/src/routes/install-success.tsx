import { useEffect } from "react";
import { Link, useNavigate } from "@tanstack/react-router";

export default function InstallSuccessPage() {
    const navigate = useNavigate();
    const params = new URLSearchParams(window.location.search);
    const installationId = params.get("installation_id");
    const action = params.get("action") || params.get("setup_action") || "install";

    useEffect(() => {
        // Auto-refresh accounts after a short delay so dashboard shows newly installed repos
        const t = setTimeout(() => {}, 800);
        return () => clearTimeout(t);
    }, []);

    return (
        <div className="mx-auto max-w-[640px] text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center border border-[var(--color-line-strong)] bg-[var(--color-ink)] text-[var(--color-paper)]">✓</div>
            <h1 className="mt-4 font-display text-[26px] tracking-[-0.02em] text-[var(--color-ink)]">GitHub App {action === "update" ? "updated" : "installed"}</h1>
            <p className="mx-auto mt-2 max-w-[520px] font-mono text-xs leading-5 text-[var(--color-muted)]">
                DriftLock{installationId ? ` installation ${installationId}` : ""} was {action === "update" ? "updated" : "installed"} for your account. Your selected repos are now watched.
            </p>
            <div className="mt-6 flex justify-center gap-2">
                <Link to="/accounts" className="bg-[var(--color-ink)] px-5 py-2.5 font-mono text-xs tracking-wide text-[var(--color-paper)] hover:bg-[var(--color-ink)]/90">VIEW REPOS →</Link>
                <Link to="/settings" className="border border-[var(--color-line)] bg-[var(--color-surface)] px-5 py-2.5 font-mono text-xs tracking-wide text-[var(--color-ink)] hover:bg-[var(--color-paper)]">OPEN SETTINGS</Link>
            </div>
            <p className="mt-6 font-mono text-[11px] tracking-wide text-[var(--color-muted)]">
                If you do not see your repos, <button onClick={() => navigate({ to: "/install" })} className="underline underline-offset-2 hover:text-[var(--color-ink)]">go to Install again</button> or refresh <Link to="/accounts" className="underline underline-offset-2">/accounts</Link>.
            </p>
        </div>
    );
}
