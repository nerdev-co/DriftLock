import { describe, expect, test } from "bun:test";
import {
    canChangeMoreFiles,
    canRunMoreCommands,
    createInitialState,
    decideOutcome,
    isToolName,
    limits,
    recordFileChanged,
    tools,
    toOpenAITools,
    type ChangePacket,
    type AgentState,
} from "@driftlock/agent";

function packet(overrides: Partial<ChangePacket> = {}): ChangePacket {
    return {
        provider: "p5",
        fromVersion: "1.11",
        toVersion: "2.3",
        summary: "breaking rename of createCanvas to createSurface",
        migrationDocs: ["https://example.test/p5-2.3"],
        ...overrides,
    };
}

function state(overrides: Partial<AgentState> = {}): AgentState {
    return { ...createInitialState(packet()), ...overrides };
}

describe("tools", () => {
    test("exposes exactly the seven migration tools", () => {
        expect(tools.map((tool) => tool.name)).toEqual([
            "inspectRepo",
            "searchCode",
            "readFile",
            "editFile",
            "replaceInFile",
            "runCommand",
            "createPullRequest",
        ]);
    });

    test("every tool has a description and an object schema", () => {
        for (const tool of tools) {
            expect(tool.description.length).toBeGreaterThan(10);
            expect(tool.inputSchema.type).toBe("object");
            expect(Array.isArray(tool.inputSchema.required)).toBe(true);
        }
    });

    test("required properties are declared in properties", () => {
        for (const tool of tools) {
            for (const key of tool.inputSchema.required) {
                expect(tool.inputSchema.properties[key]).toBeDefined();
            }
        }
    });

    test("isToolName narrows known tools only", () => {
        expect(isToolName("readFile")).toBe(true);
        expect(isToolName("deleteEverything")).toBe(false);
    });

    test("toOpenAITools maps to the function tool shape", () => {
        const mapped = toOpenAITools();
        expect(mapped).toHaveLength(tools.length);
        expect(mapped[0].type).toBe("function");
        expect(mapped[0].function.name).toBe("inspectRepo");
        expect(mapped[0].function.parameters.type).toBe("object");
    });
});

describe("createInitialState", () => {
    test("seeds limits from the shared budget", () => {
        const initial = createInitialState(packet());
        expect(initial.maxIterations).toBe(limits.MAX_ITERATIONS);
        expect(initial.maxCommands).toBe(limits.MAX_COMMANDS);
        expect(initial.maxFilesChanged).toBe(limits.MAX_FILES_CHANGED);
        expect(initial.iteration).toBe(0);
        expect(initial.commandsRun).toBe(0);
    });

    test("starts not done with no outcome", () => {
        const initial = createInitialState(packet());
        expect(initial.done).toBe(false);
        expect(initial.outcome).toBeNull();
        expect(initial.filesChanged).toEqual([]);
    });

    test("embeds the ChangePacket in the first user message", () => {
        const initial = createInitialState(packet());
        const first = initial.transcript[0];
        expect(first.role).toBe("user");
        expect(first.content).toContain('"provider": "p5"');
        expect(first.content).toContain("1.11");
        expect(first.content).toContain("2.3");
    });
});

describe("recordFileChanged", () => {
    test("tracks a path once", () => {
        const current = state();
        recordFileChanged(current, "src/client.ts");
        recordFileChanged(current, "src/client.ts");
        expect(current.filesChanged).toEqual(["src/client.ts"]);
    });

    test("refuses edits past MAX_FILES_CHANGED", () => {
        const current = state();
        for (let i = 0; i < limits.MAX_FILES_CHANGED; i++) {
            recordFileChanged(current, `file-${i}.ts`);
        }
        expect(canChangeMoreFiles(current)).toBe(false);
    });
});

describe("canRunMoreCommands", () => {
    test("allows commands up to the budget", () => {
        const current = state({ commandsRun: limits.MAX_COMMANDS - 1 });
        expect(canRunMoreCommands(current)).toBe(true);
    });

    test("blocks commands past the budget", () => {
        const current = state({ commandsRun: limits.MAX_COMMANDS });
        expect(canRunMoreCommands(current)).toBe(false);
    });
});

describe("decideOutcome", () => {
    test("auto_pr when a change was made, validation passed, and a contract gates the run", () => {
        const current = state({
            filesChanged: ["src/client.ts"],
            lastTestResult: { passed: true, output: "exit code: 0" },
            hasContract: true,
        });
        expect(decideOutcome(current)).toBe("auto_pr");
    });

    test("review_pr when verified but no contract gates the run", () => {
        const current = state({
            filesChanged: ["src/client.ts"],
            lastTestResult: { passed: true, output: "exit code: 0" },
        });
        expect(decideOutcome(current)).toBe("review_pr");
    });

    test("draft_pr when the caller prefers drafts and no contract gates the run", () => {
        const current = state({
            filesChanged: ["src/client.ts"],
            lastTestResult: { passed: true, output: "exit code: 0" },
            prMode: "draft",
        });
        expect(decideOutcome(current)).toBe("draft_pr");
    });

    test("auto_pr despite a draft preference when a contract gates the run", () => {
        const current = state({
            filesChanged: ["src/client.ts"],
            lastTestResult: { passed: true, output: "exit code: 0" },
            hasContract: true,
            prMode: "draft",
        });
        expect(decideOutcome(current)).toBe("auto_pr");
    });

    test("review_pr when validation failed", () => {
        const current = state({
            filesChanged: ["src/client.ts"],
            lastTestResult: { passed: false, output: "exit code: 1" },
        });
        expect(decideOutcome(current)).toBe("review_pr");
    });

    test("review_pr when files changed without a test run", () => {
        const current = state({ filesChanged: ["src/client.ts"] });
        expect(decideOutcome(current)).toBe("review_pr");
    });

    test("no_action when nothing changed", () => {
        expect(decideOutcome(state())).toBe("no_action");
    });

    test("review_pr when only a failed command ran", () => {
        const current = state({
            lastTestResult: { passed: false, output: "exit code: 1" },
        });
        expect(decideOutcome(current)).toBe("review_pr");
    });

    test("not auto_pr when tests pass but nothing changed", () => {
        const current = state({ lastTestResult: { passed: true, output: "ok" } });
        expect(decideOutcome(current)).toBe("review_pr");
    });
});
