import OpenAI from "openai";
import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { isToolName, toOpenAITools } from "./tools";
import { SYSTEM_PROMPT } from "./prompt";
import {
    canChangeMoreFiles,
    canRunMoreCommands,
    createInitialState,
    decideOutcome,
    describeNextStep,
    limits,
    recordFileChanged,
    stageOf,
    type AgentState,
    type ChangePacket,
    type MigrationStage,
    type Outcome,
    type PrMode,
    type ToolCall,
    type TranscriptEntry,
} from "./state";
import {
    collectDiffStat,
    editFile,
    hasUncommittedChanges,
    inspectRepo,
    isGitRepository,
    readFile,
    replaceInFile,
    resolveInsideRoot,
    runCommand,
    searchCode,
    type ToolResult,
} from "./executor";
import {
    commitMessageFor,
    isAllowedBranch,
    readChangedFiles,
    type PullRequestPublisher,
    type PullRequestTarget,
} from "./publisher";
import type { CommandRunner } from "./commandRunner";
import {
    verifyVendorSymbols,
    type SymbolFinding,
    type VendorContract,
} from "./vendorContract";
import type { VendorConfig } from "@driftlock/core";
import { fingerprintRepo, type RepoFacts } from "./repoFacts";

/**
 * Reads the changed files off disk and runs the contract check over them.
 *
 * Changed files get the full check, because that is where the agent introduced
 * something and it has to answer for it.
 */
async function checkChangedFiles(
    root: string,
    files: string[],
    contract: VendorContract,
    vendor: VendorConfig,
): Promise<SymbolFinding[]> {
    const sources = new Map<string, string>();
    for (const file of files) {
        const absolute = resolveInsideRoot(root, file);
        if (!absolute) continue;
        const handle = Bun.file(absolute);
        if (await handle.exists()) sources.set(file, await handle.text());
    }
    if (sources.size === 0) return [];
    return verifyVendorSymbols(contract, sources, { vendor });
}

const CONTRACT_SCAN_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const CONTRACT_SKIP_DIRS = new Set([
    ".git",
    "node_modules",
    "dist",
    "build",
    ".next",
    "coverage",
    ".turbo",
]);
const MAX_CONTRACT_FILES = 500;

/**
 * Sweeps the whole repository for reads of fields the vendor removed.
 *
 * This is the completeness half of the check, and it deliberately reaches past
 * the files the agent touched. The failure it exists for is a migration that
 * edits two of three call sites: the diff looks finished, the tests pass, and
 * the third file is never opened. A stale read is a missed call site wherever
 * it is, so untouched files are scanned too.
 *
 * Only `stale` is reported from these files. Pre-existing use of some other
 * field is not this migration's problem, and reporting it would bury the one
 * finding that matters.
 */
async function sweepStaleReferences(
    root: string,
    changed: Set<string>,
    contract: VendorContract,
    vendor: VendorConfig,
): Promise<SymbolFinding[]> {
    if (contract.removed.length === 0) return [];

    const sources = new Map<string, string>();
    const queue: string[] = [root];
    let seen = 0;

    while (queue.length > 0 && seen < MAX_CONTRACT_FILES) {
        const dir = queue.pop();
        if (!dir) break;
        let entries: Dirent[];
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (entry.name.startsWith(".") && entry.name !== ".env") continue;
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!CONTRACT_SKIP_DIRS.has(entry.name)) queue.push(full);
                continue;
            }
            if (!CONTRACT_SCAN_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue;
            if (changed.has(full.slice(root.length + 1))) continue;
            if (seen >= MAX_CONTRACT_FILES) break;
            seen += 1;
            try {
                sources.set(full.slice(root.length + 1), await Bun.file(full).text());
            } catch {
                continue;
            }
        }
    }

    if (sources.size === 0) return [];
    return verifyVendorSymbols(contract, sources, { vendor, reportOnlyStale: true });
}

