import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import * as dbModule from "@driftlock/db";

const FRONTEND = "http://localhost:5173";
process.env.FRONTEND_URL = FRONTEND;

const getDbSpy = spyOn(dbModule, "getDb");
const consoleErrorSpy = spyOn(console, "error");
afterEach(() => {
    getDbSpy.mockReset();
    consoleErrorSpy.mockReset();
});
afterAll(() => {
    getDbSpy.mockRestore();
    consoleErrorSpy.mockRestore();
});

const { handleGitHubSetup } = await import("../src/routes/githubSetup");

function workingDb() {
    getDbSpy.mockReturnValue({
        execute: async () => undefined,
        insert: () => ({ values: async () => undefined }),
    } as unknown as ReturnType<typeof dbModule.getDb>);
}

function failingDb() {
    getDbSpy.mockImplementation(() => {
        throw new Error("db unavailable");
    });
}

function setup(state?: string): Request {
    const url = new URL("http://localhost/api/github/setup");
    if (state !== undefined) url.searchParams.set("state", state);
    return new Request(url);
}

function location(res: Response): URL {
    return new URL(res.headers.get("location")!);
}

describe("github setup redirect", () => {
    test("keeps a same-origin returnTo", async () => {
        workingDb();
        const res = await handleGitHubSetup(setup(encodeURIComponent("/accounts")));
        expect(res.status).toBe(302);
        const target = location(res);
        expect(target.origin).toBe(FRONTEND);
        expect(target.pathname).toBe("/accounts");
    });

    test("accepts an absolute returnTo on the frontend origin", async () => {
        workingDb();
        const res = await handleGitHubSetup(setup(encodeURIComponent("http://localhost:5173/accounts")));
        expect(location(res).pathname).toBe("/accounts");
    });

    // "//host" and "/\host" both start with "/" and both resolve off-origin, so
    // a leading-slash check is not sufficient on its own.
    for (const state of [
        "//evil.example/steal",
        "/\\evil.example/steal",
        "\\\\evil.example/steal",
        "https://evil.example/steal",
        "http://localhost:5173.evil.example/steal",
    ]) {
        test(`refuses off-origin returnTo ${JSON.stringify(state)}`, async () => {
            workingDb();
            const res = await handleGitHubSetup(setup(encodeURIComponent(state)));
            const target = location(res);
            expect(target.origin).toBe(FRONTEND);
            expect(target.hostname).not.toContain("evil.example");
        });
    }

    test("falls back to the frontend root on malformed state", async () => {
        workingDb();
        const res = await handleGitHubSetup(setup("%E0%A4%A"));
        expect(location(res).origin).toBe(FRONTEND);
    });

    test("still redirects when persisting the installation fails", async () => {
        failingDb();
        const res = await handleGitHubSetup(
            new Request("http://localhost/api/github/setup?installation_id=42"),
        );
        expect(res.status).toBe(302);
        expect(location(res).searchParams.get("installation_id")).toBe("42");
        expect(consoleErrorSpy).toHaveBeenCalled();
    });
});
