import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { P5_VENDOR, STRIPE_VENDOR } from "@driftlock/core";
import {
    changePacketFromDrift,
    runMigrationAgent,
    type ChangePacket,
    type VendorContract,
} from "@driftlock/agent";

type FakeCall = {
    choices: Array<{
        message: {
            content?: string | null;
            tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
        };
    }>;
};

let root: string;
let apiCalls: FakeCall[];

function toolCall(name: string, args: Record<string, unknown>, id: string): FakeCall {
    return {
        choices: [
            {
                message: {
                    content: null,
                    tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }],
                },
            },
        ],
    };
}

function fakeClient() {
    let index = 0;
    return {
        chat: {
            completions: {
                create: async () => {
                    const next = apiCalls[Math.min(index, apiCalls.length - 1)];
                    index += 1;
                    if (!next) throw new Error("fakeClient exhausted");
                    return next;
                },
            },
        },
    } as unknown as Parameters<typeof runMigrationAgent>[0]["client"];
}

function contract(overrides: Partial<VendorContract>): VendorContract {
    return {
        provider: "p5",
        version: "2.3.0",
        source: "spec",
        authority: "authoritative",
        origin: "https://p5js.org/reference/data.json",
        capturedAt: "2026-01-01T00:00:00.000Z",
        members: [],
        removed: [],
        ...overrides,
    };
}

const p5Contract = contract({
    // A subset of what p5's real reference dump yields, which has 866 classitems
    // and 243 constants. Every member this fixture's sketch touches is present,
    // so a finding here means the gate is right rather than the contract thin.
    members: [
        "setup",
        "draw",
        "createCanvas",
        "keyIsDown",
        "keyIsPressed",
        "keyCode",
        "key",
        "constrain",
        "height",
        "width",
        "UP_ARROW",
        "CENTER",
    ],
});

const p5Packet: ChangePacket = {
    provider: "p5",
    fromVersion: "1.11.13",
    toVersion: "2.3.0",
    summary: "keyCode comparisons no longer work; use keyIsDown",
    migrationDocs: ["https://p5js.org/tutorials/v2_transition/"],
};

const ORIGINAL_SKETCH = `const sketch = (p) => {
  p.setup = () => {
    p.createCanvas(400, 400);
  };
  p.draw = () => {
    if (p.keyIsPressed && p.keyCode === 38) {
      y = p.constrain(y - 2, 12, p.height - 12);
    }
  };
};
`;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "driftlock-gate-"));
    apiCalls = [];
    await writeFile(
        join(root, "package.json"),
        JSON.stringify({
            name: "fixture",
            scripts: { build: "node -e \"process.exit(0)\"" },
        }),
    );
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src/sketch.js"), ORIGINAL_SKETCH);
    const init = Bun.spawn(["git", "init"], { cwd: root, stdout: "pipe" });
    await init.exited;
    const add = Bun.spawn(["git", "add", "-A"], { cwd: root, stdout: "pipe" });
    await add.exited;
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

const prArgs = {
    title: "Migrate to p5 2.3",
    body: "keyboard input",
    branch: "driftlock/p5-2-3",
};

describe("the contract gate blocks a bad migration that every other check passed", () => {
    test("refuses the PR when the model used a vendor constant as a free identifier", async () => {
        apiCalls = [
            toolCall(
                "replaceInFile",
                {
                    path: "src/sketch.js",
                    oldText: "p.keyIsPressed && p.keyCode === 38",
                    newText: "p.keyIsDown(UP_ARROW)",
                },
                "c1",
            ),
            toolCall("runCommand", { command: "npm run build" }, "c2"),
            toolCall("createPullRequest", prArgs, "c3"),
        ];

        const result = await runMigrationAgent({
            root,
            packet: p5Packet,
            contract: p5Contract,
            vendor: P5_VENDOR,
            client: fakeClient(),
        });

        expect(result.state.lastTestResult?.passed).toBe(true);
        expect(result.state.contractChecked).toBe(true);
        expect(result.state.symbolFindings).toHaveLength(1);
        expect(result.state.symbolFindings?.[0].kind).toBe("unbound-constant");
        expect(result.state.pullRequest).toBeUndefined();
        expect(result.outcome).toBe("review_pr");

        const refusal = result.state.transcript.find(
            (entry) => entry.toolName === "createPullRequest",
        );
        expect(refusal?.content).toContain("Refusing to open a PR");
        expect(refusal?.content).toContain("p.UP_ARROW");
    });

    test("allows the PR once the constant is reached through the instance", async () => {
        apiCalls = [
            toolCall(
                "replaceInFile",
                {
                    path: "src/sketch.js",
                    oldText: "p.keyIsPressed && p.keyCode === 38",
                    newText: "p.keyIsDown(p.UP_ARROW)",
                },
                "c1",
            ),
            toolCall("runCommand", { command: "npm run build" }, "c2"),
            toolCall("createPullRequest", prArgs, "c3"),
        ];

        const result = await runMigrationAgent({
            root,
            packet: p5Packet,
            contract: p5Contract,
            vendor: P5_VENDOR,
            client: fakeClient(),
        });

        expect(result.state.symbolFindings).toEqual([]);
        expect(result.outcome).toBe("auto_pr");
    });
});

