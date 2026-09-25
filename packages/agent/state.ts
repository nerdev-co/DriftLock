import { describeContract, type SymbolFinding, type VendorContract } from "./vendorContract";
import { describeRepoFacts, type RepoFacts } from "./repoFacts";

export type ChangePacket = {
    provider: string;
    fromVersion: string;
    toVersion: string;
    summary: string;
    migrationDocs: string[];
};

export type Outcome = "auto_pr" | "review_pr" | "draft_pr" | "no_action";

/**
 * What the caller wants when the migration cannot be fully verified against
 * a vendor contract. `review` reports `review_pr` (a human must review the
 * diff); `draft` reports `draft_pr` (open it as a draft, if the entry point
 * supports drafts, rather than requesting review).
 */
export type PrMode = "review" | "draft";

export type ToolCall = {
    id: string;
    name: string;
    args: Record<string, unknown>;
};

export type TranscriptEntry = {
    role: "user" | "assistant" | "tool";
    content: string;
    toolCallId?: string;
    toolName?: string;
    toolCalls?: ToolCall[];
};

export type AgentState = {
    iteration: number;
    maxIterations: number;
    maxCommands: number;
    commandsRun: number;
    maxFilesChanged: number;
    filesChanged: string[];
    /** Every tool name invoked so far, which is how the next step is decided. */
    toolsUsed: string[];
    transcript: TranscriptEntry[];
    lastTestResult?: { passed: boolean; output: string };
    /** Vendor symbols the edits introduced that the contract could not resolve. */
    symbolFindings?: SymbolFinding[];
    contractChecked?: boolean;
    /**
     * Whether this run is gated by a vendor contract (both a contract and a
     * vendor config were supplied). Without one, the outcome can never be
     * `auto_pr`: an unverified-against-the-vendor diff is review- or
     * draft-only.
     */
    hasContract: boolean;
    /** The caller's preference for the contract-absent outcome. */
    prMode: PrMode;
    pullRequest?: {
        status: "opened" | "already_open" | "merged";
        url: string;
        number: number;
        branch: string;
    };
    done: boolean;
    outcome: Outcome | null;
};

export const limits = {
    MAX_ITERATIONS: 15,
    MAX_COMMANDS: 30,
    MAX_FILES_CHANGED: 20,
};

export function createInitialState(
    packet: ChangePacket,
    contract?: VendorContract,
    facts?: RepoFacts,
): AgentState {
    const opening = ["ChangePacket:", JSON.stringify(packet, null, 2)];

    if (facts) {
        opening.push(
            "",
            "What this repository actually is, read from its own files before you were asked",
            "to change anything. Trust this over any assumption you would otherwise make.",
            "",
            describeRepoFacts(facts),
        );
    }

    if (contract) {
        opening.push(
            "",
            "The vendor's current API surface, captured from a real source. This is the",
            "authority on what exists. Do not reference a member that is not in this list,",
            "and do not guess at a replacement name.",
            "",
            describeContract(contract),
        );
    }

    // Only the first instruction. The rest arrive as the work actually happens,
    // so the model is never asked to hold the whole plan and every rule in one
    // context at once.
    opening.push("", describeNextStep("locate", facts));

    return {
        iteration: 0,
        maxIterations: limits.MAX_ITERATIONS,
        maxCommands: limits.MAX_COMMANDS,
        commandsRun: 0,
        maxFilesChanged: limits.MAX_FILES_CHANGED,
        filesChanged: [],
        toolsUsed: [],
        transcript: [{ role: "user", content: opening.join("\n") }],
        done: false,
        outcome: null,
        // The runner sets these from its options after creation: a contract
        // plus vendor config means the contract gate can run, and prMode
        // records whether the caller wants review or draft when it cannot.
        hasContract: false,
        prMode: "review",
    };
}

/**
 * Where the migration currently stands, derived from what has actually happened
 * rather than from what the model says it intends to do.
 */
export type MigrationStage =
    | "locate"
    | "read"
    | "edit"
    | "verify"
    | "pr"
    | "done";

