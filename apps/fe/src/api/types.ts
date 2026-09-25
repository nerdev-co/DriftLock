export type Permission = "read" | "read-write" | "suggest-only";

export interface User {
    name: string;
    handle: string;
    avatarUrl: string;
}

export interface Account {
    owner: string;
    kind: "user" | "organization";
    installedAt: string;
    repoCount: number;
    driftOpen: number;
    pullsOpen: number;
}

export interface Repo {
    owner: string;
    name: string;
    description: string;
    isPrivate: boolean;
    defaultBranch: string;
    watched: boolean;
    permission: Permission;
    schedule: string;
    stats: {
        callSites: number;
        driftOpen: number;
        pullsOpen: number;
        pendingCapture: number;
        healthy: boolean;
        lastProbeAt: string | null;
    };
}

export type SnapshotState =
    | "baseline"
    | "drifted"
    | "pending-capture"
    | "rebaselined";

export interface CallSiteSummary {
    id: string;
    filePath: string;
    line: number;
    method: string;
    packageName: string;
    endpoint: string | null;
    httpMethod: string | null;
    snapshot: SnapshotState;
    requestShape: Array<{ field: string; type: string }> | null;
    responseFields: string[];
}

export type DriftStatus =
    | "detected"
    | "fix_generated"
    | "pr_created"
    | "merged"
    | "rebaselined";

export type DriftTag = "traffic" | "docs" | "intercepted";

export interface DriftEvent {
    id: string;
    callSiteId: string;
    method: string;
    packageName: string;
    detectedAt: string;
    confidence: "high" | "medium" | "low";
    status: DriftStatus;
    summary: string;
    changes: Array<{ field: string; kind: string }>;
    prNumber: number | null;
    tag: DriftTag;
    confirmed: boolean;
}

export interface Pull {
    number: number;
    title: string;
    branch: string;
    status: "open" | "merged" | "closed";
    updatedAt: string;
    url: string;
}

export interface ApiKey {
    id: string;
    name: string;
    keyMasked: string;
    createdAt: string;
    raw?: string;
}

export interface Settings {
    autoProbe: boolean;
    forwardWhitelist: string[];
    apiKeys: ApiKey[];
    probeCredentials: Array<{ provider: string; kind: string; masked: string }>;
    webhookConfig: {
        githubToken?: string;
        repoPath?: string;
        repoOwner?: string;
        repoName?: string;
        aiProvider?: string;
        aiApiKey?: string;
        aiModel?: string;
        cloudflareAccountId?: string;
        forwardUrl?: string;
        confidenceThreshold?: number;
    };
}

export interface RepoDetail {
    repo: Repo;
    callsites: CallSiteSummary[];
    pulls: Pull[];
}

export interface WebhookEndpoint {
    id: string;
    name: string;
    url: string;
    repositoryId: string | null;
    active: boolean;
    createdAt: string;
    updatedAt: string;
}

export interface WebhookSchema {
    id: string;
    endpointId: string;
    eventType: string;
    flattenedSchema: Record<string, string>;
    capturedAt: string;
}

export interface WebhookDrift {
    id: string;
    endpointId: string;
    eventType: string;
    diff: {
        added: string[];
        removed: string[];
        typeChanged: Array<{ field: string; from: string; to: string }>;
    };
    previousSchema: Record<string, string>;
    currentSchema: Record<string, string>;
    detectedAt: string;
    status: string;
}