import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    copyWorkspace,
    createSandboxCommandRunner,
    DEFAULT_SANDBOX_IMAGE,
    runMigrationAgent,
    type ChangePacket,
    type SandboxCommandRunnerOptions,
} from "@driftlock/agent";
import type { SandboxConfig, SandboxResult } from "@driftlock/sandbox";

let root: string;

const packet: ChangePacket = {
    provider: "p5",
    fromVersion: "1.11",
    toVersion: "2.3",
    summary: "createCanvas renamed to createSurface",
    migrationDocs: [],
};

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "driftlock-cmd-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
        join(root, "package.json"),
        JSON.stringify({ name: "f", scripts: { build: "true" } }),
    );
    await writeFile(join(root, "src/client.ts"), "createCanvas(1);\n");
    const init = Bun.spawn(["git", "init"], { cwd: root, stdout: "pipe" });
    await init.exited;
    await Bun.$`touch ${join(root, ".git-marker")}`.quiet();
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

type Recorded = { repo: string; config: SandboxConfig };

function fakeRunner(
    result?: Partial<SandboxResult>,
): { runner: NonNullable<SandboxCommandRunnerOptions["runner"]>; calls: Recorded[] } {
    const calls: Recorded[] = [];
    return {
        calls,
        runner: {
            runTestSuite: async (repo: string, config: SandboxConfig) => {
                calls.push({ repo, config });
                return {
                    exitCode: 0,
                    stdout: "ok",
                    stderr: "",
                    duration: 1,
                    trafficCaptured: [],
                    ...result,
                };
            },
        },
    };
}

