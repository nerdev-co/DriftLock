import { InMemorySchemaStore, DriftDetector, createWebhookFixPR } from "@driftlock/webhookCapture";
import type { DriftAlert, RollbackAlert } from "@driftlock/webhookCapture";
import { getDb } from "@driftlock/db";
import { settings } from "@driftlock/db/schema";

function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: { "content-type": "application/json" },
    });
}

type AIProvider = "openai" | "anthropic" | "gemini" | "cloudflare";

interface WebhookConfig {
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
}

let cachedConfig: WebhookConfig | null = null;
let configLastLoaded = 0;
const CONFIG_TTL_MS = 30_000;

async function loadConfig(): Promise<WebhookConfig> {
    const now = Date.now();
    if (cachedConfig && now - configLastLoaded < CONFIG_TTL_MS) {
        return cachedConfig;
    }

    try {
        const db = getDb();
        const rows = await db
            .select()
            .from(settings)
            .limit(5);

        console.log(`[CONFIG] All settings keys: ${rows.map(r => r.key).join(", ")}`);

        const webhookRow = rows.find(r => r.key === "webhookConfig");
        if (webhookRow) {
            cachedConfig = webhookRow.value as WebhookConfig;
            console.log(`[CONFIG] Loaded: githubToken=${cachedConfig.githubToken ? "set" : "missing"}, repoPath=${cachedConfig.repoPath || "missing"}, repoOwner=${cachedConfig.repoOwner || "missing"}, repoName=${cachedConfig.repoName || "missing"}`);
        } else {
            cachedConfig = {};
            console.log("[CONFIG] No webhookConfig found");
        }
    } catch (e) {
        cachedConfig = {};
        console.log("[CONFIG] DB error:", e);
    }

    configLastLoaded = now;
    return cachedConfig;
}

function getConfigValue<T>(config: WebhookConfig, key: keyof WebhookConfig, envKey: string, fallback: T): T {
    const val = config[key];
    if (val !== undefined && val !== "") return val as T;
    return (process.env[envKey] as T) || fallback;
}

const AI_PROVIDERS: ReadonlySet<string> = new Set([
    "openai",
    "anthropic",
    "gemini",
    "cloudflare",
]);

function getAIConfig(config: WebhookConfig): {
    provider: AIProvider;
    apiKey: string;
    accountId?: string;
    model?: string;
} | undefined {
    const provider = getConfigValue(config, "aiProvider", "AI_PROVIDER", "");
    if (!AI_PROVIDERS.has(provider)) {
        return undefined;
    }

    const typedProvider = provider as AIProvider;
    const apiKeyEnv =
        typedProvider === "cloudflare"
            ? "CLOUDFLARE_API_TOKEN"
            : typedProvider === "gemini"
              ? "GEMINI_API_KEY"
              : "AI_API_KEY";
    const apiKey = getConfigValue(config, "aiApiKey", apiKeyEnv, "");
    const modelEnv =
        typedProvider === "cloudflare"
            ? "CLOUDFLARE_AI_MODEL"
            : typedProvider === "gemini"
              ? "GEMINI_MODEL"
              : "AI_MODEL";
    const model = config.aiModel || process.env[modelEnv] || "";
    const accountId =
        typedProvider === "cloudflare"
            ? getConfigValue(
                  config,
                  "cloudflareAccountId",
                  "CLOUDFLARE_ACCOUNT_ID",
                  "",
              )
            : undefined;

    if (!apiKey || (typedProvider === "cloudflare" && !accountId)) {
        return undefined;
    }

    return {
        provider: typedProvider,
        apiKey,
        accountId,
        model: model || undefined,
    };
}

const store = new InMemorySchemaStore();

// eslint-disable-next-line @typescript-eslint/no-unused-vars
let _detectorResolved = false;
let resolveDetectorPromise: (det: DriftDetector) => void;
const detectorReady = new Promise<DriftDetector>((resolve) => {
    resolveDetectorPromise = resolve;
});

async function initDetector() {
    const config = await loadConfig();
    const threshold = getConfigValue(config, "confidenceThreshold", "CONFIDENCE_THRESHOLD", 0.7);
    const det = new DriftDetector(store, threshold);
    setupDetectorCallbacks(det);
    resolveDetectorPromise(det);
    _detectorResolved = true;
}

// Init lazily on first request, not at module load
let initPromise: Promise<void> | null = null;
function ensureInit() {
    if (!initPromise) {
        initPromise = initDetector();
    }
    return initPromise;
}

