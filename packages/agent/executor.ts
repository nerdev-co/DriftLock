import { stat } from "node:fs/promises";
import { fingerprintRepo, isTextSearchable, listRepoFiles } from "./repoFacts";
import { allowedCommands, isAllowedCommand } from "./allowedCommands";

export { allowedCommands, isAllowedCommand };

export type ToolResult = { ok: boolean; output: string };

const MAX_READ_CHARS = 8000;
const MAX_COMMAND_CHARS = 4000;
const MAX_SEARCH_HITS = 200;

const PROTECTED_PATTERNS = [
    /(?:^|\/)\.env(?:\..*)?$/,
    /(?:^|\/)\.git\/config$/,
    /(?:\.pem|\.key|\.p12|\.pfx)$/,
    /(?:^|\/)id_rsa(?:\.pub)?$/,
];

function fail(output: string): ToolResult {
    return { ok: false, output };
}

function truncate(value: string, max: number): string {
    if (value.length <= max) return value;
    return `${value.slice(0, max)}\n... [truncated ${value.length - max} chars]`;
}

function isProtectedPath(filePath: string): boolean {
    return PROTECTED_PATTERNS.some((pattern) => pattern.test(filePath));
}

export function resolveInsideRoot(
    root: string,
    filePath: string,
): string | null {
    if (filePath.startsWith("/") || filePath.startsWith("~")) return null;
    if (filePath.split("/").includes("..")) return null;
    if (isProtectedPath(filePath)) return null;
    const segments: string[] = [];
    for (const segment of filePath.split("/")) {
        if (!segment || segment === ".") continue;
        segments.push(segment);
    }
    if (segments.length === 0) return null;
    return `${root}/${segments.join("/")}`;
}

async function collectSourceFiles(root: string, scope?: string): Promise<string[]> {
    const files = await listRepoFiles(root, scope === undefined ? { max: 2000 } : { max: 2000, scope });
    return files.filter(isTextSearchable);
}

export async function inspectRepo(root: string): Promise<ToolResult> {
    try {
        const facts = await fingerprintRepo(root);
        return {
            ok: true,
            output: JSON.stringify(
                {
                    ecosystem: facts.ecosystem,
                    packageManager: facts.packageManager,
                    lockfiles: facts.lockfiles,
                    manifests: facts.manifests,
                    runtime: facts.runtime,
                    scripts: facts.scripts,
                    dependencies: Object.keys(facts.dependencies).sort(),
                    resolvedVersions: facts.resolvedVersions,
                    frameworks: facts.frameworks,
                    ci: facts.ci,
                    verificationCommands: facts.verificationCommands,
                    sourceFiles: facts.sourceFiles,
                    totalSourceFiles: facts.totalSourceFiles,
                    warnings: facts.warnings,
                },
                null,
                2,
            ),
        };
    } catch (error) {
        return fail(`inspectRepo failed: ${String(error)}`);
    }
}

export async function searchCode(
    root: string,
    query: string,
    path?: string,
): Promise<ToolResult> {
    if (!query.trim()) return fail("searchCode requires a non-empty query");
    const target = path ? resolveInsideRoot(root, path) : root;
    if (!target) return fail(`Invalid search path: ${path}`);

    let targetInfo;
    try {
        targetInfo = await stat(target);
    } catch {
        return fail(`Search path not found: ${path}`);
    }
    if (!targetInfo.isDirectory()) {
        return fail(`Search path is not a directory: ${path}`);
    }

    try {
        const files = await collectSourceFiles(target, path);
        const hits: string[] = [];
        const needle = query.toLowerCase();

        for (const relative of files) {
            if (hits.length >= MAX_SEARCH_HITS) break;
            const absolute = `${target}/${relative}`;
            const content = await Bun.file(absolute).text();
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
                if (!lines[i].toLowerCase().includes(needle)) continue;
                const prefix = path ? `${path.replace(/\/$/, "")}/${relative}` : relative;
                hits.push(`${prefix}:${i + 1}: ${lines[i].trim()}`);
                if (hits.length >= MAX_SEARCH_HITS) break;
            }
        }

        if (hits.length === 0) return { ok: true, output: `No matches for "${query}"` };
        return { ok: true, output: hits.join("\n") };
    } catch (error) {
        return fail(`searchCode failed: ${String(error)}`);
    }
}