describe("the contract gate catches a migration that was left half finished", () => {
    test("refuses when one of two removed-field call sites is still there", async () => {
        await writeFile(
            join(root, "webhook.js"),
            `function handle(event) {
  const paymentIntent = event.data.object;
  return { source: paymentIntent.source };
}
`,
        );
        const add = Bun.spawn(["git", "add", "-A"], { cwd: root, stdout: "pipe" });
        await add.exited;

        const stripeContract = contract({
            provider: "stripe",
            source: "live",
            origin: "https://api.stripe.com/v1/payment_intents/pi_1",
            members: ["id", "payment_method", "status"],
            removed: ["source"],
        });

        apiCalls = [
            toolCall(
                "replaceInFile",
                {
                    path: "webhook.js",
                    oldText: "return { source: paymentIntent.source };",
                    newText: "return { payment_method: paymentIntent.payment_method };",
                },
                "c1",
            ),
            toolCall("runCommand", { command: "npm run build" }, "c2"),
            toolCall("createPullRequest", prArgs, "c3"),
        ];

        // A second file the model never touched, still reading the removed field.
        await writeFile(
            join(root, "src/legacy.js"),
            `function read(event) {
  const pi = event.data.object;
  return pi.source;
}
`,
        );

        const result = await runMigrationAgent({
            root,
            packet: {
                provider: "stripe",
                fromVersion: "2022-08-01",
                toVersion: "2022-11-15",
                summary: "source removed",
                migrationDocs: [],
            },
            contract: stripeContract,
            vendor: STRIPE_VENDOR,
            client: fakeClient(),
        });

        expect(result.filesChanged).toEqual(["webhook.js"]);
        expect(result.state.symbolFindings?.map((finding) => finding.file)).toEqual([
            "src/legacy.js",
        ]);
        expect(result.state.pullRequest).toBeUndefined();
    });
});

describe("the contract is shown to the model before it edits", () => {
    test("the opening message carries the real member list", async () => {
        const sent: Record<string, unknown>[][] = [];
        let index = 0;
        apiCalls = [toolCall("inspectRepo", {}, "c1")];
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

        await runMigrationAgent({
            root,
            packet: p5Packet,
            contract: p5Contract,
            vendor: P5_VENDOR,
            client,
        });

        const opening = String(sent[0][1].content);
        expect(opening).toContain("p5js.org/reference/data.json");
        expect(opening).toContain("UP_ARROW");
        expect(opening).toContain("Do not reference a member that is not in this list");
    });
});

