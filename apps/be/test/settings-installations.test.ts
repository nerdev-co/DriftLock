import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import * as storeModule from "../src/store";
import { handleInstallationsSync } from "../src/routes/installations";
import { handleUpdateSettings } from "../src/routes/settings";

const storeSpy = spyOn(storeModule, "getStore");
afterEach(() => storeSpy.mockReset());
afterAll(() => storeSpy.mockRestore());

function request(body: unknown): Request {
    return new Request("http://localhost/api", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
}

function installStore(config: Record<string, unknown> = {}) {
    const settings = new Map<string, unknown>([["webhookConfig", config]]);
    const repositories: unknown[] = [];
    storeSpy.mockReturnValue({
        getSetting: async (key: string) => settings.get(key),
        setSetting: async (key: string, value: unknown) => { settings.set(key, value); },
        listApiKeys: async () => [],
        ensureRepository: async (repo: unknown) => { repositories.push(repo); },
    } as unknown as ReturnType<typeof storeModule.getStore>);
    return { settings, repositories };
}

describe("installation batch validation", () => {
    for (const invalid of [null, [], "repo", {}, { owner: "a", name: " " }, { owner: "a", name: "b", fullName: 1 }]) {
        test(`rejects invalid entry ${JSON.stringify(invalid)} before writing`, async () => {
            const { repositories } = installStore();
            const response = await handleInstallationsSync(request({ repos: [{ owner: "a", name: "b" }, invalid] }));
            expect(response.status).toBe(400);
            expect(repositories).toEqual([]);
        });
    }

    test("normalizes valid entries before storing them", async () => {
        const { repositories } = installStore();
        const response = await handleInstallationsSync(request({ repos: [{ owner: " a ", name: " b " }] }));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ synced: 1 });
        expect(repositories).toEqual([{ owner: "a", name: "b", fullName: "a/b" }]);
    });
});

describe("provider credentials", () => {
    for (const patch of [{ aiProvider: "gemini" }, { aiProvider: "gemini", aiApiKey: "old-key" }]) {
        test(`clears the previous provider key for ${JSON.stringify(patch)}`, async () => {
            const { settings } = installStore({ aiProvider: "openai", aiApiKey: "old-key" });
            await handleUpdateSettings(request({ webhookConfig: patch }));
            expect(settings.get("webhookConfig")).toEqual({ aiProvider: "gemini", aiApiKey: "" });
        });
    }

    test("keeps an explicitly replaced key on provider change", async () => {
        const { settings } = installStore({ aiProvider: "openai", aiApiKey: "old-key" });
        await handleUpdateSettings(request({ webhookConfig: { aiProvider: "gemini", aiApiKey: "new-key" } }));
        expect(settings.get("webhookConfig")).toEqual({ aiProvider: "gemini", aiApiKey: "new-key" });
    });

    test("keeps the key when the provider is unchanged", async () => {
        const { settings } = installStore({ aiProvider: "gemini", aiApiKey: "saved-key" });
        await handleUpdateSettings(request({ webhookConfig: { aiModel: "model" } }));
        expect(settings.get("webhookConfig")).toEqual({ aiProvider: "gemini", aiApiKey: "saved-key", aiModel: "model" });
    });

    for (const patch of [{ aiProvider: "cloudflare" }, { aiProvider: "cloudflare", aiModel: "" }]) {
        test(`clears the previous provider model for ${JSON.stringify(patch)}`, async () => {
            const { settings } = installStore({
                aiProvider: "gemini",
                aiApiKey: "old-key",
                aiModel: "gemini-2.5-flash",
            });
            await handleUpdateSettings(request({ webhookConfig: patch }));
            expect(settings.get("webhookConfig")).toEqual({ aiProvider: "cloudflare", aiApiKey: "", aiModel: "" });
        });
    }

    test("keeps a model explicitly supplied for the new provider", async () => {
        const { settings } = installStore({
            aiProvider: "gemini",
            aiApiKey: "old-key",
            aiModel: "gemini-2.5-flash",
        });
        await handleUpdateSettings(request({ webhookConfig: { aiProvider: "cloudflare", aiModel: "@cf/google/gemma-4-26b-a4b-it" } }));
        expect(settings.get("webhookConfig")).toEqual({
            aiProvider: "cloudflare",
            aiApiKey: "",
            aiModel: "@cf/google/gemma-4-26b-a4b-it",
        });
    });

    test("keeps the model when the provider is unchanged", async () => {
        const { settings } = installStore({ aiProvider: "gemini", aiModel: "gemini-2.5-flash" });
        await handleUpdateSettings(request({ webhookConfig: { aiModel: "gemini-2.0-flash" } }));
        expect(settings.get("webhookConfig")).toEqual({ aiProvider: "gemini", aiModel: "gemini-2.0-flash" });
    });
});
