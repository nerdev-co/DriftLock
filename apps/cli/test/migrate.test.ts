import { describe, expect, test } from "bun:test";
import { buildFixContext, isRemoteRef } from "../migrate";
import type { ProviderChange } from "../migrate";

describe("migrate repo classification", () => {
    // A local path must never be handed to `git clone` as owner/repo, because
    // every absolute path and every ./x path contains a slash.
    for (const local of [
        "./src",
        "./project",
        "../project",
        "../../elsewhere",
        "/workspace/project",
        "/abs/path/proj",
        "src",
        "a",
        "/tmp/driftlock-migrate-123",
    ]) {
        test(`treats ${local} as a local path`, () => {
            expect(isRemoteRef(local)).toBe(false);
        });
    }

    for (const remote of [
        "processing/p5.js",
        "owner/repo",
        "a-b/c.d",
        "org/repo_name",
        "user123/project.v2",
    ]) {
        test(`treats ${remote} as owner/repo`, () => {
            expect(isRemoteRef(remote)).toBe(true);
        });
    }
});

const P5: ProviderChange = {
    provider: "p5",
    fromVersion: "1.11.13",
    toVersion: "2.3.0",
    source: { type: "changelog" },
    summary: "keyIsDown and keyIsPressed moved from instance methods to the prototype",
    affectedAreas: [
        { type: "method", name: "keyIsDown", change: "now an instance method, not a global function" },
        { type: "method", name: "keyIsPressed", change: "now an instance method, not a global function" },
    ],
};

describe("buildFixContext", () => {
    test("carries provider, versions, summary, and each affected-area change", () => {
        const { works } = buildFixContext(P5);
        expect(works).toHaveLength(2);
        for (const w of works) {
            expect(w.description).toContain("p5");
            expect(w.description).toContain("1.11.13");
            expect(w.description).toContain("2.3.0");
            expect(w.description).toContain(P5.summary);
            expect(w.description).toContain(w.field);
        }
        expect(works[0].description).toContain("now an instance method, not a global function");
    });

    test("does not claim symbols were removed from the shape", () => {
        const { diff } = buildFixContext(P5);
        // A "Removed fields" line flips the prompt's rename heuristic and its
        // rule 4 ("explain the impact instead of guessing").
        expect(diff.removedFields).toEqual([]);
        expect(diff.addedFields).toEqual([]);
        expect(diff.changes).toEqual([]);
    });

    test("keeps the real breaking changes recorded", () => {
        const { diff } = buildFixContext(P5);
        expect(diff.breakingChanges).toHaveLength(2);
        expect(diff.breakingChanges[0]).toContain("keyIsDown");
    });

    test("uses no rename operands, so applyFixWork could not no-op silently", () => {
        const { works } = buildFixContext(P5);
        for (const w of works) {
            expect(w.kind).toBe("custom");
            expect(w.from).toBeUndefined();
            expect(w.to).toBeUndefined();
        }
    });
});
