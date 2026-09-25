import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    commitMessageFor,
    createGitHubPublisher,
    isAllowedBranch,
    readChangedFiles,
    runMigrationAgent,
    type ChangePacket,
    type PullRequestPublisher,
} from "@driftlock/agent";
import { FixPRRunner } from "@driftlock/git";

let root: string;

const packet: ChangePacket = {
    provider: "p5",
    fromVersion: "1.11",
    toVersion: "2.3",
    summary: "createCanvas renamed to createSurface",
    migrationDocs: [],
};

const target = { owner: "acme", repo: "widgets", base: "main" };

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "driftlock-pr-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
        join(root, "package.json"),
        JSON.stringify({
            name: "f",
            scripts: { build: 'node -e "process.exit(0)"' },
        }),
    );
    await writeFile(join(root, "src/client.ts"), "createCanvas(1);\n");
    const init = Bun.spawn(["git", "init"], { cwd: root, stdout: "pipe" });
    await init.exited;
    const add = Bun.spawn(["git", "add", "-A"], { cwd: root, stdout: "pipe" });
    await add.exited;
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

function editCall() {
    return {
        choices: [
            {
                message: {
                    content: null,
                    tool_calls: [
                        {
                            id: "e1",
                            function: {
                                name: "editFile",
                                arguments: JSON.stringify({
                                    path: "src/client.ts",
                                    patch: [
                                        "--- a/src/client.ts",
                                        "+++ b/src/client.ts",
                                        "@@ -1 +1 @@",
                                        "-createCanvas(1);",
                                        "+createSurface(1);",
                                    ].join("\n"),
                                }),
                            },
                        },
                    ],
                },
            },
        ],
    };
}

function prCall(branch: string, id = "p1") {
    return {
        choices: [
            {
                message: {
                    content: null,
                    tool_calls: [
                        {
                            id,
                            function: {
                                name: "createPullRequest",
                                arguments: JSON.stringify({
                                    title: "Migrate to p5 2.3",
                                    body: "Renamed the call",
                                    branch,
                                }),
                            },
                        },
                    ],
                },
            },
        ],
    };
}

function buildCall(command: string, id = "v1") {
    return {
        choices: [
            {
                message: {
                    content: null,
                    tool_calls: [
                        {
                            id,
                            function: {
                                name: "runCommand",
                                arguments: JSON.stringify({ command }),
                            },
                        },
                    ],
                },
            },
        ],
    };
}

function scriptedClient(script: unknown[]) {
    let index = 0;
    return {
        chat: {
            completions: {
                create: async () => {
                    const next = script[Math.min(index, script.length - 1)];
                    index += 1;
                    return next as never;
                },
            },
        },
    } as unknown as Parameters<typeof runMigrationAgent>[0]["client"];
}

function recordingPublisher(result?: {
    status: "opened" | "already_open" | "merged";
    url: string;
    number: number;
    branch: string;
}) {
    const seen: Array<Record<string, unknown>> = [];
    const publisher: PullRequestPublisher = {
        publish: async (input) => {
            seen.push(input as unknown as Record<string, unknown>);
            return (
                result ?? {
                    status: "opened" as const,
                    url: "https://github.com/acme/widgets/pull/7",
                    number: 7,
                    branch: input.branch,
                }
            );
        },
    };
    return { publisher, seen };
}

describe("isAllowedBranch", () => {
    test("accepts a driftlock branch", () => {
        expect(isAllowedBranch("driftlock/p5-2-3")).toBe(true);
        expect(isAllowedBranch("driftlock/fix/p5_2.3")).toBe(true);
    });

    test("rejects branches without the prefix", () => {
        expect(isAllowedBranch("main")).toBe(false);
        expect(isAllowedBranch("master")).toBe(false);
        expect(isAllowedBranch("feat/x")).toBe(false);
    });

    test("rejects an empty or prefix-only branch", () => {
        expect(isAllowedBranch("")).toBe(false);
        expect(isAllowedBranch("driftlock/")).toBe(false);
    });

    test("rejects traversal and illegal characters", () => {
        expect(isAllowedBranch("driftlock/../main")).toBe(false);
        expect(isAllowedBranch("driftlock/a b")).toBe(false);
        expect(isAllowedBranch("driftlock/a;rm -rf /")).toBe(false);
        expect(isAllowedBranch("driftlock/a~b")).toBe(false);
    });

    test("rejects an overlong branch", () => {
        expect(isAllowedBranch(`driftlock/${"a".repeat(81)}`)).toBe(false);
    });
});

