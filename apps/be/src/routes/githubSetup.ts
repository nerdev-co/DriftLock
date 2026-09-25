import { getDb, settings } from "@driftlock/db";

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

export async function handleGitHubSetup(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const installationId = url.searchParams.get("installation_id");
    const setupAction = url.searchParams.get("setup_action") || "install";
    const state = url.searchParams.get("state");

    // Persist last installation for debugging
    if (installationId) {
        try {
            const db = getDb();
            await db.execute(`DELETE FROM settings WHERE key = 'last_installation'`);
            await db.insert(settings).values({
                key: "last_installation",
                value: { installationId, setupAction, at: new Date().toISOString() },
            });
        } catch (error) {
            console.error(
                `[githubSetup] failed to persist last_installation for ${installationId}:`,
                error,
            );
        }
    }

    // state may contain returnTo path from handleInstallUrl
    let returnTo = "/";
    if (state) {
        try {
            returnTo = decodeURIComponent(state);
        } catch {
            returnTo = "/";
        }
    }

    // After install/update, land on accounts with a success flag
    const frontend = new URL(FRONTEND_URL);
    let target: URL;
    try {
        target = new URL(returnTo, frontend);
    } catch {
        // A state like "http://host:badport" is not parseable at all, and this
        // route is reachable by browser redirect, so it must not throw.
        target = new URL("/", frontend);
    }
    // A leading-slash check is not enough on its own: "//evil.example" and
    // "/\evil.example" both start with "/" and both resolve to a different
    // origin, so the resolved origin is what actually decides.
    if (target.origin !== frontend.origin) {
        target = new URL("/", frontend);
    }
    target.searchParams.set("installed", "1");
    if (installationId) target.searchParams.set("installation_id", installationId);
    target.searchParams.set("action", setupAction);

    return Response.redirect(target.toString(), 302);
}
