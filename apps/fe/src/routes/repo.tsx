import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { getRepo, getRepoDrifts, updateRepoPolicy } from "../api/client";
import type { CallSiteSummary, DriftEvent, Permission, Pull } from "../api/types";
import { Badge, type BadgeTone } from "../components/Badge";
import { Card } from "../components/Card";
import { PageHeader } from "../components/PageHeader";
import { Toggle } from "../components/Toggle";
import { EmptyState } from "../components/EmptyState";
import { useFetch } from "../lib/useFetch";
import { toast } from "../lib/toast";
import { PERMISSION_LABELS, timeAgo } from "../lib/format";
import { track } from "../lib/analytics";

type Tab = "drift" | "callsites" | "pulls";
const TABS: Array<{ id: Tab; label: string; hint: string }> = [
    { id: "drift", label: "Drift", hint: "detected changes" },
    { id: "callsites", label: "Call sites", hint: "API usages" },
    { id: "pulls", label: "Pull requests", hint: "fix PRs" },
];

const SNAPSHOT_TONE: Record<CallSiteSummary["snapshot"], BadgeTone> = {
    baseline: "green",
    drifted: "amber",
    rebaselined: "blue",
    "pending-capture": "neutral",
};
const CONFIDENCE_TONE: Record<DriftEvent["confidence"], BadgeTone> = {
    high: "green",
    medium: "amber",
    low: "red",
};
const STATUS_TONE: Record<DriftEvent["status"], BadgeTone> = {
    detected: "amber",
    fix_generated: "blue",
    pr_created: "blue",
    merged: "green",
    rebaselined: "neutral",
};
const TAG_LABEL: Record<DriftEvent["tag"], string> = {
    traffic: "Live traffic",
    docs: "Docs",
    intercepted: "Intercepted",
};
function asError(err: unknown): string {
    return err instanceof Error ? err.message : "Request failed";
}

