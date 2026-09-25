import { Button } from "../components/Button";

const API_URL = import.meta.env.VITE_API_URL ?? "";

function GitHubIcon() {
    return (
        <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
        </svg>
    );
}

export default function LoginPage() {
    function handleLogin() {
        window.location.href = `${API_URL}/api/auth/github`;
    }

    return (
        <div className="flex min-h-[70vh] items-center justify-center px-6 py-12">
            <div className="w-full max-w-[420px]">
                <div className="mb-6 text-center">
                    <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-[10px] bg-[#0a0a0f] text-sm font-bold text-[var(--color-paper)]">DL</div>
                    <h1 className="mt-4 text-[22px] font-semibold tracking-tight text-[#0a0a0f]">Sign in to DriftLock</h1>
                    <p className="mt-1.5 text-[13px] leading-5 text-[var(--color-muted)]">Self-maintaining APIs. DriftLock opens a PR when a vendor contract changes.</p>
                </div>

                <div className="rounded-[12px] border border-[var(--color-line)] bg-[var(--color-surface)] p-6 shadow-[0_1px_2px_rgba(10,10,15,0.04)]">
                    <h2 className="text-[13px] font-semibold text-[#0a0a0f]">Continue with GitHub</h2>
                    <p className="mt-1 text-xs leading-4 text-[var(--color-muted)]">We request read access to find call sites and permission to open fix PRs. Nothing is merged without you.</p>

                    <Button onClick={handleLogin} className="mt-5 w-full justify-center gap-2">
                        <GitHubIcon />
                        Continue with GitHub
                    </Button>

                    <p className="mt-4 text-center text-xs text-[var(--color-muted)]">You will be redirected to GitHub to authorize.</p>
                </div>

                <p className="mt-4 text-center text-xs text-[var(--color-muted)]">
                    By signing in you agree to the Terms. Questions? <a href="https://discord.gg/driftlock" className="underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-500">Discord</a>
                </p>
            </div>
        </div>
    );
}
