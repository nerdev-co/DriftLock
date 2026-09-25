import { useEffect, useState } from "react";
import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { getMe } from "../api/client";
import { onToast } from "../lib/toast";

function LockMark() {
    return (
        <span className="relative flex h-[28px] w-[28px] items-center justify-center rounded-[6px] bg-[var(--color-ink)] text-[var(--color-paper)]">
            <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
                aria-hidden
            >
                <rect
                    x="3"
                    y="6"
                    width="8"
                    height="6"
                    rx="1"
                    stroke="white"
                    strokeWidth="1.2"
                />
                <path
                    d="M4.5 6V4.2a2.5 2.5 0 0 1 5 0V6"
                    stroke="white"
                    strokeWidth="1.2"
                />
                <circle cx="7" cy="9" r="1" fill="white" />
            </svg>
            <span className="absolute -top-[3px] -right-[3px] h-[7px] w-[7px] rounded-full bg-[var(--color-signal-red)] ring-2 ring-[var(--color-paper)]" />
        </span>
    );
}

export default function AppShell() {
    const location = useLocation();
    const [user, setUser] = useState<{ name: string; handle: string } | null>(
        null,
    );
    const [toastMsg, setToastMsg] = useState<string | null>(null);

    useEffect(() => {
        const token = localStorage.getItem("driftlock_token");
        if (token) {
            fetch(`${import.meta.env.VITE_API_URL ?? ""}/api/auth/session`, {
                headers: { Authorization: `Bearer ${token}` },
            })
                .then((res) => (res.ok ? res.json() : null))
                .then((data) => {
                    if (data?.user)
                        setUser({
                            // GitHub returns null for `name` when a user has not
                            // set one, and the avatar initials below call
                            // .split() on it, so fall back to the login.
                            name: data.user.name ?? data.user.login ?? "",
                            handle: data.user.login,
                        });
                })
                .catch(() => {});
            return;
        }
        // Landing is static: do not hit /api/me when unauthenticated and backend may be offline.
        // Only fetch user on authenticated routes to avoid demo 502 noise.
        const needsAuth =
            location.pathname.startsWith("/accounts") ||
            location.pathname.startsWith("/repos") ||
            location.pathname.startsWith("/settings") ||
            location.pathname.startsWith("/webhooks");
        if (!needsAuth) {
            setUser(null);
            return;
        }
        getMe()
            .then(({ user: me }) => setUser(me))
            .catch(() => setUser(null));
    }, [location.pathname]);

    useEffect(() => {
        onToast((message) => {
            setToastMsg(message);
            window.setTimeout(() => setToastMsg(null), 2800);
        });
        return () => onToast(() => undefined);
    }, []);

    // The landing page at "/" is not the accounts dashboard, so it must not
    // highlight the Accounts nav item.
    const onAccounts =
        location.pathname.startsWith("/accounts") ||
        location.pathname.startsWith("/repos");
    const onWebhooks = location.pathname.startsWith("/webhooks");
    const onSettings = location.pathname.startsWith("/settings");
    const onInstall = location.pathname.startsWith("/install");
    const onLogin = location.pathname.startsWith("/login");

    const navLink = (active: boolean) =>
        `relative px-3 py-1 text-[13px] font-medium tracking-[-0.01em] transition-colors ${active ? "text-[var(--color-ink)]" : "text-[var(--color-muted)] hover:text-[var(--color-ink)]"}`;

    function handleLogout() {
        localStorage.removeItem("driftlock_token");
        window.location.href = "/";
    }

    const [dark, setDark] = useState(() => {
        if (typeof window === "undefined") return false;
        return localStorage.getItem("driftlock_theme") === "dark" || (!localStorage.getItem("driftlock_theme") && window.matchMedia("(prefers-color-scheme: dark)").matches);
    });
    useEffect(() => {
        document.documentElement.classList.toggle("dark", dark);
        localStorage.setItem("driftlock_theme", dark ? "dark" : "light");
    }, [dark]);

    return (
        <div className="flex min-h-screen flex-col bg-[var(--color-paper)] transition-colors">
            <header className="sticky top-0 z-30 border-b border-[var(--color-line)] bg-[var(--color-paper)]/85 backdrop-blur-[10px]">
                <div className="mx-auto flex h-[60px] w-full max-w-[1080px] items-center justify-between gap-4 px-6">
                    <div className="flex items-center gap-6">
                        <Link to="/" className="flex items-center gap-2.5">
                            <LockMark />
                            <span className="text-[16px] font-semibold tracking-[-0.025em] text-[var(--color-ink)]">
                                DriftLock
                            </span>
                            <span className="hidden items-center gap-1 rounded-[6px] border border-[var(--color-line-strong)]/10 bg-[var(--color-surface)] px-1.5 py-0.5 font-mono text-[10px] leading-none tracking-wide text-[var(--color-ink)] sm:inline-flex">
                                REV. 01
                            </span>
                        </Link>
                        <nav className="hidden items-center gap-0 sm:flex">
                            <Link
                                to="/accounts"
                                className={navLink(onAccounts)}
                            >
                                Repos
                                {onAccounts && (
                                    <span className="absolute inset-x-3 -bottom-[14px] h-[2px] bg-[var(--color-ink)]" />
                                )}
                            </Link>
                            <Link
                                to="/webhooks"
                                className={navLink(onWebhooks)}
                            >
                                Webhooks
                                {onWebhooks && (
                                    <span className="absolute inset-x-3 -bottom-[14px] h-[2px] bg-[var(--color-ink)]" />
                                )}
                            </Link>
                            <Link
                                to="/settings"
                                className={navLink(onSettings)}
                            >
                                Settings
                                {onSettings && (
                                    <span className="absolute inset-x-3 -bottom-[14px] h-[2px] bg-[var(--color-ink)]" />
                                )}
                            </Link>
                        </nav>
                    </div>

                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => setDark(!dark)}
                            aria-label="Toggle theme"
                            className="flex h-7 w-7 items-center justify-center rounded-full border border-[var(--color-line)] bg-[var(--color-paper)] text-[var(--color-ink)] transition-colors hover:bg-[var(--color-line)]"
                            title={dark ? "Switch to light" : "Switch to dark"}
                        >
                            <span className="text-[11px]">{dark ? "☀" : "☾"}</span>
                        </button>
                        <nav className="flex items-center gap-0 sm:hidden">
                            <Link
                                to="/accounts"
                                className={navLink(onAccounts)}
                            >
                                Repos
                            </Link>
                            <Link
                                to="/webhooks"
                                className={navLink(onWebhooks)}
                            >
                                Hooks
                            </Link>
                        </nav>
                        <Link
                            to="/install"
                            className={`hidden sm:inline-flex items-center justify-center rounded-full px-4 py-1.5 text-[13px] font-medium transition-[transform,background] active:scale-[0.97] ${onInstall ? "bg-[var(--color-ink)] text-[var(--color-paper)]" : "bg-[var(--color-ink)] text-[var(--color-paper)] hover:opacity-90"}`}
                        >
                            Install
                        </Link>
                        <Link
                            to="/install"
                            className="inline-flex items-center justify-center rounded-full bg-[var(--color-ink)] px-3 py-1.5 text-xs font-medium text-[var(--color-paper)] active:scale-[0.97] sm:hidden"
                        >
                            Install
                        </Link>
                        {user ? (
                            <div className="hidden items-center gap-2 sm:flex">
                                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--color-ink)] text-[11px] font-semibold text-[var(--color-paper)]">
                                    {user.name
                                        .split(" ")
                                        .map((p) => p[0])
                                        .slice(0, 2)
                                        .join("")}
                                </span>
                                <button
                                    onClick={handleLogout}
                                    className="text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)] hover:underline"
                                >
                                    Sign out
                                </button>
                            </div>
                        ) : (
                            <Link
                                to="/login"
                                className={`inline-flex items-center justify-center rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${onLogin ? "border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-paper)]" : "border-[var(--color-line)] bg-[var(--color-paper)] text-[var(--color-ink)] hover:bg-[var(--color-line)]"}`}
                            >
                                Sign in
                            </Link>
                        )}
                    </div>
                </div>
            </header>

            <main className="mx-auto w-full max-w-[1080px] flex-1 px-6 py-8">
                <Outlet />
            </main>

            <footer className="border-t border-[var(--color-line)] bg-[var(--color-paper)]">
                <div className="mx-auto flex w-full max-w-[1080px] flex-wrap items-center justify-between gap-3 px-6 py-4">
                    <div className="flex flex-wrap items-center gap-3 text-xs leading-4 text-[var(--color-muted)]">
                        <span>
                            DriftLock is a revision bureau. Every drift is a
                            redline, every fix is a PR. Nothing is merged
                            without you.
                        </span>
                        <Link
                            to="/about"
                            className="font-mono text-[11px] tracking-wide text-[var(--color-ink)] underline decoration-[var(--color-line)] underline-offset-2 hover:decoration-[var(--color-ink)]"
                        >
                            About
                        </Link>
                    </div>
                    <span className="font-mono text-[11px] tracking-wide text-[var(--color-muted)]">
                        DEPENDABOT BUT FOR APIS — REV. 01
                    </span>
                </div>
            </footer>

            {toastMsg && (
                <div className="pointer-events-none fixed inset-x-0 bottom-6 flex justify-center px-6">
                    <div className="pointer-events-auto rounded-full bg-[var(--color-ink)] px-4 py-2.5 text-[13px] font-medium text-[var(--color-paper)] shadow-lg">
                        {toastMsg}
                    </div>
                </div>
            )}
        </div>
    );
}
