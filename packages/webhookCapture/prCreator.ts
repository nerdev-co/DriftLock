import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { Octokit } from "octokit";
import {
    diffShapes,
    fixWorksForDiff,
    applyFixWork,
    type FixWork,
    type ShapeDiffResult,
    type Shape,
    type ShapeNode,
} from "@driftlock/diff";
import { PRWriter, type WriteFile } from "@driftlock/git";
import { generateAIFix, type AIFixConfig, type AIFixResult } from "@driftlock/aiFix";
import type { DriftAlert } from "./driftDetector";
import type { FlatSchema } from "./schemaFlattener";

export interface WebhookPRInput {
    owner: string;
    repo: string;
    base: string;
    repoPath: string;
    alert: DriftAlert;
    token: string;
    ai?: AIFixConfig;
}

export interface WebhookPRResult {
    status: "opened" | "already_open" | "no_fixable_files" | "no_matches";
    url?: string;
    number?: number;
    branch?: string;
    filesChanged: string[];
}

function flatToShape(flat: FlatSchema): Shape {
    const shape: Shape = {};
    for (const [path, kind] of Object.entries(flat)) {
        shape[path] = { kind: kind as ShapeNode["kind"] };
    }
    return shape;
}

function alertToWorks(alert: DriftAlert): FixWork[] {
    const oldShape = flatToShape(alert.previous);
    const newShape = flatToShape(alert.current);

    const responseDiff: ShapeDiffResult = diffShapes(oldShape, newShape);

    return fixWorksForDiff(responseDiff);
}

