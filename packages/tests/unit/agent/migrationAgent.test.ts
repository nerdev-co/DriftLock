import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrationAgent, type ChangePacket } from "@driftlock/agent";

type FakeCall = {
    choices: Array<{
        message: {
            content?: string | null;
            tool_calls?: Array<{
                id: string;
                function: { name: string; arguments: string };
            }>;
        };
    }>;
};

let root: string;
let apiCalls: FakeCall[];

function toolCall(name: string, args: Record<string, unknown>, id = "call_1") {
    return {
        choices: [
            {
                message: {
                    content: null,
                    tool_calls: [
                        { id, function: { name, arguments: JSON.stringify(args) } },
                    ],
                },
            },
        ],
    } satisfies FakeCall;
}

function finalText(text: string): FakeCall {
    return { choices: [{ message: { content: text } }] };
}

function fakeClient() {
    let index = 0;
    return {
        chat: {
            completions: {
                create: async () => {
                    const next = apiCalls[Math.min(index, apiCalls.length - 1)];
                    index += 1;
                    if (!next) throw new Error("fakeClient called with no scripted responses");
                    return next;
                },
            },
        },
    } as unknown as Parameters<typeof runMigrationAgent>[0]["client"];
}

const packet: ChangePacket = {
    provider: "p5",
    fromVersion: "1.11",
    toVersion: "2.3",
    summary: "createCanvas renamed to createSurface",
    migrationDocs: ["https://example.test/p5-2.3"],
};

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "driftlock-loop-"));
    apiCalls = [];
    await writeFile(
        join(root, "package.json"),
        JSON.stringify({
            name: "fixture",
            scripts: {
                build: "node -e \"process.exit(0)\"",
                typecheck: "node -e \"process.exit(0)\"",
            },
        }),
    );
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src/client.ts"), "createCanvas(1);\n");
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe("runMigrationAgent", () => {
    test("walks inspect, search, read, edit, verify, then opens a PR", async () => {
        const init = Bun.spawn(["git", "init"], { cwd: root, stdout: "pipe" });
        await init.exited;
        const add = Bun.spawn(["git", "add", "-A"], { cwd: root, stdout: "pipe" });
        await add.exited;

        apiCalls = [
            toolCall("inspectRepo", {}, "c1"),
            toolCall("searchCode", { query: "createCanvas" }, "c2"),
            toolCall("readFile", { path: "src/client.ts" }, "c3"),
            toolCall(
                "editFile",
                {
                    path: "src/client.ts",
                    patch: [
                        "--- a/src/client.ts",
                        "+++ b/src/client.ts",
                        "@@ -1 +1 @@",
                        "-createCanvas(1);",
                        "+createSurface(1);",
                    ].join("\n"),
                },
                "c4",
            ),
            toolCall("runCommand", { command: "npm run build" }, "c5"),
            toolCall(
                "createPullRequest",
                { title: "Migrate to p5 2.3", body: "Renamed call", branch: "driftlock/p5-2.3" },
                "c6",
            ),
        ];

        const result = await runMigrationAgent({ root, packet, client: fakeClient() });

        // No contract gates this run, so the verified diff is review-only.
        expect(result.outcome).toBe("review_pr");
        expect(result.filesChanged).toEqual(["src/client.ts"]);
        expect(result.state.commandsRun).toBe(1);
        expect(result.state.lastTestResult?.passed).toBe(true);
        expect(result.state.iteration).toBe(6);

        const updated = await Bun.file(join(root, "src/client.ts")).text();
        expect(updated).toContain("createSurface(1)");
    });

    test("reports draft_pr when the caller prefers drafts and no contract gates the run", async () => {
        const init = Bun.spawn(["git", "init"], { cwd: root, stdout: "pipe" });
        await init.exited;
        const add = Bun.spawn(["git", "add", "-A"], { cwd: root, stdout: "pipe" });
        await add.exited;

        apiCalls = [
            toolCall(
                "editFile",
                {
                    path: "src/client.ts",
                    patch: [
                        "--- a/src/client.ts",
                        "+++ b/src/client.ts",
                        "@@ -1 +1 @@",
                        "-createCanvas(1);",
                        "+createSurface(1);",
                    ].join("\n"),
                },
                "c1",
            ),
            toolCall("runCommand", { command: "npm run build" }, "c2"),
            toolCall(
                "createPullRequest",
                { title: "Migrate to p5 2.3", body: "Renamed call", branch: "driftlock/p5-2.3" },
                "c3",
            ),
        ];

        const result = await runMigrationAgent({
            root,
            packet,
            prMode: "draft",
            client: fakeClient(),
        });

        expect(result.outcome).toBe("draft_pr");
        expect(result.filesChanged).toEqual(["src/client.ts"]);
    });

    test("a passing verification does not survive a later edit", async () => {
        const init = Bun.spawn(["git", "init"], { cwd: root, stdout: "pipe" });
        await init.exited;
        const add = Bun.spawn(["git", "add", "-A"], { cwd: root, stdout: "pipe" });
        await add.exited;

        apiCalls = [
            toolCall("runCommand", { command: "npm run build" }, "c1"),
            toolCall(
                "editFile",
                {
                    path: "src/client.ts",
                    patch: [
                        "--- a/src/client.ts",
                        "+++ b/src/client.ts",
                        "@@ -1 +1 @@",
                        "-createCanvas(1);",
                        "+createSurface(1);",
                    ].join("\n"),
                },
                "c2",
            ),
            toolCall(
                "createPullRequest",
                { title: "Migrate to p5 2.3", body: "Renamed call", branch: "driftlock/p5-2.3" },
                "c3",
            ),
        ];

        const result = await runMigrationAgent({ root, packet, client: fakeClient() });

        // The build passed before the edit, but the edit wiped that result,
        // so the PR gate refuses until verification runs again.
        const pr = result.state.transcript.find(
            (entry) => entry.role === "tool" && entry.toolCallId === "c3",
        );
        expect(pr?.content).toContain("no passing verification command");
        expect(result.state.pullRequest).toBeUndefined();
    });

    test("sends assistant tool-call messages with string content, never null", async () => {
        const sent: Record<string, unknown>[][] = [];
        let index = 0;
        apiCalls = [
            toolCall("inspectRepo", {}, "c1"),
            toolCall("searchCode", { query: "createCanvas" }, "c2"),
            finalText("done"),
        ];

        const client = {
            chat: {
                completions: {
                    create: async (body: Record<string, unknown>) => {
                        sent.push(body.messages as Record<string, unknown>[]);
                        const next = apiCalls[Math.min(index, apiCalls.length - 1)];
                        index += 1;
                        return next as never;
                    },
                },
            },
        } as unknown as Parameters<typeof runMigrationAgent>[0]["client"];

        await runMigrationAgent({ root, packet, client });

        expect(sent.length).toBe(3);
        for (const messages of sent) {
            for (const message of messages) {
                expect(
                    message.content,
                    `role=${message.role} must carry a string content`,
                ).toBeTypeOf("string");
            }
        }
        const assistantWithToolCall = sent[1].find(
            (m) => m.role === "assistant" && Array.isArray(m.tool_calls),
        );
        expect(assistantWithToolCall).toBeDefined();
        expect(assistantWithToolCall?.content).toBe("");
    });

    test("answers every tool call in a parallel batch", async () => {
        const sent: Record<string, unknown>[][] = [];
        let index = 0;
        apiCalls = [
            {
                choices: [
                    {
                        message: {
                            content: null,
                            tool_calls: [
                                { id: "b1", function: { name: "inspectRepo", arguments: "{}" } },
                                {
                                    id: "b2",
                                    function: {
                                        name: "searchCode",
                                        arguments: JSON.stringify({ query: "createCanvas" }),
                                    },
                                },
                            ],
                        },
                    },
                ],
            },
            finalText("done"),
        ];

        const client = {
            chat: {
                completions: {
                    create: async (body: Record<string, unknown>) => {
                        sent.push(body.messages as Record<string, unknown>[]);
                        const next = apiCalls[Math.min(index, apiCalls.length - 1)];
                        index += 1;
                        return next as never;
                    },
                },
            },
        } as unknown as Parameters<typeof runMigrationAgent>[0]["client"];

        const result = await runMigrationAgent({ root, packet, client });

        const asked = result.state.transcript.flatMap((e) => e.toolCalls ?? []);
        const answered = result.state.transcript.filter((e) => e.role === "tool");
        expect(asked.map((c) => c.id).sort()).toEqual(["b1", "b2"]);
        expect(answered.map((e) => e.toolCallId).sort()).toEqual(["b1", "b2"]);

        const toolMessages = sent[1].filter((m) => m.role === "tool");
        expect(toolMessages).toHaveLength(2);
        for (const message of toolMessages) {
            expect(message.tool_call_id).toBeTypeOf("string");
            expect(message.content).toBeTypeOf("string");
        }
    });

    test("returns no_action when the model never touches a file", async () => {
        apiCalls = [
            toolCall("inspectRepo", {}, "c1"),
            finalText("Nothing in this repo uses the renamed API."),
        ];

        const result = await runMigrationAgent({ root, packet, client: fakeClient() });
        expect(result.outcome).toBe("no_action");
        expect(result.filesChanged).toEqual([]);
    });

    test("returns review_pr when a file changed but validation failed", async () => {
        const init = Bun.spawn(["git", "init"], { cwd: root, stdout: "pipe" });
        await init.exited;
        const add = Bun.spawn(["git", "add", "-A"], { cwd: root, stdout: "pipe" });
        await add.exited;

        apiCalls = [
            toolCall(
                "editFile",
                {
                    path: "src/client.ts",
                    patch: [
                        "--- a/src/client.ts",
                        "+++ b/src/client.ts",
                        "@@ -1 +1 @@",
                        "-createCanvas(1);",
                        "+createSurface(1);",
                    ].join("\n"),
                },
                "c1",
            ),
            toolCall("runCommand", { command: "npm run typecheck" }, "c2"),
        ];
        await writeFile(
            join(root, "package.json"),
            JSON.stringify({
                name: "fixture",
                scripts: { typecheck: "node -e \"process.exit(1)\"" },
            }),
        );

        const result = await runMigrationAgent({ root, packet, client: fakeClient() });
        expect(result.outcome).toBe("review_pr");
        expect(result.state.lastTestResult?.passed).toBe(false);
    });

    test("stops at the iteration ceiling and asks for review", async () => {
        const init = Bun.spawn(["git", "init"], { cwd: root, stdout: "pipe" });
        await init.exited;
        const add = Bun.spawn(["git", "add", "-A"], { cwd: root, stdout: "pipe" });
        await add.exited;

        apiCalls = [
            toolCall(
                "editFile",
                {
                    path: "src/client.ts",
                    patch: [
                        "--- a/src/client.ts",
                        "+++ b/src/client.ts",
                        "@@ -1 +1 @@",
                        "-createCanvas(1);",
                        "+createSurface(1);",
                    ].join("\n"),
                },
                "c1",
            ),
        ];

        const result = await runMigrationAgent({ root, packet, client: fakeClient() });
        expect(result.state.iteration).toBe(15);
        expect(result.outcome).toBe("review_pr");
    });

    test("refuses to edit a protected path", async () => {
        await writeFile(join(root, ".env"), "SECRET=1\n");
        apiCalls = [toolCall("editFile", { path: ".env", patch: "x" }, "c1"), finalText("stopped")];

        const result = await runMigrationAgent({ root, packet, client: fakeClient() });
        expect(result.filesChanged).toEqual([]);
        const toolEntry = result.state.transcript.find(
            (entry) => entry.role === "tool" && entry.toolCallId === "c1",
        );
        expect(toolEntry?.content).toContain("FAILED");
    });

    test("ignores tool calls it does not recognise", async () => {
        apiCalls = [
            toolCall("deleteRepository", { path: "/" }, "c1"),
            finalText("I cannot do that."),
        ];

        const result = await runMigrationAgent({ root, packet, client: fakeClient() });
        expect(result.outcome).toBe("no_action");
        expect(result.state.transcript.some((entry) => entry.role === "tool")).toBe(false);
    });

    test("answers every tool call in a parallel batch before stopping", async () => {
        const init = Bun.spawn(["git", "init"], { cwd: root, stdout: "pipe" });
        await init.exited;
        const add = Bun.spawn(["git", "add", "-A"], { cwd: root, stdout: "pipe" });
        await add.exited;

        let turn = 0;
        const client = {
            chat: {
                completions: {
                    create: async () => {
                        turn += 1;
                        if (turn === 1) {
                            return {
                                choices: [
                                    {
                                        message: {
                                            content: null,
                                            tool_calls: [
                                                {
                                                    id: "pr",
                                                    function: {
                                                        name: "createPullRequest",
                                                        arguments: JSON.stringify({
                                                            title: "t",
                                                            body: "b",
                                                            branch: "br",
                                                        }),
                                                    },
                                                },
                                                {
                                                    id: "read",
                                                    function: {
                                                        name: "readFile",
                                                        arguments: JSON.stringify({
                                                            path: "src/client.ts",
                                                        }),
                                                    },
                                                },
                                            ],
                                        },
                                    },
                                ],
                            };
                        }
                        return finalText("stopping after the refused PR");
                    },
                },
            },
        } as unknown as Parameters<typeof runMigrationAgent>[0]["client"];

        const result = await runMigrationAgent({ root, packet, client });

        const requested = result.state.transcript
            .filter((entry) => entry.role === "assistant" && entry.toolCalls)
            .flatMap((entry) => entry.toolCalls ?? [])
            .map((call) => call.id);
        const answered = result.state.transcript
            .filter((entry) => entry.role === "tool")
            .map((entry) => entry.toolCallId);

        for (const id of requested) {
            expect(answered).toContain(id);
        }
        // The batch's createPullRequest is refused (bad branch, no passing
        // verification), and only a successful PR ends the loop, so the model
        // gets a second turn instead of stopping after the first.
        expect(result.state.iteration).toBe(2);
    });

    test("sends the system prompt and the ChangePacket to the model", async () => {
        let seen: unknown;
        apiCalls = [finalText("No changes needed.")];

        const client = {
            chat: {
                completions: {
                    create: async (params: unknown) => {
                        seen = params;
                        return finalText("No changes needed.");
                    },
                },
            },
        } as unknown as Parameters<typeof runMigrationAgent>[0]["client"];

        await runMigrationAgent({ root, packet, client });

        const params = seen as {
            messages: Array<{ role: string; content?: string }>;
            tools: Array<{ function: { name: string } }>;
        };
        expect(params.messages[0].role).toBe("system");
        expect(params.messages[0].content).toContain("DriftLock");
        expect(params.messages[1].content).toContain("createCanvas renamed to createSurface");
        expect(params.tools.map((tool) => tool.function.name)).toContain("readFile");
    });
});
