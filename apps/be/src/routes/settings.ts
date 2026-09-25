import { getStore } from "../store";
import { apiKeyDto, type ApiKeyDto } from "../dto";
import { badRequest, json } from "../utils";

export interface AppSettings {
    autoProbe: boolean;
    forwardWhitelist: string[];
    apiKeys: ApiKeyDto[];
    probeCredentials: Array<{
        provider: string;
        kind: string;
        masked: string;
    }>;
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

const AUTO_PROBE = "autoProbe";
const FORWARD_WHITELIST = "forwardWhitelist";
const PROBE_CREDENTIALS = "probeCredentials";
const WEBHOOK_CONFIG = "webhookConfig";

export async function handleGetSettings(): Promise<Response> {
    const store = getStore();
    const settings: AppSettings = {
        autoProbe:
            (await store.getSetting<boolean>(AUTO_PROBE)) ?? false,
        forwardWhitelist:
            (await store.getSetting<string[]>(FORWARD_WHITELIST)) ?? [],
        apiKeys: (await store.listApiKeys()).map(apiKeyDto),
        probeCredentials:
            (await store.getSetting<AppSettings["probeCredentials"]>(
                PROBE_CREDENTIALS,
            )) ?? [],
        webhookConfig:
            (await store.getSetting<AppSettings["webhookConfig"]>(
                WEBHOOK_CONFIG,
            )) ?? {},
    };
    return json({ settings });
}

export async function handleUpdateSettings(req: Request): Promise<Response> {
    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return badRequest("Body must be JSON");
    }
    if (typeof body !== "object" || body === null) {
        return badRequest("Body must be an object");
    }
    const patch = body as Record<string, unknown>;
    const store = getStore();
    if (typeof patch.autoProbe === "boolean") {
        await store.setSetting(AUTO_PROBE, patch.autoProbe);
    }
    if (Array.isArray(patch.forwardWhitelist)) {
        await store.setSetting(
            FORWARD_WHITELIST,
            patch.forwardWhitelist.filter(
                (entry): entry is string => typeof entry === "string",
            ),
        );
    }
    if (typeof patch.webhookConfig === "object" && patch.webhookConfig !== null) {
        const existing = await store.getSetting<AppSettings["webhookConfig"]>(WEBHOOK_CONFIG) ?? {};
        const incoming = patch.webhookConfig as Record<string, unknown>;
        const updated = { ...existing, ...incoming };
        if (updated.aiProvider !== existing.aiProvider) {
            // Model names are provider-specific, so a model saved for the old
            // provider is not a valid default for the new one.
            if (updated.aiApiKey === existing.aiApiKey) {
                updated.aiApiKey = "";
            }
            if (typeof incoming.aiModel !== "string" || incoming.aiModel === "") {
                // Only clear a model that was actually saved, so a provider
                // change does not add a field the config never had.
                if ("aiModel" in updated) {
                    updated.aiModel = "";
                }
            }
        }
        await store.setSetting(WEBHOOK_CONFIG, updated);
    }
    return handleGetSettings();
}

export async function handleRotateApiKey(url: URL): Promise<Response> {
    const name = url.searchParams.get("name")?.trim();
    if (!name) {
        return badRequest("Missing ?name=");
    }
    const store = getStore();
    const key = await store.rotateApiKey(name);
    return json(
        {
            key: {
                ...apiKeyDto(key.row),
                raw: key.raw,
            },
        },
        201,
    );
}