export function stageOf(state: AgentState): MigrationStage {
    if (state.done) return "done";
    if (state.lastTestResult?.passed) return "pr";
    if (state.filesChanged.length > 0) return "verify";
    if (state.toolsUsed.includes("readFile")) return "edit";
    if (state.toolsUsed.includes("searchCode")) return "read";
    return "locate";
}

/**
 * The one instruction that matters right now.
 *
 * Progressive rather than exhaustive on purpose. A single opening message that
 * contains the workflow, the edit rules, the gate rules, and the hard rules is a
 * wall of text in which every constraint competes for attention with every other
 * one, and a model asked to satisfy all of it at once tends to satisfy the ones
 * nearest the end. Handing over one step at a time also means the step is
 * enforced by the harness rather than merely requested by a prompt.
 */
export function describeNextStep(stage: MigrationStage, facts?: RepoFacts): string {
    switch (stage) {
        case "locate": {
            const where = facts
                ? facts.verificationCommands.length > 0
                    ? `This project can be verified with: ${facts.verificationCommands.join(", ")}.`
                    : "This project has no verification command, so you will not be able to prove the change works. Report that rather than inventing one."
                : "";
            return [
                "Step 1: find every call site, before changing anything.",
                "Use searchCode once per deprecated name in the change packet. Do not assume where they are, and do not edit a file you have not read.",
                where,
            ]
                .filter(Boolean)
                .join("\n");
        }
        case "read":
            return [
                "Step 2: read each file you found, plus its direct callers.",
                "You are about to change code. Reading first is what keeps the change minimal and correct.",
            ].join("\n");
        case "edit":
            return [
                "Step 3: make the change.",
                "Prefer replaceInFile. Copy oldText verbatim from what you read and include enough surrounding lines to make it unique. Never type line numbers.",
                "Use editFile only when a single contiguous hunk is clearly the best option. A hunk must be an unbroken slice of the file; skipping a line, a closing brace, or a blank line between context lines makes git reject the whole patch.",
                "Make the smallest correct change. No drive-by refactors, no formatting churn.",
            ].join("\n");
        case "verify":
            return [
                "Step 4: verify.",
                facts?.verificationCommands.length
                    ? `Run exactly one of: ${facts.verificationCommands.join(", ")}. Copy it exactly.`
                    : "There is no verification command in this repository, so say that verification is unavailable. Do not invent one.",
                "A migration is not done until it passes. If it fails, read the output, fix the cause, and run it again.",
            ].join("\n");
        case "pr":
            return [
                "Step 5: open the pull request.",
                "Verification passed. Summarise what changed and why, and name the command that passed.",
            ].join("\n");
        case "done":
            return "Stop.";
    }
}

export function recordFileChanged(state: AgentState, path: string): void {
    if (!state.filesChanged.includes(path)) state.filesChanged.push(path);
}

export function canChangeMoreFiles(state: AgentState): boolean {
    return state.filesChanged.length < state.maxFilesChanged;
}

export function canRunMoreCommands(state: AgentState): boolean {
    return state.commandsRun < state.maxCommands;
}

/**
 * A passing test suite is not sufficient on its own. If the contract check found
 * symbols it could not resolve, the migration is unverified no matter what the
 * build says, so it can never reach `auto_pr`. Likewise, without a vendor
 * contract there is nothing checking the edits against the vendor's real API
 * surface, so the best a verified diff can get is `review_pr` — or `draft_pr`
 * when the caller prefers drafts.
 */
export function decideOutcome(state: AgentState): Outcome {
    const contractClean = !state.symbolFindings || state.symbolFindings.length === 0;
    if (state.lastTestResult?.passed && state.filesChanged.length > 0 && contractClean) {
        if (!state.hasContract) {
            return state.prMode === "draft" ? "draft_pr" : "review_pr";
        }
        return "auto_pr";
    }
    if (state.filesChanged.length > 0 || state.lastTestResult) return "review_pr";
    return "no_action";
}