export type RunOptions = {
    root: string;
    packet: ChangePacket;
    apiKey?: string;
    model?: string;
    baseURL?: string;
    client?: OpenAI;
    publisher?: PullRequestPublisher;
    target?: PullRequestTarget;
    commandRunner?: CommandRunner;
    /**
     * Ground truth about the vendor's API surface. When present it is injected
     * into the opening message and enforced before any pull request is opened.
     */
    contract?: VendorContract;
    vendor?: VendorConfig;
    /**
     * What the caller wants when no vendor contract gates the run. Without a
     * contract the outcome is capped at `review_pr` (`review`, the default) or
     * `draft_pr` (`draft`), never `auto_pr`.
     */
    prMode?: PrMode;
    /**
     * Overrides the repository fingerprint. Normally this is read from disk
     * before the loop starts, because the model cannot be trusted to go looking
     * for it, but a caller that already knows the facts can supply them.
     */
    repoFacts?: RepoFacts;
};

export type RunResult = {
    outcome: Outcome;
    state: AgentState;
    filesChanged: string[];
};

type RunnerDeps = {
    create: OpenAI["chat"]["completions"]["create"];
};

function toWireMessages(
    transcript: TranscriptEntry[],
): ChatCompletionMessageParam[] {
    const messages: ChatCompletionMessageParam[] = [];
    for (const entry of transcript) {
        if (entry.role === "tool") {
            if (entry.toolCallId) {
                messages.push({
                    role: "tool",
                    tool_call_id: entry.toolCallId,
                    content: entry.content,
                });
            }
            continue;
        }
        if (entry.role === "assistant" && entry.toolCalls?.length) {
            messages.push({
                role: "assistant",
                content: entry.content || "",
                tool_calls: entry.toolCalls.map((call) => ({
                    id: call.id,
                    type: "function" as const,
                    function: { name: call.name, arguments: JSON.stringify(call.args) },
                })),
            });
            continue;
        }
        messages.push({ role: entry.role, content: entry.content });
    }
    return messages;
}

function parseToolCalls(raw: unknown): ToolCall[] {
    if (!Array.isArray(raw)) return [];
    const calls: ToolCall[] = [];
    for (const item of raw) {
        const call = item as {
            id?: unknown;
            function?: { name?: unknown; arguments?: unknown };
        };
        if (typeof call.id !== "string") continue;
        if (typeof call.function?.name !== "string") continue;
        if (!isToolName(call.function.name)) continue;
        let args: Record<string, unknown> = {};
        if (typeof call.function.arguments === "string" && call.function.arguments.trim()) {
            try {
                const parsed = JSON.parse(call.function.arguments) as unknown;
                if (parsed && typeof parsed === "object") {
                    args = parsed as Record<string, unknown>;
                }
            } catch {
                args = {};
            }
        }
        calls.push({ id: call.id, name: call.function.name, args });
    }
    return calls;
}

function readString(args: Record<string, unknown>, key: string): string {
    const value = args[key];
    return typeof value === "string" ? value : "";
}

async function execute(
    name: ToolCall["name"],
    args: Record<string, unknown>,
    options: RunOptions,
    state: AgentState,
): Promise<ToolResult> {
    const root = options.root;
    switch (name) {
        case "inspectRepo":
            return inspectRepo(root);
        case "searchCode":
            return searchCode(root, readString(args, "query"), readString(args, "path") || undefined);
        case "readFile":
            return readFile(root, readString(args, "path"));
        case "editFile": {
            if (!canChangeMoreFiles(state)) {
                return {
                    ok: false,
                    output: `Refusing edit: MAX_FILES_CHANGED (${state.maxFilesChanged}) reached`,
                };
            }
            const result = await editFile(root, readString(args, "path"), readString(args, "patch"));
            if (result.ok) {
                recordFileChanged(state, readString(args, "path"));
                // A passing verification no longer describes the tree once it is edited.
                state.lastTestResult = undefined;
            }
            return result;
        }
        case "replaceInFile": {
            if (!canChangeMoreFiles(state)) {
                return {
                    ok: false,
                    output: `Refusing edit: MAX_FILES_CHANGED (${state.maxFilesChanged}) reached`,
                };
            }
            const result = await replaceInFile(
                root,
                readString(args, "path"),
                readString(args, "oldText"),
                readString(args, "newText"),
            );
            if (result.ok) {
                recordFileChanged(state, readString(args, "path"));
                // A passing verification no longer describes the tree once it is edited.
                state.lastTestResult = undefined;
            }
            return result;
        }
        case "runCommand": {
            if (!canRunMoreCommands(state)) {
                return {
                    ok: false,
                    output: `Refusing command: MAX_COMMANDS (${state.maxCommands}) reached`,
                };
            }
            state.commandsRun += 1;
            const command = readString(args, "command");
            const result = options.commandRunner
                ? await options.commandRunner.run(root, command)
                : await runCommand(root, command);
            state.lastTestResult = { passed: result.ok, output: result.output };
            return result;
        }
        case "createPullRequest":
            return openPullRequest(
                args,
                options.packet,
                options.publisher,
                options.target,
                state,
                root,
                options.contract,
                options.vendor,
            );
        default:
            return { ok: false, output: `Unknown tool: ${String(name)}` };
    }
}

