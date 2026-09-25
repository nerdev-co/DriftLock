import { expect, mock } from "bun:test";
import { createHash } from "crypto";

const mockStore = {
    ensureRepository: mock(async () => ({ id: "repo-1", owner: "acme", name: "payments" })),
    recordRun: mock(async () => ({ id: "run-1", status: "running" })),
    upsertCallSite: mock(async () => {}),
    deleteObsoleteCallSites: mock(async () => {}),
    saveSnapshot: mock(async () => ({ id: "snap-1" })),
    getLatestSnapshot: mock(async () => null),
    recordDrift: mock(async () => {}),
    setCallSiteSnapshotState: mock(async () => {}),
    finishRun: mock(async () => {}),
};

const mockClone = {
    path: "/tmp/driftlock-run-test",
    cleanup: mock(async () => {}),
};

mock.module("@driftlock/db", () => ({
    createDb: mock(() => ({})),
    createStore: mock(() => mockStore),
}));

mock.module("../src/store", () => ({
    getStore: () => mockStore,
}));

mock.module("../src/clone", () => ({
    cloneRepo: mock(async () => mockClone),
}));

const mockAnalyzeResult = {
    callSites: [
        {
            id: "cs-1",
            repositoryId: "repo-1",
            filePath: "src/charge.ts",
            line: 12,
            method: "stripe.charges.create",
            packageName: "stripe",
            endpoint: "/v1/charges",
            httpMethod: "POST",
            requestShape: { amount: {} },
            responseFields: ["id"],
            testFiles: [],
            lastCheckedAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
        },
    ],
    fills: new Map(),
    shapes: new Map([
        [
            "cs-1",
            {
                request: { amount: { kind: "number" } },
                response: { id: { kind: "string" } },
            },
        ],
    ]),
    baselines: [],
    drifts: [],
    exitCode: 0,
    duration: 42,
    trafficCaptured: 3,
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
let analyzeCallCount = 0;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let lastAnalyzeInput: Record<string, unknown> | null = null;

mock.module("@driftlock/pipeline", () => ({
    analyzeAndCompare: mock(async (input: Record<string, unknown>) => {
        analyzeCallCount++;
        lastAnalyzeInput = input;
        return mockAnalyzeResult;
    }),
    applyDriftFix: mock(() => null),
    DbSnapshotStore: mock(function () {}),
    driftConfidence: () => "high",
    driftSummary: () => ({
        addedFields: [],
        removedFields: [],
        typeChanges: [],
        optionalityChanges: [],
        breakingChanges: [],
        nonBreakingChanges: [],
    }),
}));

import { handleRun } from "../src/routes/run";

function makeRequest(body: unknown): Request {
    return new Request("http://localhost:8787/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
}

function out(label: string, value: string | number) {
    console.log(`${label}: ${value}`);
}

async function run() {
    // 1. Empty body
    const r1 = await handleRun(new Request("http://localhost:8787/api/runs", {
        method: "POST",
        body: "not json",
    }));
    out("empty-body", r1.status);

    // 2. Missing owner
    const r2 = await handleRun(makeRequest({ repo: "payments" }));
    out("missing-owner", r2.status);

    // 3. Missing repo
    const r3 = await handleRun(makeRequest({ owner: "acme" }));
    out("missing-repo", r3.status);

    // 4. Success path
    const r4 = await handleRun(makeRequest({ owner: "acme", repo: "payments" }));
    out("success-status", r4.status);
    const d4 = await r4.json();
    out("run-id", d4.run.id);
    out("run-status", d4.run.status);
    out("call-sites", d4.run.callSites);
    out("drifts", d4.run.drifts);
    out("traffic", d4.run.trafficCaptured);

    // 5. Store interactions
    out("ensure-repo", mockStore.ensureRepository.mock.calls[0][0].fullName);
    out("record-run", mockStore.recordRun.mock.calls[0][0].status);
    out("upsert-callsite", mockStore.upsertCallSite.mock.calls[0][1].id);
    out("finish-run", mockStore.finishRun.mock.calls[0][0].status);

    // 6. Default command
    const { analyzeAndCompare } = await import("@driftlock/pipeline");
    await handleRun(makeRequest({ owner: "acme", repo: "payments" }));
    out("default-command", (analyzeAndCompare as ReturnType<typeof mock>).mock.calls[1][0].command);

    // 7. Custom command
    await handleRun(makeRequest({ owner: "acme", repo: "payments", command: "bun test" }));
    out("custom-command", (analyzeAndCompare as ReturnType<typeof mock>).mock.calls[2][0].command);

    // 8. Forward filtering
    await handleRun(makeRequest({ owner: "acme", repo: "payments", forward: ["POST /v3/mail/send", 42, null, "GET /v1/balance"] }));
    out("forward-filter", (analyzeAndCompare as ReturnType<typeof mock>).mock.calls[3][0].forward.length);

    // 9. Base branch
    const { cloneRepo } = await import("../src/clone");
    const cloneBefore = (cloneRepo as ReturnType<typeof mock>).mock.calls.length;
    await handleRun(makeRequest({ owner: "acme", repo: "payments", base: "develop" }));
    const lastCloneCall = (cloneRepo as ReturnType<typeof mock>).mock.calls[cloneBefore];
    out("base-branch", lastCloneCall[2]);

    // 10. Cleanup
    const cleanupBefore = mockClone.cleanup.mock.calls.length;
    await handleRun(makeRequest({ owner: "acme", repo: "payments" }));
    out("cleanup", mockClone.cleanup.mock.calls.length - cleanupBefore);

    // 11. Error path
    mockClone.cleanup.mockClear();
    (analyzeAndCompare as ReturnType<typeof mock>).mockRejectedValueOnce(new Error("boom"));
    const r11 = await handleRun(makeRequest({ owner: "acme", repo: "payments" }));
    out("error-status", r11.status);
    out("error-cleanup", mockClone.cleanup.mock.calls.length);
    out("error-finish", mockStore.finishRun.mock.calls[mockStore.finishRun.mock.calls.length - 1][0].status);

    // 12. Trim whitespace
    await handleRun(makeRequest({ owner: "  acme  ", repo: "  payments  " }));
    out("trim-owner", mockStore.ensureRepository.mock.calls[mockStore.ensureRepository.mock.calls.length - 1][0].owner);
    out("trim-repo", mockStore.ensureRepository.mock.calls[mockStore.ensureRepository.mock.calls.length - 1][0].name);

    // Long IDs sharing a suffix must stay distinct throughout persistence.
    const suffix = `${"nested/".repeat(12)}handler.ts:12:fetch`;
    const callSites = ["first", "second"].map((prefix) => ({
        ...mockAnalyzeResult.callSites[0],
        id: `${mockClone.path}/${prefix}/${suffix}`,
        filePath: import.meta.path,
    }));
    const shapes = mockAnalyzeResult.shapes.get("cs-1")!;
    const { applyDriftFix } = await import("@driftlock/pipeline");
    const fixMock = applyDriftFix as ReturnType<typeof mock>;
    const appliedFix = { fix: { driftEventId: `drift-${callSites[0].id}` }, changes: "changed" };
    fixMock.mockReturnValueOnce(appliedFix);
    (analyzeAndCompare as ReturnType<typeof mock>).mockResolvedValueOnce({
        ...mockAnalyzeResult,
        callSites,
        shapes: new Map(callSites.map((site) => [site.id, shapes])),
        drifts: [{ callSite: callSites[0] }],
    });
    mockStore.upsertCallSite.mockClear();
    mockStore.recordDrift.mockClear();
    const response = await handleRun(makeRequest({ owner: "acme", repo: "payments" }));
    expect(response.status).toBe(200);
    const ids = mockStore.upsertCallSite.mock.calls.map((call) => call[1].id);
    expect(ids).toEqual(callSites.map((site) => createHash("sha256").update(`repo-1:${site.id.slice(mockClone.path.length + 1)}`, "utf8").digest("hex")));
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids.every((id) => id.length === 64)).toBe(true);
    expect(mockStore.deleteObsoleteCallSites.mock.calls.at(-1)![1]).toEqual(ids);
    expect(mockStore.getLatestSnapshot.mock.calls.at(-1)![0]).toBe(ids[0]);
    expect(mockStore.saveSnapshot.mock.calls.at(-1)![0].callSiteId).toBe(ids[0]);
    const event = mockStore.recordDrift.mock.calls[0][0];
    expect(event.id).toBe(`drift-${ids[0]}`);
    expect(event.suggestedFix.driftEventId).toBe(event.id);

    const previousClonePath = mockClone.path;
    mockClone.path = "/tmp/driftlock-another-checkout";
    const nextCallSites = callSites.map((site) => ({
        ...site,
        id: site.id.replace(previousClonePath, mockClone.path),
    }));
    (analyzeAndCompare as ReturnType<typeof mock>).mockResolvedValueOnce({
        ...mockAnalyzeResult,
        callSites: nextCallSites,
        shapes: new Map(nextCallSites.map((site) => [site.id, shapes])),
    });
    mockStore.upsertCallSite.mockClear();
    expect((await handleRun(makeRequest({ owner: "acme", repo: "payments" }))).status).toBe(200);
    expect(mockStore.upsertCallSite.mock.calls.map((call) => call[1].id)).toEqual(ids);
    expect(mockStore.deleteObsoleteCallSites.mock.calls.at(-1)![1]).toEqual(ids);
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