export async function readFile(
    root: string,
    filePath: string,
): Promise<ToolResult> {
    const absolute = resolveInsideRoot(root, filePath);
    if (!absolute) return fail(`Refused to read: ${filePath}`);
    const file = Bun.file(absolute);
    if (!(await file.exists())) return fail(`File not found: ${filePath}`);
    try {
        const content = await file.text();
        const numbered = content
            .split("\n")
            .map((line, index) => `${String(index + 1).padStart(5, " ")} | ${line}`)
            .join("\n");
        return { ok: true, output: truncate(numbered, MAX_READ_CHARS) };
    } catch (error) {
        return fail(`readFile failed: ${String(error)}`);
    }
}

function stripDiffPrefix(filePath: string): string | null {
    if (filePath === "/dev/null") return null;
    const match = /^[ab]\/(.+)$/.exec(filePath);
    return match ? match[1] : filePath;
}

export function patchTargets(patch: string): (string | null)[] {
    const targets: (string | null)[] = [];
    for (const line of patch.split("\n")) {
        if (line.startsWith("+++ ")) {
            targets.push(stripDiffPrefix(line.slice(4).trim()));
        }
    }
    return targets;
}

/**
 * Rewrites the --- and +++ header lines to the canonical a/<path> and b/<path>
 * form so `git apply` can always run at -p1. Models emit `src/foo.ts`,
 * `a/src/foo.ts`, and other spellings interchangeably, and the wrong strip level
 * makes git report "No such file or directory" for a file that plainly exists.
 * The path has already been validated against the patch targets by the caller,
 * so the declared path is authoritative here.
 */
export function canonicalizePatchHeaders(patch: string, filePath: string): string {
    const lines = patch.split("\n");
    let minusSeen = false;
    let plusSeen = false;
    for (let i = 0; i < lines.length; i += 1) {
        if (!minusSeen && /^---\s/.test(lines[i])) {
            lines[i] = `--- a/${filePath}`;
            minusSeen = true;
            continue;
        }
        if (minusSeen && !plusSeen && /^\+\+\+\s/.test(lines[i])) {
            lines[i] = `+++ b/${filePath}`;
            plusSeen = true;
            break;
        }
    }
    return lines.join("\n");
}

export async function editFile(
    root: string,
    filePath: string,
    patch: string,
): Promise<ToolResult> {
    const absolute = resolveInsideRoot(root, filePath);
    if (!absolute) return fail(`Refused to edit: ${filePath}`);
    if (!patch.includes("@@")) {
        return fail("editFile requires a unified diff with @@ hunk headers");
    }
    if (!/^---\s/m.test(patch) || !/^\+\+\+\s/m.test(patch)) {
        return fail("editFile requires --- and +++ file headers in the diff");
    }

    const targets = patchTargets(patch).filter((target): target is string => target !== null);
    if (patchTargets(patch).length === 0) {
        return fail("editFile could not read a target path from the diff");
    }
    if (targets.length === 0) {
        return fail("editFile cannot target /dev/null as the new file");
    }
    if (targets.some((target) => isProtectedPath(target))) {
        return fail(
            `Refused to edit: patch targets protected path ${targets.filter(isProtectedPath).join(", ")}`,
        );
    }
    const escapes = targets.filter((target) => !resolveInsideRoot(root, target));
    if (escapes.length > 0) {
        return fail(`Refused to edit: patch targets ${escapes.join(", ")}`);
    }
    const unexpected = targets.filter((target) => target !== filePath);
    if (unexpected.length > 0) {
        return fail(
            `editFile path mismatch: declared ${filePath} but the patch targets ${unexpected.join(", ")}`,
        );
    }

    const proc = Bun.spawn(
        ["git", "apply", "--whitespace=nowarn", "--recount", "-p1", "-"],
        {
            cwd: root,
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
        },
    );
    const normalized = canonicalizePatchHeaders(patch, filePath);
    proc.stdin.write(normalized.endsWith("\n") ? normalized : `${normalized}\n`);
    proc.stdin.end();
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;

    if (proc.exitCode !== 0) {
        return fail(
            `editFile failed to apply patch to ${filePath}: ${truncate(stderr || stdout, 2000)}`,
        );
    }
    return { ok: true, output: `Applied patch to ${filePath}` };
}