describe("commitMessageFor", () => {
    test("names the provider and both versions", () => {
        expect(commitMessageFor({ provider: "p5", fromVersion: "1.11", toVersion: "2.3" })).toBe(
            "driftlock: migrate p5 1.11 to 2.3",
        );
    });
});

describe("readChangedFiles", () => {
    test("reads content from disk", async () => {
        const files = await readChangedFiles(root, ["src/client.ts"]);
        expect(files).toEqual([
            { path: "src/client.ts", content: "createCanvas(1);\n" },
        ]);
    });

    test("skips paths that no longer exist", async () => {
        const files = await readChangedFiles(root, ["src/gone.ts"]);
        expect(files).toEqual([]);
    });
});

describe("createGitHubPublisher", () => {
    function fakeOctokit(calls: Array<{ name: string; params: unknown }>) {
        const noPrYet = () => {
            const err = new Error("Not Found") as Error & { status: number };
            err.status = 404;
            throw err;
        };
        return {
            rest: {
                pulls: {
                    list: async () => {
                        calls.push({ name: "pulls.list", params: {} });
                        return { data: [] };
                    },
                    create: async (params: unknown) => {
                        calls.push({ name: "pulls.create", params });
                        return {
                            data: {
                                html_url:
                                    "https://github.com/acme/widgets/pull/99",
                                number: 99,
                            },
                        };
                    },
                },
                git: {
                    getRef: async (params: { ref: string }) => {
                        calls.push({ name: "git.getRef", params });
                        if (params.ref.startsWith("heads/driftlock/")) noPrYet();
                        return { data: { object: { sha: "base-commit" } } };
                    },
                    getCommit: async () => {
                        calls.push({
                            name: "git.getCommit",
                            params: {},
                        });
                        return {
                            data: { sha: "base-commit", tree: { sha: "base-tree" } },
                        };
                    },
                    createBlob: async (params: { content: string }) => {
                        calls.push({ name: "git.createBlob", params });
                        return { data: { sha: `blob-${params.content.length}` } };
                    },
                    createTree: async (params: unknown) => {
                        calls.push({ name: "git.createTree", params });
                        return { data: { sha: "tree-new" } };
                    },
                    createCommit: async (params: unknown) => {
                        calls.push({ name: "git.createCommit", params });
                        return { data: { sha: "commit-new" } };
                    },
                    createRef: async (params: unknown) => {
                        calls.push({ name: "git.createRef", params });
                    },
                    updateRef: async (params: unknown) => {
                        calls.push({ name: "git.updateRef", params });
                    },
                },
            },
        };
    }

    test("drives the git data API from a validated migration", async () => {
        const calls: Array<{ name: string; params: unknown }> = [];
        const publisher = createGitHubPublisher(
            new FixPRRunner(fakeOctokit(calls) as never),
        );

        const result = await runMigrationAgent({
            root,
            packet,
            publisher,
            target,
            client: scriptedClient([
                editCall(),
                buildCall("npm run build"),
                prCall("driftlock/p5-2-3"),
            ]),
        });

        const names = calls.map((call) => call.name);
        expect(names).toEqual([
            "pulls.list",
            "git.getRef",
            "git.getCommit",
            "git.createBlob",
            "git.createTree",
            "git.createCommit",
            "git.getRef",
            "git.createRef",
            "pulls.create",
        ]);

        const blob = calls.find((call) => call.name === "git.createBlob");
        expect((blob?.params as { content: string }).content).toContain(
            "createSurface(1);",
        );

        const ref = calls.find((call) => call.name === "git.createRef");
        expect((ref?.params as { ref: string }).ref).toBe(
            "refs/heads/driftlock/p5-2-3",
        );

        expect(result.state.pullRequest).toEqual({
            status: "opened",
            url: "https://github.com/acme/widgets/pull/99",
            number: 99,
            branch: "driftlock/p5-2-3",
        });
    });

    test("reports an existing open PR instead of opening a second one", async () => {
        const calls: Array<{ name: string; params: unknown }> = [];
        const octokit = {
            rest: {
                pulls: {
                    list: async () => ({
                        data: [
                            {
                                state: "open",
                                html_url: "https://github.com/acme/widgets/pull/5",
                                number: 5,
                            },
                        ],
                    }),
                    create: async () => {
                        throw new Error("should not create a second PR");
                    },
                },
            },
        };
        const publisher = createGitHubPublisher(
            new FixPRRunner(octokit as never),
        );

        const result = await runMigrationAgent({
            root,
            packet,
            publisher,
            target,
            client: scriptedClient([
                editCall(),
                buildCall("npm run build"),
                prCall("driftlock/p5-2-3"),
            ]),
        });

        expect(calls).toHaveLength(0);
        expect(result.state.pullRequest?.status).toBe("already_open");
        expect(result.state.pullRequest?.number).toBe(5);
    });
});