async function openPullRequest(
    args: Record<string, unknown>,
    packet: ChangePacket,
    publisher: PullRequestPublisher | undefined,
    target: PullRequestTarget | undefined,
    state: AgentState,
    root: string,
    contract?: VendorContract,
    vendor?: VendorConfig,
): Promise<ToolResult> {
    const title = readString(args, "title").trim();
    const body = readString(args, "body").trim();
    const branch = readString(args, "branch").trim();

    if (!title) return { ok: false, output: "createPullRequest requires a title" };
    if (!isAllowedBranch(branch)) {
        return {
            ok: false,
            output: `Refusing branch "${branch}": must start with "driftlock/" and use only letters, digits, . _ - /`,
        };
    }
    if (state.filesChanged.length === 0) {
        return { ok: false, output: "Refusing to open a PR with no changed files" };
    }
    if (state.lastTestResult?.passed !== true) {
        return {
            ok: false,
            output:
                "Refusing to open a PR: no passing verification command. Run an allowed command and fix failures first.",
        };
    }

    if (contract && vendor) {
        const findings = [
            ...(await checkChangedFiles(root, state.filesChanged, contract, vendor)),
            ...(await sweepStaleReferences(
                root,
                new Set(state.filesChanged),
                contract,
                vendor,
            )),
        ];
        state.symbolFindings = findings;
        state.contractChecked = true;
        if (findings.length > 0) {
            return {
                ok: false,
                output: [
                    `Refusing to open a PR: ${findings.length} vendor symbol(s) do not match the ${contract.provider} contract captured from ${contract.source} (${contract.origin}). Changed files get a full check, and the rest of the repository is swept for fields this migration removed.`,
                    "",
                    ...findings.map(
                        (finding) =>
                            `- ${finding.file}:${finding.line} ${finding.kind}: ${finding.detail}\n    ${finding.text}`,
                    ),
                    "",
                    "Fix every line above, then call createPullRequest again. The contract is the authority; do not argue with it.",
                ].join("\n"),
            };
        }
    }

    if (!(await isGitRepository(root))) {
        return { ok: false, output: "The repository root is not a git repository" };
    }
    if (!(await hasUncommittedChanges(root))) {
        return { ok: false, output: "Refusing to open a PR: the working tree is clean" };
    }

    if (!publisher || !target) {
        const stat = await collectDiffStat(root);
        return {
            ok: true,
            output: [
                `PREVIEW ONLY, no pull request was opened.`,
                `A publisher and target were not supplied to the agent.`,
                `Would open on branch ${branch} against ${target?.base ?? "<base>"}`,
                `Title: ${title}`,
                `Body: ${body}`,
                `Diff stat: ${stat || "(no changes)"}`,
            ].join("\n"),
        };
    }

    const files = await readChangedFiles(root, state.filesChanged);
    if (files.length === 0) {
        return { ok: false, output: "No changed files could be read from disk" };
    }

    let result: Awaited<ReturnType<PullRequestPublisher["publish"]>>;
    try {
        result = await publisher.publish({
            target,
            title,
            body,
            branch,
            files,
            commitMessage: commitMessageFor({
                provider: packet.provider,
                fromVersion: packet.fromVersion,
                toVersion: packet.toVersion,
            }),
        });
    } catch (error) {
        return {
            ok: false,
            output: `Pull request could not be opened (${error instanceof Error ? error.message : String(error)}). Edits are kept locally; fix the cause and call createPullRequest again.`,
        };
    }

    state.pullRequest = result;
    return {
        ok: true,
        output: [
            `Pull request ${result.status}: ${result.url}`,
            `Branch: ${result.branch}`,
            `Files published: ${files.length}`,
        ].join("\n"),
    };
}

