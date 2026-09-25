import { getDb, settings } from "@driftlock/db";

function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: { "content-type": "application/json" },
    });
}

function redirect(url: string): Response {
    return Response.redirect(url);
}

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || "";
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || "";
const GITHUB_APP_SLUG = process.env.GITHUB_APP_SLUG || "";
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8787";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

function generateSessionToken(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function handleGitHubLogin(): Promise<Response> {
    if (!GITHUB_CLIENT_ID) {
        return json({ error: "GitHub OAuth not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET." }, 500);
    }

    const redirectUri = `${BACKEND_URL}/api/auth/github/callback`;

    const params = new URLSearchParams({
        client_id: GITHUB_CLIENT_ID,
        redirect_uri: redirectUri,
        scope: "read:user user:email read:org repo",
    });

    return redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
}

export async function handleGitHubCallback(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const _state = url.searchParams.get("state");

    if (!code) {
        return json({ error: "Missing code parameter" }, 400);
    }

    // Exchange code for access token
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
        },
        body: JSON.stringify({
            client_id: GITHUB_CLIENT_ID,
            client_secret: GITHUB_CLIENT_SECRET,
            code,
        }),
    });

    const tokenData = await tokenRes.json() as { access_token?: string; error?: string };

    if (!tokenData.access_token) {
        return json({ error: "Failed to get access token", details: tokenData }, 400);
    }

    // Get user info
    const userRes = await fetch("https://api.github.com/user", {
        headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
            Accept: "application/vnd.github.v3+json",
        },
    });

    const user = await userRes.json() as {
        login: string;
        name: string;
        avatar_url: string;
        id: number;
    };

    // Get user's orgs
    const orgsRes = await fetch("https://api.github.com/user/orgs", {
        headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
            Accept: "application/vnd.github.v3+json",
        },
    });

    const orgs = await orgsRes.json() as Array<{ login: string; id: number }>;

    // Store session (simplified - use proper session store in production)
    const sessionToken = generateSessionToken();
    const db = getDb();

    // Store user data in settings for now
    await db.execute(`DELETE FROM settings WHERE key = 'session:${sessionToken}'`);
    await db.insert(settings).values({
        key: `session:${sessionToken}`,
        value: {
            userId: user.id,
            login: user.login,
            name: user.name,
            avatarUrl: user.avatar_url,
            accessToken: tokenData.access_token,
            orgs: orgs.map((o) => ({ login: o.login, id: o.id })),
        },
    });

    // Redirect to frontend with session token
    return redirect(`${FRONTEND_URL}/auth/callback?token=${sessionToken}`);
}

export async function handleGetSession(req: Request): Promise<Response> {
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
        return json({ user: null });
    }

    const token = authHeader.slice(7);
    const db = getDb();

    try {
        const result = await db.execute(
            `SELECT value FROM settings WHERE key = 'session:${token}'`
        );

        if (result.length === 0) {
            return json({ user: null });
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const session = (result[0] as { value: any }).value;
        return json({
            user: {
                login: session.login,
                name: session.name,
                avatarUrl: session.avatarUrl,
            },
        });
    } catch (_e) {
        return json({ user: null });
    }
}

export async function handleGitHubRepos(req: Request): Promise<Response> {
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
        return json({ error: "Unauthorized" }, 401);
    }

    const token = authHeader.slice(7);
    const db = getDb();

    try {
        const result = await db.execute(
            `SELECT value FROM settings WHERE key = 'session:${token}'`
        );

        if (result.length === 0) {
            return json({ error: "Invalid session" }, 401);
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const session = (result[0] as { value: any }).value;
        const accessToken = session.accessToken;

        // Fetch user's repos
        const reposRes = await fetch("https://api.github.com/user/repos?per_page=100&sort=updated", {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: "application/vnd.github.v3+json",
            },
        });

        const repos = await reposRes.json() as Array<{
            id: number;
            name: string;
            full_name: string;
            owner: { login: string };
            private: boolean;
            default_branch: string;
            description: string | null;
        }>;

        // Fetch repos from user's orgs
        const orgRepos: typeof repos = [];
        for (const org of session.orgs || []) {
            const orgReposRes = await fetch(`https://api.github.com/orgs/${org.login}/repos?per_page=100&sort=updated`, {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    Accept: "application/vnd.github.v3+json",
                },
            });

            const orgReposData = await orgReposRes.json() as typeof repos;
            orgRepos.push(...orgReposData);
        }

        return json({
            repos: [
                ...repos.map((r) => ({
                    id: r.id,
                    name: r.name,
                    fullName: r.full_name,
                    owner: r.owner.login,
                    private: r.private,
                    defaultBranch: r.default_branch,
                    description: r.description,
                })),
                ...orgRepos.map((r) => ({
                    id: r.id,
                    name: r.name,
                    fullName: r.full_name,
                    owner: r.owner.login,
                    private: r.private,
                    defaultBranch: r.default_branch,
                    description: r.description,
                })),
            ],
            user: {
                login: session.login,
                name: session.name,
                avatarUrl: session.avatarUrl,
            },
        });
    } catch (_error) {
        return json({ error: "Failed to fetch repos" }, 500);
    }
}

export function handleInstallUrl(req: Request): Response {
    if (!GITHUB_APP_SLUG) {
        return json({ error: "GitHub App not configured. Set GITHUB_APP_SLUG." }, 500);
    }

    const url = new URL(req.url);
    const repos = url.searchParams.get("repos"); // comma-separated repo IDs
    const returnTo = url.searchParams.get("returnTo") || "/";

    let installUrl = `https://github.com/apps/${GITHUB_APP_SLUG}/installations/new`;

    const params = new URLSearchParams();
    if (repos) {
        params.set("repositories", repos);
    }
    // state carries where to redirect after install — now points to our success page
    const successPath = "/install/success";
    params.set("state", encodeURIComponent(returnTo === "/" ? successPath : returnTo));

    const queryString = params.toString();
    if (queryString) {
        installUrl += `?${queryString}`;
    }

    return redirect(installUrl);
}

export async function handleLogout(): Promise<Response> {
    return json({ ok: true });
}
