import { readFileSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import type { AIFixConfig } from "@driftlock/aiFix";
import type { FixWork, ShapeDiffResult } from "@driftlock/diff";
import { listRepoFiles } from "@driftlock/agent";

export interface ProviderChange {
  provider: string;
  fromVersion?: string;
  toVersion?: string;
  source: { type: string; url?: string };
  summary: string;
  affectedAreas: Array<{ type: string; name: string; change: string }>;
}

/**
 * A remote reference is `owner/repo` and nothing else. A bare `/` appears in
 * every absolute and relative path, so testing for it alone sends
 * `/workspace/project` and `./project` to `git clone` as GitHub coordinates.
 */
export function isRemoteRef(repo: string): boolean {
  // Each segment must start alphanumeric, so "./project" and "../project" are
  // rejected even though "." and "-" are legal inside a GitHub name.
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repo);
}

const SCANNED_EXTENSIONS = [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"];

function isScannable(file: string): boolean {
  return SCANNED_EXTENSIONS.some((ext) => file.endsWith(ext));
}

interface ScanResult {
  hits: string[];
  /** Files that could not be read, so their absence from `hits` proves nothing. */
  unreadable: Array<{ file: string; reason: string }>;
}

/**
 * Grep-equivalent substring search, with no shell involved. A file we cannot
 * read is reported rather than skipped silently: a silent skip makes the scan
 * claim a symbol is absent when it was merely unreadable.
 */
function grep(root: string, files: string[], needle: string): ScanResult {
  const hits: string[] = [];
  const unreadable: Array<{ file: string; reason: string }> = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(root, file), "utf8");
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      // ENOENT means the file vanished between the walk and the read, which is
      // a benign race. Anything else (EACCES, EISDIR, EIO) hides real matches.
      if (err.code !== "ENOENT") {
        unreadable.push({ file, reason: err.code ?? err.message });
      }
      continue;
    }
    if (text.includes(needle)) hits.push(file);
  }
  return { hits, unreadable };
}

/**
 * Turn a ProviderChange into the shape the fix generator consumes, so the
 * model gets the requested migration instead of an empty spec.
 *
 * The diff deliberately reports no added/removed/type-changed fields. These
 * changes are semantic rewrites of symbols that still exist under the same
 * name, and claiming a field was "removed" makes `buildPrompt` both suggest a
 * same-parent rename heuristic and instruct the model (rule 4) to explain the
 * impact rather than perform the migration. That is the opposite of the task.
 * The real context is carried by `works[].description`, the only per-work
 * field `buildPrompt` renders.
 */
export function buildFixContext(change: ProviderChange): {
  diff: ShapeDiffResult;
  works: FixWork[];
} {
  const versions = `${change.fromVersion ?? "?"} → ${change.toVersion ?? "?"}`;
  const diff: ShapeDiffResult = {
    addedFields: [],
    removedFields: [],
    typeChanges: [],
    optionalityChanges: [],
    breakingChanges: change.affectedAreas.map((a) => `${a.name}: ${a.change}`),
    nonBreakingChanges: [],
    confidence: "medium",
    changes: [],
  };
  const works: FixWork[] = change.affectedAreas.map((area) => ({
    kind: "custom",
    field: area.name,
    // No `from`/`to`: the symbol keeps its name, and a rename with equal
    // operands would make `applyFixWork` a silent no-op if ever wired up.
    description:
      `${change.provider} ${versions} — overall: ${change.summary}. ` +
      `${area.type} '${area.name}': ${area.change}`,
    template: "",
    confidence: "medium",
  }));
  return { diff, works };
}

export async function runMigrate(opts: {
  repo: string;
  changePath: string;
  dryRun?: boolean;
  ai?: AIFixConfig;
}) {
  const change: ProviderChange = JSON.parse(readFileSync(opts.changePath, "utf8"));
  console.log(`[MIGRATE] ${change.provider} ${change.fromVersion} → ${change.toVersion}: ${change.summary}`);

  // 1. Resolve the working copy. Local paths are scanned in place.
  let localPath = opts.repo;
  if (isRemoteRef(opts.repo)) {
    const tmp = `/tmp/driftlock-migrate-${Date.now()}`;
    console.log(`[CLONE] ${opts.repo} → ${tmp}`);
    // Arguments are passed separately so a repo name cannot inject a shell
    // command or extra flags into git.
    execFileSync(
      "git",
      ["clone", "--depth", "1", `https://github.com/${opts.repo}.git`, tmp],
      { stdio: "inherit" },
    );
    localPath = tmp;
  } else {
    console.log(`[SCAN] local path ${localPath}`);
  }

  const allFiles = (await listRepoFiles(localPath)).filter(isScannable);

  // 2. Find every affected area. Searching only the first name meant a change
  // touching several symbols migrated one of them and reported success.
  const affectedNames: string[] = [];
  const affectedFiles = new Set<string>();
  const unreadable = new Map<string, string>();
  for (const area of change.affectedAreas) {
    const result = grep(localPath, allFiles, area.name);
    for (const u of result.unreadable) {
      if (!unreadable.has(u.file)) unreadable.set(u.file, u.reason);
    }
    if (result.hits.length === 0) {
      console.log(`[SCAN] ${area.name}: no match`);
      continue;
    }
    console.log(`[SCAN] ${area.name}: ${result.hits.length} file(s) — ${result.hits.slice(0, 3).join(" | ")}`);
    affectedNames.push(area.name);
    for (const file of result.hits) affectedFiles.add(file);
  }
  if (unreadable.size > 0) {
    const sample = [...unreadable].slice(0, 3).map(([f, r]) => `${f} (${r})`).join(", ");
    console.warn(
      `[SCAN] ${unreadable.size} file(s) unreadable, matches there may be missed: ${sample}`,
    );
  }
  if (affectedFiles.size === 0) {
    console.log("[SCAN] No affected files found — check affectedAreas names");
    return;
  }

  const files = [...affectedFiles];
  console.log(`[FILES] ${files.join(", ")}`);

  // 3. Build the context the fix generator consumes.
  const { diff, works } = buildFixContext(change);

  for (const file of files) {
    const fullPath = join(localPath, file);
    const source = readFileSync(fullPath, "utf8");
    console.log(`\n[AGENT] ${file} — ${change.provider} ${change.fromVersion}→${change.toVersion}: ${affectedNames.join(", ")}`);

    if (!opts.ai) {
      console.log("[AGENT] No AI config — dry-run would propose patch here");
      if (opts.dryRun) console.log(`[DRY-RUN] Would patch ${file}`);
      continue;
    }

    try {
      const { generateAIFix } = await import("@driftlock/aiFix");
      const result = await generateAIFix(
        { diff, works, sourceCode: source, filePath: file },
        opts.ai,
      );
      console.log(`[AI] confidence=${result.confidence} — ${result.explanation.slice(0, 80)}`);
      // Preview only. Nothing writes the file, runs the build, or opens a PR,
      // so the output says preview rather than implying a write happened.
      console.log(`[PREVIEW] ${file} — ${result.fixedCode.length} chars proposed, nothing written`);
      if (opts.dryRun) {
        console.log("[DRY-RUN] Fixed code preview:\n", result.fixedCode.slice(0, 300));
      }
    } catch (e) {
      console.error(`[AI] failed for ${file}:`, (e as Error).message);
    }
  }

  console.log(
    `[NOTE] Preview only: no file was modified, no build was run, and no pull request was opened.`,
  );
}