describe("copyWorkspace", () => {
    test("copies the source tree", async () => {
        const workspace = await copyWorkspace(root);
        try {
            expect(existsSync(join(workspace, "package.json"))).toBe(true);
            expect(existsSync(join(workspace, "src/client.ts"))).toBe(true);
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("skips .git so history is not copied", async () => {
        const workspace = await copyWorkspace(root);
        try {
            expect(existsSync(join(workspace, ".git"))).toBe(false);
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("leaves the original untouched", async () => {
        const workspace = await copyWorkspace(root);
        await rm(workspace, { recursive: true, force: true });
        expect(existsSync(join(root, "src/client.ts"))).toBe(true);
        expect(existsSync(join(root, ".git"))).toBe(true);
    });
});

describe("createSandboxCommandRunner", () => {
    test("refuses a command outside the whitelist before touching Docker", async () => {
        const { runner, calls } = fakeRunner();
        const commandRunner = createSandboxCommandRunner({ runner });
        const result = await commandRunner.run(root, "rm -rf /");
        expect(result.ok).toBe(false);
        expect(calls).toHaveLength(0);
    });

    test("disables the network and mounts the copy writable", async () => {
        const { runner, calls } = fakeRunner();
        const commandRunner = createSandboxCommandRunner({ runner });
        const result = await commandRunner.run(root, "npm run build");

        expect(result.ok).toBe(true);
        expect(calls).toHaveLength(1);
        const { config, repo } = calls[0];
        expect(config.networkEnabled).toBe(false);
        expect(config.allowedEndpoints).toEqual([]);
        expect(config.readOnly).toBe(false);
        expect(config.image).toBe(DEFAULT_SANDBOX_IMAGE);
        expect(repo).not.toBe(root);
        expect(config.env).toEqual({ CI: "1" });
    });

    test("splits the whitelisted command into argv, not a shell string", async () => {
        const { runner, calls } = fakeRunner();
        const commandRunner = createSandboxCommandRunner({ runner });
        await commandRunner.run(root, "npm run typecheck");
        expect(calls[0].config.command).toEqual(["npm", "run", "typecheck"]);
    });

    test("reports a non-zero exit code as failure", async () => {
        const { runner } = fakeRunner({ exitCode: 1, stdout: "3 errors" });
        const commandRunner = createSandboxCommandRunner({ runner });
        const result = await commandRunner.run(root, "npm test");
        expect(result.ok).toBe(false);
        expect(result.output).toContain("exit code: 1");
        expect(result.output).toContain("3 errors");
    });

    test("states that the network is disabled so the model can see it", async () => {
        const { runner } = fakeRunner();
        const commandRunner = createSandboxCommandRunner({ runner });
        const result = await commandRunner.run(root, "npm run build");
        expect(result.output).toContain("network disabled");
    });

    test("does not share node_modules when the repo has none", async () => {
        const { runner, calls } = fakeRunner();
        const commandRunner = createSandboxCommandRunner({ runner });
        await commandRunner.run(root, "npm run build");
        expect(calls[0].config.extraBinds ?? []).toEqual([]);
    });

    test("shares node_modules read-only when present", async () => {
        await mkdir(join(root, "node_modules/left-pad"), { recursive: true });
        const { runner, calls } = fakeRunner();
        const commandRunner = createSandboxCommandRunner({ runner });
        await commandRunner.run(root, "npm run build");
        expect(calls[0].config.extraBinds).toEqual([
            `${join(root, "node_modules")}:/workspace/node_modules:ro`,
        ]);
    });

    test("removes the workspace copy afterwards", async () => {
        const seen: string[] = [];
        const runner = {
            runTestSuite: async (repo: string, _config: SandboxConfig) => {
                seen.push(repo);
                expect(readdirSync(repo).length).toBeGreaterThan(0);
                return {
                    exitCode: 0,
                    stdout: "",
                    stderr: "",
                    duration: 1,
                    trafficCaptured: [],
                };
            },
        };
        const commandRunner = createSandboxCommandRunner({ runner });
        await commandRunner.run(root, "npm run build");
        expect(existsSync(seen[0])).toBe(false);
    });

    test("surfaces a Docker failure instead of throwing", async () => {
        const runner = {
            runTestSuite: async () => {
                throw new Error("docker daemon not reachable");
            },
        };
        const commandRunner = createSandboxCommandRunner({ runner });
        const result = await commandRunner.run(root, "npm run build");
        expect(result.ok).toBe(false);
        expect(result.output).toContain("docker daemon not reachable");
    });
});

describe("agent with a sandboxed command runner", () => {
    test("routes runCommand through the injected runner", async () => {
        const { runner, calls } = fakeRunner();
        const commandRunner = createSandboxCommandRunner({ runner });

        let turn = 0;
        const script = [
            {
                choices: [
                    {
                        message: {
                            content: null,
                            tool_calls: [
                                {
                                    id: "v1",
                                    function: {
                                        name: "runCommand",
                                        arguments: JSON.stringify({
                                            command: "npm run build",
                                        }),
                                    },
                                },
                            ],
                        },
                    },
                ],
            },
            { choices: [{ message: { content: "done" } }] },
        ];
        const client = {
            chat: {
                completions: {
                    create: async () => {
                        const next = script[Math.min(turn, script.length - 1)];
                        turn += 1;
                        return next as never;
                    },
                },
            },
        } as unknown as Parameters<typeof runMigrationAgent>[0]["client"];

        const result = await runMigrationAgent({
            root,
            packet,
            commandRunner,
            client,
        });

        expect(calls).toHaveLength(1);
        expect(result.state.commandsRun).toBe(1);
        expect(result.state.lastTestResult?.passed).toBe(true);
        const entry = result.state.transcript.find(
            (item) => item.role === "tool" && item.toolCallId === "v1",
        );
        expect(entry?.content).toContain("network disabled");
    });

    test("a failing sandbox run blocks the pull request", async () => {
        const { runner, calls } = fakeRunner({ exitCode: 1 });
        const commandRunner = createSandboxCommandRunner({ runner });

        let turn = 0;
        const script = [
            {
                choices: [
                    {
                        message: {
                            content: null,
                            tool_calls: [
                                {
                                    id: "v1",
                                    function: {
                                        name: "runCommand",
                                        arguments: JSON.stringify({ command: "npm test" }),
                                    },
                                },
                                {
                                    id: "p1",
                                    function: {
                                        name: "createPullRequest",
                                        arguments: JSON.stringify({
                                            title: "t",
                                            body: "b",
                                            branch: "driftlock/x",
                                        }),
                                    },
                                },
                            ],
                        },
                    },
                ],
            },
            { choices: [{ message: { content: "done" } }] },
        ];
        const client = {
            chat: {
                completions: {
                    create: async () => {
                        const next = script[Math.min(turn, script.length - 1)];
                        turn += 1;
                        return next as never;
                    },
                },
            },
        } as unknown as Parameters<typeof runMigrationAgent>[0]["client"];

        const result = await runMigrationAgent({
            root,
            packet,
            commandRunner,
            target: { owner: "a", repo: "b", base: "main" },
            client,
        });

        expect(calls).toHaveLength(1);
        expect(result.state.lastTestResult?.passed).toBe(false);
        const pr = result.state.transcript.find(
            (item) => item.role === "tool" && item.toolCallId === "p1",
        );
        expect(pr?.content).toContain("Refusing to open a PR");
    });
});
