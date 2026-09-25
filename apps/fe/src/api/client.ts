import type {
    Account,
    ApiKey,
    CallSiteSummary,
    DriftEvent,
    Permission,
    Pull,
    Repo,
    RepoDetail,
    Settings,
    User,
    WebhookEndpoint,
    WebhookSchema,
    WebhookDrift,
} from "./types";

const BASE = import.meta.env.VITE_API_URL ?? "";

export class ApiError extends Error {
    constructor(
        public status: number,
        message: string,
    ) {
        super(message);
    }
}

const READ_METHODS = new Set(["GET", "HEAD"]);

/**
 * Whether a request may fall back to a fabricated empty payload. Absent a
 * method this is a read, which is what every `get*` helper relies on.
 */
function isRead(init?: RequestInit): boolean {
    const method = init?.method?.toUpperCase();
    return method === undefined || READ_METHODS.has(method);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
        res = await fetch(`${BASE}${path}`, {
            headers: { "content-type": "application/json" },
            ...init,
        });
    } catch (err) {
        // Network failure. The demo fallbacks below are for reads only: a
        // failed write must never look like it succeeded, or the UI reports a
        // saved setting that was never persisted.
        if (!isRead(init)) {
            throw new ApiError(0, err instanceof Error ? err.message : "Network error");
        }
        // Backend offline in demo mode. Empty payloads for non-mutating reads.
        if (path === "/api/accounts") return { accounts: [] } as unknown as T;
        if (path === "/api/me") throw new ApiError(0, "Backend offline");
        if (path.startsWith("/api/webhooks")) {
            if (path.includes("/drifts")) return { drifts: [] } as unknown as T;
            if (path.includes("/endpoints")) return { endpoints: [] } as unknown as T;
            if (path.includes("/schemas")) return { schemas: [] } as unknown as T;
        }
        if (path.startsWith("/api/settings")) throw new ApiError(0, "Backend offline");
        if (path.startsWith("/api/accounts")) return { repos: [] } as unknown as T;
        if (path.startsWith("/api/repos")) {
            if (path.endsWith("/drifts")) return { drifts: [] } as unknown as T;
            if (path.endsWith("/callsites")) return { callsites: [] } as unknown as T;
            if (path.endsWith("/pulls")) return { pulls: [] } as unknown as T;
            return { repo: null, callsites: [], pulls: [] } as unknown as T;
        }
        throw new ApiError(0, err instanceof Error ? err.message : "Network error");
    }
    if (!res.ok) {
        // 502/503 from proxy when backend not running. Reads get the same demo
        // treatment as a network failure; a write gets the real error, so a
        // failed save surfaces as failed rather than silently succeeding.
        const offline = res.status === 502 || res.status === 503 || res.status === 504;
        if (offline && isRead(init) && path.startsWith("/api/")) {
            if (path === "/api/accounts") return { accounts: [] } as unknown as T;
            if (path === "/api/me") throw new ApiError(0, "Backend offline");
            if (path.startsWith("/api/webhooks")) {
                if (path.includes("/drifts")) return { drifts: [] } as unknown as T;
                if (path.includes("/endpoints")) return { endpoints: [] } as unknown as T;
                if (path.includes("/schemas")) return { schemas: [] } as unknown as T;
            }
        }
        const body = await res.json().catch(() => null);
        throw new ApiError(
            res.status,
            (body as { error?: string } | null)?.error ?? res.statusText,
        );
    }
    return res.json() as Promise<T>;
}

export function getMe(): Promise<{ user: User }> {
    return request("/api/me");
}

export function getAccounts(): Promise<{ accounts: Account[] }> {
    return request("/api/accounts");
}

export function getAccountRepos(owner: string): Promise<{ repos: Repo[] }> {
    return request(`/api/accounts/${encodeURIComponent(owner)}/repos`);
}

export function getRepo(o: string, n: string): Promise<RepoDetail> {
    return request(
        `/api/repos/${encodeURIComponent(o)}/${encodeURIComponent(n)}`,
    );
}

export function getRepoDrifts(o: string, n: string): Promise<{ drifts: DriftEvent[] }> {
    return request(
        `/api/repos/${encodeURIComponent(o)}/${encodeURIComponent(n)}/drifts`,
    );
}

export function getRepoPulls(o: string, n: string): Promise<{ pulls: Pull[] }> {
    return request(
        `/api/repos/${encodeURIComponent(o)}/${encodeURIComponent(n)}/pulls`,
    );
}

export function getRepoCallSites(
    o: string,
    n: string,
): Promise<{ callsites: CallSiteSummary[] }> {
    return request(
        `/api/repos/${encodeURIComponent(o)}/${encodeURIComponent(n)}/callsites`,
    );
}

export function getSettings(): Promise<{ settings: Settings }> {
    return request("/api/settings");
}

export function updateSettings(
    patch: Partial<Pick<Settings, "autoProbe" | "forwardWhitelist">> & {
        webhookConfig?: Partial<Settings["webhookConfig"]>;
    },
): Promise<{ settings: Settings }> {
    return request("/api/settings", {
        method: "PUT",
        body: JSON.stringify(patch),
    });
}

export function updateRepoPolicy(
    o: string,
    n: string,
    patch: Partial<{ watched: boolean; permission: Permission; schedule: string }>,
): Promise<{ repo: Repo }> {
    return request(
        `/api/repos/${encodeURIComponent(o)}/${encodeURIComponent(n)}/policy`,
        {
            method: "PUT",
            body: JSON.stringify(patch),
        },
    );
}

export function rotateApiKey(name: string): Promise<{ key: ApiKey & { raw: string } }> {
    return request(`/api/settings/rotate?name=${encodeURIComponent(name)}`, {
        method: "POST",
    });
}

export function getWebhookEndpoints(): Promise<{ endpoints: WebhookEndpoint[] }> {
    return request("/api/webhooks/endpoints");
}

export function getWebhookSchemas(
    endpointId: string,
): Promise<{ schemas: WebhookSchema[] }> {
    return request(
        `/api/webhooks/endpoints/${encodeURIComponent(endpointId)}/schemas`,
    );
}

export function getWebhookDrifts(
    endpointId?: string,
): Promise<{ drifts: WebhookDrift[] }> {
    const params = endpointId ? `?endpointId=${encodeURIComponent(endpointId)}` : "";
    return request(`/api/webhooks/drifts${params}`);
}