describe("createPullRequest", () => {
    test("publishes through the real git package after a passing check", async () => {
        const { publisher, seen } = recordingPublisher();
        const result = await runMigrationAgent({
            root,
            packet,
            publisher,
            target,
            client: scriptedClient([
                editCall(),
                buildCall("npm run build"),
                prCall("driftlock/p5-2-3"),
            ]),
        });

        // No contract gates this run, so the verified diff is review-only even
        // though the PR itself opened.
        expect(result.outcome).toBe("review_pr");
        expect(result.state.pullRequest).toEqual({
            status: "opened",
            url: "https://github.com/acme/widgets/pull/7",
            number: 7,
            branch: "driftlock/p5-2-3",
        });
        expect(seen).toHaveLength(1);
        expect(seen[0].target).toEqual(target);
        expect(seen[0].branch).toBe("driftlock/p5-2-3");
        expect(seen[0].commitMessage).toBe("driftlock: migrate p5 1.11 to 2.3");
        expect(seen[0].files).toEqual([
            { path: "src/client.ts", content: "createSurface(1);\n" },
        ]);
    });

    test("refuses a branch outside the driftlock namespace", async () => {
        const { publisher, seen } = recordingPublisher();
        const result = await runMigrationAgent({
            root,
            packet,
            publisher,
            target,
            client: scriptedClient([
                editCall(),
                buildCall("npm run build"),
                prCall("main"),
            ]),
        });

        expect(seen).toHaveLength(0);
        const entry = result.state.transcript.find(
            (item) => item.role === "tool" && item.toolCallId === "p1",
        );
        expect(entry?.content).toContain("Refusing branch");
    });

    test("refuses when no verification command passed", async () => {
        const { publisher, seen } = recordingPublisher();
        const result = await runMigrationAgent({
            root,
            packet,
            publisher,
            target,
            client: scriptedClient([editCall(), prCall("driftlock/p5-2-3")]),
        });

        expect(seen).toHaveLength(0);
        const entry = result.state.transcript.find(
            (item) => item.role === "tool" && item.toolCallId === "p1",
        );
        expect(entry?.content).toContain("no passing verification command");
    });

    test("refuses when no file changed", async () => {
        const { publisher, seen } = recordingPublisher();
        const result = await runMigrationAgent({
            root,
            packet,
            publisher,
            target,
            client: scriptedClient([prCall("driftlock/p5-2-3")]),
        });

        expect(seen).toHaveLength(0);
        const entry = result.state.transcript.find(
            (item) => item.role === "tool" && item.toolCallId === "p1",
        );
        expect(entry?.content).toContain("no changed files");
    });

    test("previews instead of publishing when no publisher is wired", async () => {
        const result = await runMigrationAgent({
            root,
            packet,
            target,
            client: scriptedClient([
                editCall(),
                buildCall("npm run build"),
                prCall("driftlock/p5-2-3"),
            ]),
        });

        expect(result.state.pullRequest).toBeUndefined();
        const entry = result.state.transcript.find(
            (item) => item.role === "tool" && item.toolCallId === "p1",
        );
        expect(entry?.content).toContain("PREVIEW ONLY");
    });

    test("refuses a title that is only whitespace", async () => {
        const { publisher, seen } = recordingPublisher();
        await runMigrationAgent({
            root,
            packet,
            publisher,
            target,
            client: scriptedClient([
                editCall(),
                buildCall("npm run build"),
                prCall("driftlock/p5-2-3"),
            ]),
        });
        expect(seen).toHaveLength(1);

        const blankTitle = {
            choices: [
                {
                    message: {
                        content: null,
                        tool_calls: [
                            {
                                id: "blank",
                                function: {
                                    name: "createPullRequest",
                                    arguments: JSON.stringify({
                                        title: "   ",
                                        body: "b",
                                        branch: "driftlock/x",
                                    }),
                                },
                            },
                        ],
                    },
                },
            ],
        };
        const second = await runMigrationAgent({
            root,
            packet,
            publisher,
            target,
            client: scriptedClient([editCall(), buildCall("npm run build"), blankTitle]),
        });
        expect(seen).toHaveLength(1);
        const entry = second.state.transcript.find(
            (item) => item.role === "tool" && item.toolCallId === "blank",
        );
        expect(entry?.content).toContain("requires a title");
    });
});