function scanForAffectedFiles(
    repoPath: string,
    works: FixWork[],
): Array<{ filePath: string; fullPath: string }> {
    const results: Array<{ filePath: string; fullPath: string }> = [];
    const seen = new Set<string>();

    const files = readdirSync(repoPath, { recursive: true })
        .filter(
            (file): file is string =>
                typeof file === "string" &&
                /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file),
        )
        .filter((file) => !file.includes("node_modules"));

    for (const file of files) {
        const fullPath = join(repoPath, file);
        let content: string;
        try {
            content = readFileSync(fullPath, "utf8");
        } catch {
            continue;
        }

        for (const work of works) {
            if (work.kind === "field_rename" && work.from && work.to) {
                const regex = new RegExp(
                    `(?<![\\w])${work.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`,
                    "g",
                );
                if (regex.test(content) && !seen.has(fullPath)) {
                    results.push({ filePath: file, fullPath });
                    seen.add(fullPath);
                }
            } else if (work.kind === "null_check" && work.field) {
                const fieldParts = work.field.split(".");
                const leaf = fieldParts[fieldParts.length - 1];
                const regex = new RegExp(
                    `(?<![\\w.])[\\w$]+(?:\\.[\\w$]+)*\\.${leaf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`,
                    "g",
                );
                if (regex.test(content) && !seen.has(fullPath)) {
                    results.push({ filePath: file, fullPath });
                    seen.add(fullPath);
                }
            } else if (work.kind === "custom" && work.field) {
                // For removed fields, search for the leaf field name
                const fieldParts = work.field.split(".");
                const leaf = fieldParts[fieldParts.length - 1];
                const regex = new RegExp(
                    `[\\w$]+(?:\\.[\\w$]+)*\\.${leaf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
                    "g",
                );
                if (regex.test(content) && !seen.has(fullPath)) {
                    results.push({ filePath: file, fullPath });
                    seen.add(fullPath);
                }
            }
        }
    }

    return results;
}

function applyFixesToSource(
    source: string,
    works: FixWork[],
): string | null {
    let changed = source;
    for (const work of works) {
        const result = applyFixWork(work, changed);
        if (result) {
            changed = result;
        }
    }
    return changed === source ? null : changed;
}

// A key's value that means this is a label or a type rather than a real field.
// `outer: for (...)` is a label, and `({ payment }: { payment: any })` is a
// parameter type: TypeScript type literals are indistinguishable from object
// literals to a regex, and treating one as an invented field rejected valid TSX.
const NOT_A_VALUE = /^(?:for|while|do|switch|if|try|return|throw|function|class|const|let|var|any|unknown|never|string|number|boolean|object|symbol|bigint|void|null|undefined)\b/;
// `default` is a switch label that happens to follow a `{`.
const NOT_A_KEY = new Set([
    "default", "case", "else", "do", "try", "catch", "finally",
    "new", "typeof", "void", "delete", "in", "instanceof", "of", "this",
]);

/**
 * Keys written explicitly as `key:` inside an object literal, ignoring comments.
 * Shorthand properties are deliberately not matched: `{ payment_method }` is a
 * reference to an existing binding, not an invented field.
 */
function objectLiteralKeys(code: string): Set<string> {
    const masked = code
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/\/\/[^\n]*/g, " ");
    const keys = new Set<string>();
    const keyRe =
        /(?<=[{,])[ \t\r\n]*(?:"([^"\n]*)"|'([^'\n]*)'|([A-Za-z_$][\w$]*))[ \t\r\n]*:(?!:)([ \t\r\n]*)(\S{0,6})/g;
    let match: RegExpExecArray | null;
    while ((match = keyRe.exec(masked)) !== null) {
        const key = match[1] ?? match[2] ?? match[3];
        if (!key || NOT_A_KEY.has(key)) continue;
        // `outer: for (...)` is a label, and `{ payment: any }` is a type.
        if (NOT_A_VALUE.test(match[5] ?? "")) continue;
        keys.add(key);
    }
    return keys;
}

export function isValidAIFix(
    fixedCode: string,
    works: FixWork[],
    originalCode: string,
    filePath = "file.ts",
): boolean {
    if (fixedCode === originalCode) return false;
    if (/\/\/\s*Added new field/i.test(fixedCode)) return false;
    const loader = filePath.endsWith(".tsx")
        ? "tsx"
        : filePath.endsWith(".jsx")
          ? "jsx"
          : /\.(js|mjs|cjs)$/.test(filePath)
            ? "js"
            : "ts";
    try {
        // Parse source syntax without executing the generated code.
        new Bun.Transpiler({ loader }).transformSync(fixedCode);
    } catch {
        return false;
    }
    for (const work of works) {
        if (work.kind === "field_rename" && work.from && work.to) {
            const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const toRe = new RegExp(`\\b${esc(work.to)}\\b`);
            const fromRe = new RegExp(`\\b${esc(work.from)}\\b`);
            // New field must appear somewhere
            if (!toRe.test(fixedCode)) return false;
            // Old field must not remain as a property access (e.g., .source or source:)
            if (fromRe.test(fixedCode)) {
                // Allow if from appears only inside to (not applicable here, but keep strict)
                return false;
            }
            const leaf = work.to.split(".").pop()!;
            const camelCase = leaf.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
            if (camelCase !== leaf) {
                // Reject invented accesses, but preserve existing accesses and local aliases.
                const accessRe = new RegExp(
                    `(?<![\\w$])[\\w$]+(?:\\s*(?:\\?\\.|\\.)\\s*[\\w$]+)*\\s*(?:(?:\\?\\.|\\.)\\s*${esc(camelCase)}(?![\\w$])|(?:\\?\\.)?\\s*\\[\\s*(["'])${esc(camelCase)}\\1\\s*\\])`,
                    "g",
                );
                const accesses = (code: string) => new Set(
                    Array.from(code.matchAll(accessRe), ([access]) => access
                        .replace(/\s+/g, "")
                        .replace(/(?:\?\.)?\[['"]([^'"]+)['"]\]/g, ".$1")
                        .replace(/\?\./g, ".")),
                );
                const originalAccesses = accesses(originalCode);
                for (const access of accesses(fixedCode)) {
                    if (!originalAccesses.has(access)) return false;
                }
                // The access check only sees `a.b` and `a["b"]`, so a bare
                // object-literal key is invisible to it. Without this, a fix can
                // add `{ paymentMethod: "..." }` next to a correct rename and
                // sail through on the strength of the one legitimate key.
                const originalKeys = objectLiteralKeys(originalCode);
                const allowedKeys = new Set([work.to.split(".").pop()!]);
                for (const key of objectLiteralKeys(fixedCode)) {
                    if (!originalKeys.has(key) && !allowedKeys.has(key)) return false;
                }
            }
        }
    }
    return true;
}

export async function createWebhookFixPR(
    input: WebhookPRInput,
): Promise<WebhookPRResult> {
    const works = alertToWorks(input.alert);
    if (works.length === 0) {
        return { status: "no_matches", filesChanged: [] };
    }

    const affectedFiles = scanForAffectedFiles(input.repoPath, works);
    if (affectedFiles.length === 0) {
        return { status: "no_matches", filesChanged: [] };
    }

    const files: WriteFile[] = [];
    for (const { filePath, fullPath } of affectedFiles) {
        const content = readFileSync(fullPath, "utf8");

        let fixed: string | null = null;

        if (input.ai) {
            try {
                const diff: ShapeDiffResult = {
                    addedFields: input.alert.diff.added,
                    removedFields: input.alert.diff.removed,
                    typeChanges: input.alert.diff.typeChanged.map((c) => ({
                        field: c.field,
                        oldType: c.from,
                        newType: c.to,
                    })),
                    optionalityChanges: [],
                    breakingChanges: [],
                    nonBreakingChanges: [],
                    confidence: "high",
                    changes: [],
                };

                const aiResult: AIFixResult = await generateAIFix(
                    {
                        diff,
                        works,
                        sourceCode: content,
                        filePath,
                        eventType: input.alert.eventType,
                    },
                    input.ai,
                );

                if (aiResult.confidence >= 60) {
                    if (!isValidAIFix(aiResult.fixedCode, works, content, filePath)) {
                        console.log(
                            `  [AI] ${filePath}: AI fix failed validation (semantic check), falling back to deterministic`,
                        );
                    } else {
                        fixed = aiResult.fixedCode;
                        console.log(
                            `  [AI] ${filePath}: confidence=${aiResult.confidence} - ${aiResult.explanation.slice(0, 100)}`,
                        );
                    }
                } else {
                    console.log(
                        `  [AI] ${filePath}: confidence=${aiResult.confidence} too low, falling back to deterministic`,
                    );
                }
            } catch (err) {
                console.error(`  [AI] ${filePath}: AI fix failed, falling back to deterministic:`, err);
            }
        }

        if (!fixed) {
            fixed = applyFixesToSource(content, works);
        }

        if (fixed) {
            files.push({ path: filePath, content: fixed });
        }
    }

    if (files.length === 0) {
        return { status: "no_fixable_files", filesChanged: [] };
    }

    const branch = `driftlock/webhook-fix-${input.alert.endpointId.slice(0, 8)}`;
    const title = buildWebhookPRTitle(input.alert, works);
    const body = buildWebhookPRBody(input.alert, works, files);
    const commitMessage = `driftlock: fix webhook schema drift for ${input.alert.eventType}`;

    const octokit = new Octokit({ auth: input.token });
    const writer = new PRWriter(octokit);

    const result = await writer.writeFixPR({
        owner: input.owner,
        repo: input.repo,
        base: input.base,
        branch,
        title,
        body,
        commitMessage,
        files,
        octokit,
    });

    return {
        status: "opened",
        url: result.url,
        number: result.number,
        branch: result.branch,
        filesChanged: files.map((f) => f.path),
    };
}

function buildWebhookPRTitle(alert: DriftAlert, works: FixWork[]): string {
    const primary = works[0];
    const action =
        primary.kind === "field_rename"
            ? "Rename"
            : primary.kind === "null_check"
              ? "Add null check for"
              : primary.kind === "type_coercion"
                ? "Update type for"
                : "Fix";
    return `driftlock: ${action} ${alert.eventType} webhook handler`;
}

function buildWebhookPRBody(
    alert: DriftAlert,
    works: FixWork[],
    files: WriteFile[],
): string {
    const changes = works
        .map((w) => `- **${w.kind}:** ${w.description}`)
        .join("\n");

    const added = alert.diff.added.length
        ? `  - Added: ${alert.diff.added.join(", ")}`
        : "";
    const removed = alert.diff.removed.length
        ? `  - Removed: ${alert.diff.removed.join(", ")}`
        : "";
    const changed = alert.diff.typeChanged.length
        ? `  - Type changed: ${alert.diff.typeChanged.map((c) => `${c.field}: ${c.from}→${c.to}`).join(", ")}`
        : "";

    return `## DriftLock Webhook Schema Drift Fix

### What changed
The schema for \`${alert.eventType}\` changed:
${added}
${removed}
${changed}

### Fixes applied
${changes}

### Files changed
${files.map((f) => `- \`${f.path}\``).join("\n")}

### Schema diff
\`\`\`
Previous: ${Object.entries(alert.previous).map(([k, v]) => `${k}: ${v}`).join(", ")}
Current:  ${Object.entries(alert.current).map(([k, v]) => `${k}: ${v}`).join(", ")}
\`\`\`

---
*Generated by [DriftLock](https://github.com/nerdev-co/DriftLock). Self-maintaining APIs.*`;
}