function setupDetectorCallbacks(det: DriftDetector) {
    det.onDrift(async (alert: DriftAlert) => {
        const config = await loadConfig();
        console.log(
            `[DRIFT] endpoint=${alert.endpointId} event=${alert.eventType} confidence=${alert.confidence}`,
        );
        console.log(`  added:    ${alert.diff.added.join(", ") || "(none)"}`);
        console.log(`  removed:  ${alert.diff.removed.join(", ") || "(none)"}`);
        console.log(
            `  changed:  ${alert.diff.typeChanged.map((c) => `${c.field}: ${c.from}→${c.to}`).join(", ") || "(none)"}`,
        );

        const githubToken = getConfigValue(config, "githubToken", "GITHUB_TOKEN", "");
        const repoPath = getConfigValue(config, "repoPath", "WEBHOOK_REPO_PATH", "");
        const repoOwner = getConfigValue(config, "repoOwner", "WEBHOOK_OWNER", "");
        const repoName = getConfigValue(config, "repoName", "WEBHOOK_REPO", "");
        const base = process.env.WEBHOOK_BASE || "main";
        const ai = getAIConfig(config);

        if (!githubToken || !repoPath || !repoOwner || !repoName) {
            console.log("  [SKIP] Missing GitHub config — PR not created");
            return;
        }

        try {
            const result = await createWebhookFixPR({
                owner: repoOwner,
                repo: repoName,
                base,
                repoPath,
                alert,
                token: githubToken,
                ai,
            });

            if (result.status === "opened") {
                console.log(`  [PR] Created: ${result.url}`);
            } else if (result.status === "already_open") {
                console.log(`  [PR] Already open: ${result.url}`);
            } else {
                console.log(`  [PR] ${result.status}`);
            }
        } catch (error) {
            console.error(`  [PR] Failed to create PR:`, error);
        }
    });

    det.onRollback(async (alert: RollbackAlert) => {
        const config = await loadConfig();
        console.log(
            `[ROLLBACK] endpoint=${alert.endpointId} event=${alert.eventType}`,
        );
        console.log(`  reverted from schema at ${alert.driftedAt.toISOString()}`);
        console.log(`  current schema matches previous baseline`);

        const githubToken = getConfigValue(config, "githubToken", "GITHUB_TOKEN", "");
        const repoPath = getConfigValue(config, "repoPath", "WEBHOOK_REPO_PATH", "");
        const repoOwner = getConfigValue(config, "repoOwner", "WEBHOOK_OWNER", "");
        const repoName = getConfigValue(config, "repoName", "WEBHOOK_REPO", "");
        const base = process.env.WEBHOOK_BASE || "main";
        const ai = getAIConfig(config);

        if (!githubToken || !repoPath || !repoOwner || !repoName) {
            console.log("  [SKIP] Missing config — rollback PR not created");
            return;
        }

        try {
            const result = await createWebhookFixPR({
                owner: repoOwner,
                repo: repoName,
                base,
                repoPath,
                alert: {
                    endpointId: alert.endpointId,
                    eventType: alert.eventType,
                    diff: {
                        added: Object.keys(alert.revertedTo).filter(
                            (k) => !(k in alert.revertedFrom),
                        ),
                        removed: Object.keys(alert.revertedFrom).filter(
                            (k) => !(k in alert.revertedTo),
                        ),
                        typeChanged: [],
                    },
                    previous: alert.revertedFrom,
                    current: alert.revertedTo,
                    detectedAt: alert.detectedAt,
                    confidence: 100,
                },
                token: githubToken,
                ai,
            });

            if (result.status === "opened") {
                console.log(`  [PR] Rollback PR created: ${result.url}`);
            } else {
                console.log(`  [PR] ${result.status}`);
            }
        } catch (error) {
            console.error(`  [PR] Failed to create rollback PR:`, error);
        }
    });
}

const FORWARD_SECRET = process.env.WEBHOOK_FORWARD_SECRET || "";
const FORWARD_TIMEOUT = parseInt(process.env.WEBHOOK_FORWARD_TIMEOUT || "5000", 10);

async function forwardPayload(
    forwardUrl: string,
    endpointId: string,
    eventType: string,
    body: Record<string, unknown>,
    _headers: Record<string, string>,
): Promise<{ ok: boolean; status: number; elapsed: number }> {
    if (!forwardUrl) {
        return { ok: false, status: 0, elapsed: 0 };
    }

    const start = Date.now();
    try {
        const forwardHeaders: Record<string, string> = {
            "content-type": "application/json",
            "x-driftlock-endpoint": endpointId,
            "x-driftlock-event": eventType,
            "x-driftlock-forwarded": "true",
        };

        if (FORWARD_SECRET) {
            forwardHeaders["x-webhook-secret"] = FORWARD_SECRET;
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FORWARD_TIMEOUT);

        const res = await fetch(forwardUrl, {
            method: "POST",
            headers: forwardHeaders,
            body: JSON.stringify(body),
            signal: controller.signal,
        });

        clearTimeout(timeout);
        const elapsed = Date.now() - start;
        return { ok: res.ok, status: res.status, elapsed };
    } catch (err) {
        const elapsed = Date.now() - start;
        console.error(`  [FORWARD] Failed to ${forwardUrl}:`, err);
        return { ok: false, status: 0, elapsed };
    }
}

export function createCaptureHandler() {
    return async (req: Request): Promise<Response> => {
        if (req.method !== "POST") {
            return json({ error: "Method not allowed" }, 405);
        }

        const url = new URL(req.url);
        const segments = url.pathname.split("/").filter(Boolean);
        const endpointId = segments[segments.length - 1];

        if (!endpointId) {
            return json({ error: "Missing endpoint ID" }, 400);
        }

        let body: Record<string, unknown>;
        try {
            body = (await req.json()) as Record<string, unknown>;
        } catch {
            return json({ error: "Body must be JSON" }, 400);
        }

        const eventType =
            (body.type as string) ??
            req.headers.get("x-webhook-event") ??
            req.headers.get("x-github-event") ??
            "__default__";

        const config = await loadConfig();
        const forwardUrl = getConfigValue(config, "forwardUrl", "WEBHOOK_FORWARD_URL", "");

        await ensureInit();
        const det = await detectorReady;
        const alert = await det.processPayload(
            endpointId,
            eventType,
            body,
        );

        let forwardResult = null;
        if (forwardUrl) {
            const headerObj: Record<string, string> = {};
            req.headers.forEach((value, key) => {
                headerObj[key] = value;
            });
            forwardResult = await forwardPayload(forwardUrl, endpointId, eventType, body, headerObj);
        }

        if (alert) {
            const diff = "diff" in alert ? alert.diff : { added: [], removed: [], typeChanged: [] };
            return json({
                status: "drift_detected",
                endpointId,
                eventType,
                diff,
                pr: "pending",
                forward: forwardResult,
            });
        }

        return json({
            status: "ok",
            endpointId,
            eventType,
            message: "Schema baseline recorded or unchanged",
            forward: forwardResult,
        });
    };
}