export async function runMigrationAgent(options: RunOptions): Promise<RunResult> {
    const client =
        options.client ??
        new OpenAI({
            apiKey: options.apiKey ?? process.env.OPENAI_API_KEY,
            ...(options.baseURL ? { baseURL: options.baseURL } : {}),
        });
    const deps: RunnerDeps = { create: client.chat.completions.create.bind(client.chat.completions) };
    // Stage 0. Read what the repository is before the model gets a say, so that
    // the opening message contains the real scripts, the real package manager,
    // and the installed version of whatever is being migrated. An agent asked to
    // migrate a repository it has not looked at will guess, and a wrong guess
    // about a script name is indistinguishable from a real build failure.
    const facts = options.repoFacts ?? (await fingerprintRepo(options.root));
    const state = createInitialState(options.packet, options.contract, facts);
    // The contract gate needs both halves: the API surface and the config
    // that says which receivers it applies to. Anything less is ungated.
    state.hasContract = Boolean(options.contract && options.vendor);
    if (options.prMode) state.prMode = options.prMode;
    const model = options.model ?? "gpt-4o-mini";
    let lastStage: MigrationStage | null = null;

    while (!state.done && state.iteration < state.maxIterations) {
        state.iteration++;

        // The opening message carries the grounding and the first instruction
        // only. Each time the work crosses into a new stage, the instruction for
        // that stage is appended, so the model is told what to do next at the
        // moment it becomes relevant rather than being handed the whole plan up
        // front and expected to remember the relevant part.
        const stage = stageOf(state);
        if (stage !== lastStage) {
            if (lastStage !== null) {
                state.transcript.push({
                    role: "user",
                    content: describeNextStep(stage, facts),
                });
            }
            lastStage = stage;
        }

        const response = await deps.create({
            model,
            temperature: 0.1,
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                ...toWireMessages(state.transcript),
            ],
            tools: toOpenAITools(),
            tool_choice: "auto",
        });

        const message = response.choices[0]?.message;
        const toolCalls = parseToolCalls(
            (message as { tool_calls?: unknown } | undefined)?.tool_calls,
        );

        if (toolCalls.length === 0) {
            state.transcript.push({
                role: "assistant",
                content: message?.content ?? "",
            });
            state.done = true;
            state.outcome = decideOutcome(state);
            break;
        }

        state.transcript.push({
            role: "assistant",
            content: message?.content ?? "",
            toolCalls,
        });

        for (const call of toolCalls) {
            const result = await execute(call.name, call.args, options, state);
            if (!state.toolsUsed.includes(call.name)) state.toolsUsed.push(call.name);
            state.transcript.push({
                role: "tool",
                toolCallId: call.id,
                toolName: call.name,
                content: result.ok ? result.output : `FAILED: ${result.output}`,
            });
            if (call.name === "createPullRequest" && result.ok) state.done = true;
        }

        if (state.filesChanged.length >= limits.MAX_FILES_CHANGED) {
            state.done = true;
            state.outcome = "review_pr";
        }

        if (state.done && !state.outcome) {
            state.outcome = decideOutcome(state);
        }
    }

    if (!state.done) {
        state.done = true;
        state.outcome =
            state.iteration >= state.maxIterations && state.filesChanged.length > 0
                ? "review_pr"
                : decideOutcome(state);
    }

    return {
        outcome: state.outcome ?? decideOutcome(state),
        state,
        filesChanged: state.filesChanged,
    };
}