function DriftCard({ event, owner, name }: { event: DriftEvent; owner: string; name: string }) {
    const [open, setOpen] = useState(false);
    const confidenceExplain: Record<DriftEvent["confidence"], string> = {
        high: "Single-field change with clear mapping. Fix is deterministic — rename or null check covers it.",
        medium: "Multiple fields changed. Fix covers the primary change; review response reads.",
        low: "Ambiguous shape or multiple type changes. Treat PR as draft and verify manually.",
    };
    useEffect(() => {
        track("drift_card_view", { confidence: event.confidence, status: event.status, changes: event.changes.length });
    }, [event.confidence, event.status, event.changes.length]);

    return (
        <Card className="overflow-hidden p-0">
            <div className="p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <div className="flex flex-wrap items-center gap-1.5">
                            <p className="text-[13px] font-semibold tracking-tight text-[#0a0a0f]">{event.packageName}</p>
                            <span className="text-zinc-300">·</span>
                            <span className="font-mono text-xs text-zinc-600">{event.method}</span>
                            <Badge tone="neutral">{event.callSiteId.slice(0, 8)}</Badge>
                        </div>
                        <p className="mt-1.5 max-w-[560px] text-[13px] leading-5 text-zinc-600">{event.summary}</p>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                        <Badge tone="neutral">{TAG_LABEL[event.tag]}</Badge>
                        <button
                            onClick={() => {
                                const next = !open;
                                setOpen(next);
                                if (next) track("confidence_explained_open", { confidence: event.confidence });
                            }}
                            className={`rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors active:scale-[0.97] ${CONFIDENCE_TONE[event.confidence] === "green" ? "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100" : CONFIDENCE_TONE[event.confidence] === "amber" ? "border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100" : "border-red-200 bg-red-50 text-red-700 hover:bg-red-100"}`}
                            title={confidenceExplain[event.confidence]}
                        >
                            {event.confidence} · why?
                        </button>
                        <Badge tone={STATUS_TONE[event.status]}>{event.status.replace("_", " ")}</Badge>
                    </div>
                </div>

                {event.changes.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                        {event.changes.map((c) => (
                            <span
                                key={`${event.id}-${c.field}`}
                                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[11px] font-medium ${
                                    c.kind === "added" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : c.kind === "removed" ? "border-red-200 bg-red-50 text-red-700" : "border-sky-200 bg-sky-50 text-sky-700"
                                }`}
                            >
                                <span className="opacity-60">{c.kind}</span>
                                <span>·</span>
                                <span>{c.field}</span>
                            </span>
                        ))}
                    </div>
                )}

                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted)]">
                    <span>{timeAgo(event.detectedAt)}</span>
                    <span>·</span>
                    <span className={event.confirmed ? "text-emerald-600" : ""}>{event.confirmed ? "confirmed" : "unconfirmed"}</span>
                    <span>·</span>
                    {event.prNumber ? (
                        <a href={`https://github.com/${owner}/${name}/pull/${event.prNumber}`} target="_blank" rel="noreferrer" className="font-medium text-[var(--color-ink)] underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-600">
                            PR #{event.prNumber} ↗
                        </a>
                    ) : (
                        <span>no PR yet</span>
                    )}
                </div>

                {/* confidence explainer — scope control: one hypothesis, measured */}
                {open && (
                    <div className="mt-4 rounded-[10px] border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-3">
                        <p className="text-xs font-medium text-[var(--color-ink)]">Why {event.confidence} confidence</p>
                        <p className="mt-1 text-xs leading-4 text-[var(--color-muted)]">{confidenceExplain[event.confidence]}</p>
                        <div className="mt-2 flex flex-wrap gap-1.5 font-mono text-[11px]">
                            <span className="rounded bg-[var(--color-surface)] border border-[var(--color-line)] px-1.5 py-0.5 text-zinc-600">{event.changes.length} field changes</span>
                            <span className="rounded bg-[var(--color-surface)] border border-[var(--color-line)] px-1.5 py-0.5 text-zinc-600">{event.confirmed ? "confirmed by traffic" : "unconfirmed"}</span>
                            <span className="rounded bg-[var(--color-surface)] border border-[var(--color-line)] px-1.5 py-0.5 text-zinc-600">tag: {event.tag}</span>
                        </div>
                        <p className="mt-2 text-[11px] text-[var(--color-muted)]">If confidence is low, open the PR as draft and check response reads in {event.method}.</p>
                    </div>
                )}
            </div>
            <div className={`h-1 w-full ${event.confidence === "high" ? "bg-emerald-400" : event.confidence === "medium" ? "bg-amber-400" : "bg-zinc-200"}`} />
        </Card>
    );
}

function CallSiteRow({ site }: { site: CallSiteSummary }) {
    return (
        <Card className="p-4">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-[13px] font-medium text-[#0a0a0f]">{site.method}</p>
                    <p className="mt-1 truncate font-mono text-xs text-[var(--color-muted)]">
                        {site.filePath}:{site.line}
                    </p>
                    <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
                        <span className="rounded bg-[var(--color-surface)] px-1.5 py-0.5 font-mono text-[11px] text-zinc-600">{site.packageName}</span>
                        {site.endpoint ? (
                            <span className="font-mono text-[var(--color-muted)]">
                                {site.httpMethod} {site.endpoint}
                            </span>
                        ) : (
                            <span className="text-[var(--color-muted)]">endpoint pending capture</span>
                        )}
                    </p>
                </div>
                <Badge tone={SNAPSHOT_TONE[site.snapshot]}>{site.snapshot.replace("-", " ")}</Badge>
            </div>
            {(site.requestShape?.length || site.responseFields.length > 0) && (
                <div className="mt-3 rounded-[8px] bg-[var(--color-surface)] px-3 py-2">
                    {site.requestShape && site.requestShape.length > 0 && (
                        <p className="font-mono text-[11px] leading-4 text-[var(--color-muted)]">
                            <span className="font-semibold text-zinc-600">request</span> {site.requestShape.map((f) => f.field).join(", ")}
                        </p>
                    )}
                    {site.responseFields.length > 0 && (
                        <p className="mt-1 font-mono text-[11px] leading-4 text-[var(--color-muted)]">
                            <span className="font-semibold text-zinc-600">reads</span> {site.responseFields.join(", ")}
                        </p>
                    )}
                </div>
            )}
        </Card>
    );
}

function PullRow({ pull }: { pull: Pull }) {
    return (
        <Card className="flex items-center gap-4 p-4 transition-colors hover:bg-[var(--color-surface)]">
            <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs ${pull.status === "open" ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"}`}>
                {pull.status === "open" ? "◐" : "✓"}
            </div>
            <div className="min-w-0 flex-1">
                <a href={pull.url} target="_blank" rel="noreferrer" className="truncate text-[13px] font-medium text-[#0a0a0f] hover:underline">
                    #{pull.number} {pull.title}
                </a>
                <p className="mt-0.5 font-mono text-xs text-[var(--color-muted)]">
                    {pull.branch} · updated {timeAgo(pull.updatedAt)}
                </p>
            </div>
            <Badge tone={pull.status === "open" ? "amber" : "green"}>{pull.status}</Badge>
        </Card>
    );
}

export default function RepoPage({ owner, name }: { owner: string; name: string }) {
    const [tab, setTab] = useState<Tab>("drift");
    const detail = useFetch(() => getRepo(owner, name), [owner, name]);
    const drifts = useFetch(() => getRepoDrifts(owner, name), [owner, name]);
    const repo = detail.data?.repo ?? null;

    async function setPolicy(patch: { watched?: boolean; permission?: Permission }) {
        try {
            await updateRepoPolicy(owner, name, patch);
            detail.reload();
            toast(
                patch.watched !== undefined
                    ? patch.watched
                        ? "Repo watching enabled"
                        : "Repo watching paused"
                    : `Permission set to ${PERMISSION_LABELS[patch.permission as string]}`,
            );
        } catch (err) {
            toast(asError(err));
        }
    }

    return (
        <div>
            <Link to="/accounts/$owner" params={{ owner }} className="mb-4 inline-flex items-center gap-1 text-xs font-medium text-[var(--color-muted)] hover:text-[var(--color-ink)]">
                ← {owner}
            </Link>

            <PageHeader
                eyebrow="Repo"
                title={`${owner}/${name}`}
                description={repo?.description || "Vendor contract, call sites, and fix PRs for this repo."}
                actions={
                    repo && (
                        <div className="flex flex-wrap items-center gap-3">
                            <label className="flex items-center gap-2 rounded-full border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-medium text-[var(--color-ink)]">
                                Watch
                                <Toggle checked={repo.watched} onChange={(watched) => setPolicy({ watched })} label="Watch repo" />
                            </label>
                            <select
                                value={repo.permission}
                                onChange={(e) => setPolicy({ permission: e.target.value as Permission })}
                                className="rounded-full border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-medium text-[var(--color-ink)] focus:border-[var(--color-line)] focus:outline-none"
                            >
                                <option value="read">Read</option>
                                <option value="read-write">Read + write</option>
                                <option value="suggest-only">Suggest only</option>
                            </select>
                        </div>
                    )
                }
            />

            {repo && (
                <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <Card className="px-4 py-3">
                        <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-muted)]">Call sites</p>
                        <p className="mt-1 text-[20px] font-semibold tabular-nums tracking-tight text-[#0a0a0f]">{repo.stats.callSites}</p>
                    </Card>
                    <Card className={`px-4 py-3 ${repo.stats.driftOpen > 0 ? "border-amber-200 bg-amber-50/50" : ""}`}>
                        <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-muted)]">Drift open</p>
                        <p className={`mt-1 text-[20px] font-semibold tabular-nums tracking-tight ${repo.stats.driftOpen > 0 ? "text-amber-600" : "text-[#0a0a0f]"}`}>{repo.stats.driftOpen}</p>
                    </Card>
                    <Card className="px-4 py-3">
                        <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-muted)]">Open PRs</p>
                        <p className="mt-1 text-[20px] font-semibold tabular-nums tracking-tight text-[#0a0a0f]">{repo.stats.pullsOpen}</p>
                    </Card>
                    <Card className="px-4 py-3">
                        <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-muted)]">Pending capture</p>
                        <p className="mt-1 text-[20px] font-semibold tabular-nums tracking-tight text-[#0a0a0f]">{repo.stats.pendingCapture}</p>
                        <p className="text-[11px] text-[var(--color-muted)]">last probe {timeAgo(repo.stats.lastProbeAt)}</p>
                    </Card>
                </div>
            )}

            <div className="mb-5 flex gap-1 rounded-full bg-[var(--color-surface)] p-1">
                {TABS.map(({ id, label }) => (
                    <button
                        key={id}
                        type="button"
                        onClick={() => setTab(id)}
                        className={`flex-1 sm:flex-none rounded-full px-4 py-1.5 text-[13px] font-medium transition-colors ${
                            tab === id ? "bg-[var(--color-surface)] text-[#0a0a0f] shadow-sm" : "text-[var(--color-muted)] hover:text-[var(--color-ink)]"
                        }`}
                    >
                        {label}
                    </button>
                ))}
            </div>

            {tab === "drift" &&
                (drifts.loading ? (
                    <div className="space-y-3">
                        <div className="h-[110px] animate-pulse rounded-[10px] border border-[var(--color-line)] bg-[var(--color-surface)]" />
                        <div className="h-[110px] animate-pulse rounded-[10px] border border-[var(--color-line)] bg-[var(--color-surface)]" />
                    </div>
                ) : drifts.error ? (
                    <div className="rounded-[10px] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{drifts.error}</div>
                ) : (drifts.data?.drifts ?? []).length === 0 ? (
                    <EmptyState title="No drift in the last baseline" hint="Captured traffic matches the recorded snapshots. You are up to date." />
                ) : (
                    <div className="flex flex-col gap-3">
                        {drifts.data?.drifts.map((event) => (
                            <DriftCard key={event.id} event={event} owner={owner} name={name} />
                        ))}
                    </div>
                ))}

            {tab === "callsites" &&
                (detail.loading ? (
                    <p className="text-sm text-[var(--color-muted)]">Loading call sites...</p>
                ) : detail.error ? (
                    <div className="rounded-[10px] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{detail.error}</div>
                ) : (detail.data?.callsites ?? []).length === 0 ? (
                    <EmptyState title="No API call sites found" hint="Imports that resolve to external packages show up here." />
                ) : (
                    <div className="flex flex-col gap-3">
                        {detail.data?.callsites.map((site) => (
                            <CallSiteRow key={site.id} site={site} />
                        ))}
                    </div>
                ))}

            {tab === "pulls" &&
                (detail.loading ? (
                    <p className="text-sm text-[var(--color-muted)]">Loading pull requests...</p>
                ) : detail.error ? (
                    <div className="rounded-[10px] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{detail.error}</div>
                ) : (detail.data?.pulls ?? []).length === 0 ? (
                    <EmptyState title="No pull requests" hint="Fix PRs from the drift pipeline appear here." />
                ) : (
                    <div className="flex flex-col gap-3">
                        {detail.data?.pulls.map((pull) => (
                            <PullRow key={pull.number} pull={pull} />
                        ))}
                    </div>
                ))}
        </div>
    );
}