/**
 * Replaces one exact snippet. Models are far more reliable at copying text they
 * just read than at emitting line numbers and contiguous hunk bodies, and a
 * hunk with a skipped line is rejected by git no matter which flags are used.
 * Requiring exactly one occurrence means the edit is unambiguous, so a wrong
 * guess fails loudly instead of rewriting the wrong site.
 */
export async function replaceInFile(
    root: string,
    filePath: string,
    oldText: string,
    newText: string,
): Promise<ToolResult> {
    const absolute = resolveInsideRoot(root, filePath);
    if (!absolute) return fail(`Refused to edit: ${filePath}`);
    if (isProtectedPath(filePath)) {
        return fail(`Refused to edit: protected path ${filePath}`);
    }
    if (oldText.length === 0) {
        return fail("replaceInFile needs a non-empty oldText to search for");
    }
    if (oldText === newText) {
        return fail("replaceInFile oldText and newText are identical");
    }

    const file = Bun.file(absolute);
    if (!(await file.exists())) {
        return fail(`replaceInFile cannot find ${filePath}`);
    }
    const original = await file.text();
    const occurrences = original.split(oldText).length - 1;
    if (occurrences === 0) {
        return fail(
            `replaceInFile found no match in ${filePath}. Copy oldText exactly from a readFile result, including indentation.`,
        );
    }
    if (occurrences > 1) {
        return fail(
            `replaceInFile found ${occurrences} matches in ${filePath}. Include more surrounding lines in oldText so it is unique.`,
        );
    }

    const updated = original.replace(oldText, newText);
    await Bun.write(absolute, updated);
    const removed = oldText.split("\n").length;
    const added = newText.split("\n").length;
    return {
        ok: true,
        output: `Replaced ${removed} line(s) with ${added} line(s) in ${filePath}`,
    };
}

const DENIED_ENV_KEY = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE|SESSION|COOKIE|AUTH/i;
const PASSTHROUGH_ENV = new Set([
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "SHELL",
    "TERM",
    "NODE_OPTIONS",
    "NPM_CONFIG_USERCONFIG",
    "npm_config_userconfig",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "BUN_INSTALL",
]);

export function buildSandboxEnv(
    source: Record<string, string | undefined>,
): Record<string, string> {
    const env: Record<string, string> = { CI: "1" };
    for (const [key, value] of Object.entries(source)) {
        if (value === undefined) continue;
        if (PASSTHROUGH_ENV.has(key)) {
            env[key] = value;
            continue;
        }
        if (DENIED_ENV_KEY.test(key)) continue;
        env[key] = value;
    }
    return env;
}

export async function runCommand(
    root: string,
    command: string,
): Promise<ToolResult> {
    if (!isAllowedCommand(command)) {
        return fail(
            `Command not allowed: ${command.trim()}. Allowed commands: ${allowedCommands().join(", ")}`,
        );
    }
    const proc = Bun.spawn(command.trim().split(/\s+/), {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: buildSandboxEnv(process.env),
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;
    const passed = proc.exitCode === 0;
    return {
        ok: passed,
        output: truncate(
            `exit code: ${proc.exitCode}\n${stdout}\n${stderr}`,
            MAX_COMMAND_CHARS,
        ),
    };
}

export async function collectDiffStat(root: string): Promise<string> {
    const proc = Bun.spawn(["git", "diff", "--stat"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return stdout.trim();
}

export async function hasUncommittedChanges(root: string): Promise<boolean> {
    const proc = Bun.spawn(["git", "status", "--porcelain"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return stdout.trim().length > 0;
}

export async function isGitRepository(root: string): Promise<boolean> {
    const proc = Bun.spawn(["git", "rev-parse", "--is-inside-work-tree"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return proc.exitCode === 0 && stdout.trim() === "true";
}
