import { Link } from "@tanstack/react-router";
import { getAccountRepos } from "../api/client";
import type { Repo } from "../api/types";
import { Badge } from "../components/Badge";
import { Card } from "../components/Card";
import { PageHeader } from "../components/PageHeader";
import { StatusDot } from "../components/StatusDot";
import { useFetch } from "../lib/useFetch";
import { timeAgo } from "../lib/format";

function RepoRow({ repo }: { repo: Repo }) {
    const dirty = repo.stats.driftOpen > 0;
    return (
        <Link to="/repos/$owner/$name" params={{ owner: repo.owner, name: repo.name }} className="group">
            <Card className="flex items-center gap-4 p-4 sm:p-5 transition-all duration-150 hover:shadow-[0_4px_16px_rgba(10,10,15,0.06)] hover:border-[var(--color-line)] group-active:scale-[0.995]">
                <StatusDot tone={dirty ? "amber" : "green"} pulsing={dirty} />
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-[14px] font-semibold tracking-tight text-[#0a0a0f]">
                            {repo.owner}/{repo.name}
                        </p>
                        {repo.isPrivate && <Badge tone="neutral">private</Badge>}
                        {!repo.watched && <Badge tone="neutral">paused</Badge>}
                    </div>
                    <p className="mt-0.5 truncate text-xs leading-4 text-[var(--color-muted)]">
                        {repo.description || "No description"}
                    </p>
                    {/* mobile stats */}
                    <div className="mt-2 flex gap-3 text-xs text-[var(--color-muted)] sm:hidden">
                        <span className="tabular-nums font-medium text-[var(--color-ink)]">{repo.stats.callSites} calls</span>
                        <span className={dirty ? "font-medium text-amber-600" : ""}>{repo.stats.driftOpen} drift</span>
                        <span>{repo.stats.pullsOpen} PRs</span>
                    </div>
                </div>
                <div className="hidden items-center gap-6 sm:flex">
                    <div className="text-right leading-tight">
                        <p className="text-[13px] font-semibold tabular-nums text-[#0a0a0f]">{repo.stats.callSites}</p>
                        <p className="text-[11px] text-[var(--color-muted)]">call sites</p>
                    </div>
                    <div className="text-right leading-tight">
                        <p className={`text-[13px] font-semibold tabular-nums ${dirty ? "text-amber-600" : "text-[#0a0a0f]"}`}>{repo.stats.driftOpen}</p>
                        <p className="text-[11px] text-[var(--color-muted)]">drift</p>
                    </div>
                    <div className="text-right leading-tight">
                        <p className="text-[13px] font-semibold tabular-nums text-[#0a0a0f]">{repo.stats.pullsOpen}</p>
                        <p className="text-[11px] text-[var(--color-muted)]">PRs</p>
                    </div>
                    <p className="w-20 text-right text-xs tabular-nums text-[var(--color-muted)]">{timeAgo(repo.stats.lastProbeAt)}</p>
                </div>
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-muted)] transition-colors group-hover:border-[var(--color-line)] group-hover:text-zinc-600">→</span>
            </Card>
        </Link>
    );
}

export default function AccountPage({ owner }: { owner: string }) {
    const { data, error, loading } = useFetch(() => getAccountRepos(owner), [owner]);

    const totalDrift = data?.repos.reduce((s, r) => s + r.stats.driftOpen, 0) ?? 0;

    return (
        <div>
            <Link to="/accounts" className="mb-4 inline-flex items-center gap-1 text-xs font-medium text-[var(--color-muted)] hover:text-[var(--color-ink)]">
                ← Accounts
            </Link>
            <PageHeader
                eyebrow="Account"
                title={owner}
                description={totalDrift > 0 ? `${totalDrift} open drift events across ${data?.repos.length ?? 0} repos.` : "Watched repos in this account, ranked by drift health."}
            />

            {loading ? (
                <div className="flex flex-col gap-3">
                    <div className="h-[86px] animate-pulse rounded-[10px] border border-[var(--color-line)] bg-[var(--color-surface)]" />
                    <div className="h-[86px] animate-pulse rounded-[10px] border border-[var(--color-line)] bg-[var(--color-surface)]" />
                </div>
            ) : error ? (
                <div className="rounded-[10px] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
            ) : (
                <div className="flex flex-col gap-3">
                    {data?.repos.map((repo) => (
                        <RepoRow key={`${repo.owner}/${repo.name}`} repo={repo} />
                    ))}
                </div>
            )}
        </div>
    );
}