describe("the repository is fingerprinted before the model is asked to change it", () => {
    test("the opening message names the real scripts and installed version", async () => {
        // A byte-for-byte copy of the manifest in
        // /Users/nalindalal/driftlock-p5.js-test, the repository that produced
        // three commands exiting 127 before the fingerprint existed. Note there
        // is no lockfile, so the version comes from the exact pin, and `dev` is
        // present but is a server rather than verification.
        const real = await mkdtemp(join(tmpdir(), "driftlock-p5real-"));
        await writeFile(
            join(real, "package.json"),
            JSON.stringify(
                {
                    name: "driftlock-p5.js-test",
                    private: true,
                    version: "1.0.0",
                    type: "module",
                    scripts: { dev: "vite", build: "vite build" },
                    dependencies: { p5: "1.11.13" },
                    devDependencies: { vite: "^6.0.0" },
                },
                null,
                2,
            ),
        );
        await mkdir(join(real, "src"), { recursive: true });
        await writeFile(join(real, "src/sketch.js"), "export const x = 1;\n");

        const sent: Record<string, unknown>[][] = [];
        let index = 0;
        apiCalls = [toolCall("inspectRepo", {}, "c1")];
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

        await runMigrationAgent({
            root: real,
            packet: p5Packet,
            contract: p5Contract,
            vendor: P5_VENDOR,
            client,
        });
        await rm(real, { recursive: true, force: true });

        const opening = String(sent[0][1].content);
        expect(opening).toContain("Scripts that exist: dev, build");
        expect(opening).toContain("npm run build");
        expect(opening).toContain("p5@1.11.13");
        expect(opening).toContain("Step 1: find every call site");

        // The commands that do not exist must not be offered as if they did.
        expect(opening).not.toContain("npm test");
        expect(opening).not.toContain("npm run typecheck");
    });

    test("hands over one step at a time instead of the whole plan", async () => {
        const sent: Record<string, unknown>[][] = [];
        let index = 0;
        apiCalls = [
            toolCall("searchCode", { query: "keyCode" }, "c1"),
            toolCall("readFile", { path: "src/sketch.js" }, "c2"),
            toolCall(
                "replaceInFile",
                {
                    path: "src/sketch.js",
                    oldText: "p.keyCode === 38",
                    newText: "p.keyIsDown(p.UP_ARROW)",
                },
                "c3",
            ),
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

        const result = await runMigrationAgent({
            root,
            packet: p5Packet,
            contract: p5Contract,
            vendor: P5_VENDOR,
            client,
        });

        expect(result.filesChanged).toEqual(["src/sketch.js"]);

        const opening = String(sent[0][1].content);
        const last = sent[sent.length - 1].map((entry) => String(entry.content));

        // The opening message states step 1 and withholds the rest, so the model
        // is never asked to hold the edit rules and the gate rules before it has
        // reached the point where they apply.
        expect(opening).toContain("Step 1");
        expect(opening).not.toContain("Step 2");
        expect(opening).not.toContain("Step 3");
        expect(opening).not.toContain("Step 4");

        // By the time it is editing, step 3 has arrived.
        expect(last.join("\n")).toContain("Step 3: make the change");
        expect(last.join("\n")).toContain("Prefer replaceInFile");
    });

    test("says so plainly when the repository has no verification command", async () => {
        const empty = await mkdtemp(join(tmpdir(), "driftlock-noverify-"));
        await writeFile(
            join(empty, "package.json"),
            JSON.stringify({ scripts: { dev: "vite" } }),
        );

        const sent: Record<string, unknown>[][] = [];
        let index = 0;
        apiCalls = [toolCall("inspectRepo", {}, "c1")];
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

        await runMigrationAgent({ root: empty, packet: p5Packet, client });
        await rm(empty, { recursive: true, force: true });

        const opening = String(sent[0][1].content);
        expect(opening).toContain("no verification command");
        expect(opening).toContain("rather than inventing one");
    });

    test("never guesses a command when the manifest is missing entirely", async () => {
        const bare = await mkdtemp(join(tmpdir(), "driftlock-bare-"));

        const sent: Record<string, unknown>[][] = [];
        let index = 0;
        apiCalls = [toolCall("inspectRepo", {}, "c1")];
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

        await runMigrationAgent({ root: bare, packet: p5Packet, client });
        await rm(bare, { recursive: true, force: true });

        const opening = String(sent[0][1].content);
        expect(opening).toContain("unknown project");
        expect(opening).not.toContain("npm test");
    });
});

describe("changePacketFromDrift", () => {
    test("writes the summary from observed fields rather than prose", () => {
        const packet = changePacketFromDrift({
            provider: "stripe",
            fromVersion: "2022-08-01",
            toVersion: "2022-11-15",
            removed: ["source"],
            added: ["payment_method"],
            typeChanged: [{ field: "charges", from: "object", to: "null" }],
        });

        expect(packet.summary).toContain("stopped sending these fields: source");
        expect(packet.summary).toContain("started sending these fields: payment_method");
        expect(packet.summary).toContain("charges changed type from object to null");
        expect(packet.removed).toEqual(["source"]);
    });

    test("says so plainly when nothing was observed", () => {
        const packet = changePacketFromDrift({
            provider: "acme",
            fromVersion: "1",
            toVersion: "2",
            removed: [],
            added: [],
            typeChanged: [],
        });
        expect(packet.summary).toContain("No field level change was observed");
    });
});
