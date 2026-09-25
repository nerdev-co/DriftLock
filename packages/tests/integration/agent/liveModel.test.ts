import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrationAgent, type ChangePacket } from "@driftlock/agent";
import type { PublishInput, PullRequestInfo } from "@driftlock/agent";

setDefaultTimeout(600_000);

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const model = process.env.CLOUDFLARE_AI_MODEL;

const configured = Boolean(accountId && apiToken);
const baseURL = configured
    ? `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId!)}/ai/v1`
    : undefined;

const packet: ChangePacket = {
    provider: "acme-draw",
    fromVersion: "1.0",
    toVersion: "2.0",
    summary: "createCanvas was renamed to createSurface",
    migrationDocs: [],
};

let root: string;

beforeAll(async () => {
    if (!configured) return;
    root = await mkdtemp(join(tmpdir(), "driftlock-live-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
        join(root, "package.json"),
        JSON.stringify({
            name: "fixture",
            private: true,
            type: "module",
            scripts: {
                test: "node test.mjs",
                build: "node -e \"console.log('build ok')\"",
                typecheck: "node -e \"console.log('typecheck ok')\"",
            },
        }),
    );
    await writeFile(
        join(root, "src/client.ts"),
        [
            "export function draw() {",
            "    return createCanvas(1);",
            "}",
            "",
        ].join("\n"),
    );
    await writeFile(
        join(root, "test.mjs"),
        [
            "import { readFileSync } from 'node:fs';",
            "const src = readFileSync('src/client.ts', 'utf8');",
            "if (src.includes('createCanvas')) {",
            "    console.error('FAIL: createCanvas is still present');",
            "    process.exit(1);",
            "}",
            "if (!src.includes('createSurface')) {",
            "    console.error('FAIL: createSurface was never used');",
            "    process.exit(1);",
            "}",
            "console.log('PASS: migration verified');",
            "",
        ].join("\n"),
    );

    const git = async (...args: string[]) => {
        const proc = Bun.spawn(["git", ...args], {
            cwd: root,
            stdout: "pipe",
            stderr: "pipe",
        });
        await proc.exited;
    };
    await git("init");
    await git("add", "-A");
    await git("-c", "user.email=agent@test.invalid", "-c", "user.name=Agent", "commit", "-m", "initial");
});

afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
});

describe.skipIf(!configured)("live model loop", () => {
    test("Cloudflare credentials are present", () => {
        expect(configured).toBe(true);
        expect(model).toBeTruthy();
    });

    test("completes a real migration against a live OpenAI-compatible model", async () => {
        const published: PublishInput[] = [];
        const publisher = {
            publish: async (input: PublishInput): Promise<PullRequestInfo> => {
                published.push(input);
                return {
                    status: "opened",
                    url: "https://github.test/acme/widgets/pull/1",
                    number: 1,
                    branch: input.branch,
                };
            },
        };

        const result = await runMigrationAgent({
            root,
            packet,
            apiKey: apiToken,
            baseURL,
            model,
            publisher,
            target: { owner: "acme", repo: "widgets", base: "main" },
        });

        const { state } = result;
        const answers = state.transcript.filter((entry) => entry.role === "tool");
        const asked = state.transcript.flatMap((entry) => entry.toolCalls ?? []);

        for (const call of asked) {
            const answer = answers.find((a) => a.toolCallId === call.id);
            expect(answer, `tool call ${call.name} (${call.id}) went unanswered`).toBeDefined();
        }

        expect(["auto_pr", "review_pr", "draft_pr", "no_action"]).toContain(result.outcome);
        expect(state.iteration).toBeLessThanOrEqual(state.maxIterations);
        expect(asked.length).toBeGreaterThan(0);

        console.log("model:", model);
        console.log("outcome:", result.outcome);
        console.log("iterations:", state.iteration, "/", state.maxIterations);
        console.log("tool calls:", asked.map((c) => c.name).join(" -> "));
        console.log("files changed:", result.filesChanged.join(", ") || "(none)");
        console.log("commands run:", state.commandsRun);
        console.log("verification passed:", state.lastTestResult?.passed);
        console.log("publisher calls:", published.length);
        for (const entry of state.transcript) {
            if (entry.role === "assistant" && entry.content) {
                console.log(`assistant: ${entry.content.slice(0, 400)}`);
            }
            if (entry.role === "tool") {
                console.log(`tool ${entry.toolName}: ${entry.content.slice(0, 300)}`);
            }
        }

        const source = result.filesChanged.includes("src/client.ts")
            ? await Bun.file(join(root, "src/client.ts")).text()
            : "";
        console.log("final src/client.ts:", JSON.stringify(source));
    });
});
