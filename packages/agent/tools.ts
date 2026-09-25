export type ToolName =
    | "inspectRepo"
    | "searchCode"
    | "readFile"
    | "editFile"
    | "replaceInFile"
    | "runCommand"
    | "createPullRequest";

export interface ToolDefinition {
    name: ToolName;
    description: string;
    inputSchema: {
        type: "object";
        properties: Record<string, { type: string; description?: string }>;
        required: string[];
    };
}

export const tools: ToolDefinition[] = [
    {
        name: "inspectRepo",
        description:
            "Inspect the repository: ecosystem, package manager, installed dependency versions, scripts, CI commands, and top-level source files. This information is already in your opening message; call this only if you need the full file list. Takes no arguments.",
        inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "searchCode",
        description:
            "Search the repository for a literal string. Returns matching file paths with line numbers.",
        inputSchema: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Literal text to search for, e.g. legacy_id",
                },
                path: {
                    type: "string",
                    description: "Optional repo-relative directory to limit the search, e.g. src/",
                },
            },
            required: ["query"],
        },
    },
    {
        name: "readFile",
        description:
            "Read a repo-relative file. Returns content with 1-indexed line numbers.",
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string", description: "File path from repo root" },
            },
            required: ["path"],
        },
    },
    {
        name: "editFile",
        description:
            "Apply a unified diff to one file. The patch must apply cleanly. Make the smallest correct change. Never edit test files to make verification pass.",
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string", description: "File path from repo root" },
                patch: {
                    type: "string",
                    description:
                        "Unified diff. Format exactly:\n--- src/foo.ts\n+++ src/foo.ts\n@@ -1,3 +1,3 @@\n context line\n-removed line\n+added line\n\nRules: paths are relative to the repo root and must match `path`; every context line starts with a space, a removal with -, an addition with +; the hunk body must contain the real surrounding lines copied from the file you read.",
                },
            },
            required: ["path", "patch"],
        },
    },
    {
        name: "replaceInFile",
        description:
            "Replace one exact snippet in a file. Prefer this over editFile for small changes: copy oldText verbatim from a readFile result, include enough surrounding lines to be unique, and do not include line numbers. oldText must appear exactly once.",
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string", description: "File path from repo root" },
                oldText: {
                    type: "string",
                    description:
                        "Exact existing text to replace, copied from the file. Must match byte for byte including indentation, and must appear exactly once.",
                },
                newText: {
                    type: "string",
                    description: "Replacement text. Use an empty string to delete.",
                },
            },
            required: ["path", "oldText", "newText"],
        },
    },
    {
        name: "runCommand",
        description:
            "Run a whitelisted verification command in the repository. Only the commands listed in your opening message will be accepted, and only if that script actually exists.",
        inputSchema: {
            type: "object",
            properties: {
                command: {
                    type: "string",
                    description: "Exact command to run, e.g. npm run typecheck",
                },
            },
            required: ["command"],
        },
    },
    {
        name: "createPullRequest",
        description:
            "Open a pull request from the working diff. Only call this after a verification command has passed. The branch must start with 'driftlock/'. Branch names that do not are refused.",
        inputSchema: {
            type: "object",
            properties: {
                title: { type: "string", description: "PR title" },
                body: {
                    type: "string",
                    description:
                        "PR body: what changed, why, and which commands passed",
                },
                branch: {
                    type: "string",
                    description:
                        "Branch name, must start with 'driftlock/', e.g. driftlock/p5-2-3",
                },
            },
            required: ["title", "body", "branch"],
        },
    },
];

export function isToolName(value: string): value is ToolName {
    return tools.some((tool) => tool.name === value);
}

export function toOpenAITools() {
    return tools.map((tool) => ({
        type: "function" as const,
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
        },
    }));
}
