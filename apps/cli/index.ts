import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import inquirer from "inquirer";
import { TypeScriptExtractor, detectLanguage } from "@driftlock/parser";
import { SandboxRunner } from "@driftlock/sandbox";
import {
    GitTracker,
    FixPRRunner,
    fixBranchName,
    buildFixPRTitle,
    buildFixPRBody,
} from "@driftlock/git";
import { analyzeAndCompare, applyDriftFix, buildDriftEvent } from "@driftlock/pipeline";
import type { CallSite, Fix } from "@driftlock/core";
import type { DriftResult } from "@driftlock/pipeline";
import { SnapshotStore } from "./drift";
import { harToConsumerContract } from "@driftlock/webhookCapture";
import { runMigrate } from "./migrate";

const program = new Command();

program
    .name("driftlock")
    .description("Self-maintaining APIs. Detect drift, generate fix PRs")
    .version("0.1.0")
    .addHelpText(
        "after",
        `
Examples:
  $ driftlock analyze ./src
  $ driftlock test ./repo --command "npm test"
  $ driftlock diff ./repo --base main
  $ driftlock fix ./repo --repo owner/repo --dry-run
  $ driftlock init
`,
    );

program
    .command("analyze")
    .description("Scan codebase for API call sites (Stripe, Twilio, etc.)")
    .argument("<path>", "Directory to scan for TypeScript/JavaScript files")
    .option("-o, --output <format>", "Output format (json, table)", "table")
    .addHelpText(
        "after",
        `
Scans your codebase using AST analysis to find all API call sites.
Detects any <client>.<resource>.<method> call on a configured SDK client
(Stripe, Twilio, and any vendor shipped as a VendorConfig).
Scans TypeScript (.ts/.tsx) and plain JavaScript (.js/.jsx/.mjs/.cjs).

Output formats:
  json   Machine-readable JSON with call sites and errors
  table  Human-readable table with file locations and endpoints
`,
    )
    .action(async (path: string, options: { output: string }) => {
        const spinner = ora("Analyzing codebase...").start();

try {
                const extractor = new TypeScriptExtractor();

                // Read all source files (TypeScript + plain JS)
                const files = readdirSync(path, { recursive: true })
                    .filter(
                        (file): file is string =>
                            typeof file === "string" &&
                            /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file),
                    );

                const allCallSites = [];
                const errors = [];

                for (const file of files) {
                    const filePath = join(path, file);
                    const content = readFileSync(filePath, "utf-8");
                const result = await extractor.extractFromFile(
                    filePath,
                    content,
                    detectLanguage(filePath),
                );
                allCallSites.push(...result.callSites);
                errors.push(...result.errors);
            }

            spinner.succeed(`Found ${allCallSites.length} API call sites`);

            if (options.output === "json") {
                console.log(
                    JSON.stringify(
                        { callSites: allCallSites, errors },
                        null,
                        2,
                    ),
                );
            } else {
                console.log(chalk.bold("\nAPI Call Sites:"));
                for (const site of allCallSites) {
                    console.log(
                        `  ${chalk.cyan(site.filePath)}:${chalk.yellow(site.line)}`,
                    );
                    console.log(
                        `    ${chalk.green(site.method)} → ${chalk.blue(
                            site.endpoint ?? "pending-capture",
                        )}`,
                    );
                    console.log(`    HTTP: ${site.httpMethod ?? "unknown"}`);
                    console.log("");
                }

                if (errors.length > 0) {
                    console.log(chalk.bold.red("\nErrors:"));
                    for (const error of errors) {
                        console.log(
                            `  ${chalk.red(error.file)}:${chalk.yellow(error.line)} - ${error.message}`,
                        );
                    }
                }
            }
        } catch (error) {
            spinner.fail("Analysis failed");
            console.error(error);
            process.exit(1);
        }
    });

program
    .command("test")
    .description("Run tests in isolated Docker sandbox with traffic capture")
    .argument("<path>", "Repository path to test")
    .option("-c, --command <cmd>", "Test command to run", "npm test")
    .option("-t, --timeout <ms>", "Timeout in milliseconds", "300000")
    .addHelpText(
        "after",
        `
Runs your test suite in an isolated Docker container with resource limits.
Captures HTTP traffic to detect which tests hit real APIs vs mocks.

The sandbox ensures:
  - Network isolation (only allowed endpoints)
  - Resource limits (CPU, memory)
  - Reproducible environments
`,
    )
    .action(
        async (path: string, options: { command: string; timeout: string }) => {
            const spinner = ora("Running tests in sandbox...").start();

            try {
                const runner = new SandboxRunner();
                const result = await runner.runTestSuite(path, {
                    image: "node:20-slim",
                    command: ["sh", "-c", options.command],
                    env: {},
                    timeout: parseInt(options.timeout, 10),
                    memoryLimit: "512m",
                    cpuLimit: 1.0,
                    networkEnabled: false,
                    allowedEndpoints: [],
                });

                if (result.exitCode === 0) {
                    spinner.succeed(`Tests passed (${result.duration}ms)`);
                } else {
                    spinner.fail(
                        `Tests failed with exit code ${result.exitCode}`,
                    );
                }

                console.log(chalk.bold("\nStdout:"));
                console.log(result.stdout);

                if (result.stderr) {
                    console.log(chalk.bold.red("\nStderr:"));
                    console.log(result.stderr);
                }

                console.log(chalk.bold("\nTraffic Captured:"));
                console.log(`  ${result.trafficCaptured.length} requests`);
            } catch (error) {
                spinner.fail("Sandbox test failed");
                console.error(error);
                process.exit(1);
            }
        },
    );

program
    .command("diff")
    .description("Compare API snapshots between branches or over time")
    .argument("<path>", "Repository path")
    .option("-b, --base <branch>", "Base branch to compare against")
    .addHelpText(
        "after",
        `
Detects file changes in your repository and identifies which
API call sites are affected by those changes.

Use this to understand the impact of a branch before merging.
`,
    )
    .action(async (path: string, options: { base?: string }) => {
        const spinner = ora("Comparing snapshots...").start();

        try {
            const tracker = new GitTracker(path);
            const changes = await tracker.detectChanges(options.base);

            spinner.succeed("Snapshot comparison complete");

            console.log(chalk.bold("\nChanges:"));
            console.log(
                `  ${chalk.green("+ Added:")} ${changes.added.length} files`,
            );
            console.log(
                `  ${chalk.yellow("~ Modified:")} ${changes.modified.length} files`,
            );
            console.log(
                `  ${chalk.red("- Deleted:")} ${changes.deleted.length} files`,
            );
            console.log(
                `  ${chalk.blue("→ Renamed:")} ${changes.renamed.length} files`,
            );

            if (changes.added.length > 0) {
                console.log(chalk.bold.green("\nAdded Files:"));
                for (const file of changes.added) {
                    console.log(`  + ${file}`);
                }
            }

            if (changes.modified.length > 0) {
                console.log(chalk.bold.yellow("\nModified Files:"));
                for (const file of changes.modified) {
                    console.log(`  ~ ${file}`);
                }
            }

            if (changes.deleted.length > 0) {
                console.log(chalk.bold.red("\nDeleted Files:"));
                for (const file of changes.deleted) {
                    console.log(`  - ${file}`);
                }
            }
        } catch (error) {
            spinner.fail("Diff comparison failed");
            console.error(error);
            process.exit(1);
        }
    });

program
    .command("fix")
    .description("Detect API drift and generate fix PRs")
    .argument("<path>", "Repository path")
    .option("-b, --base <branch>", "Base branch to compare", "main")
    .option("-r, --repo <repo>", "GitHub repo (owner/repo) for PR creation")
    .option("-c, --command <cmd>", "Test command to run for capture", "npm test")
    .option(
        "--forward <pattern>",
        "Forward a normally-intercepted endpoint, e.g. POST /v3/mail/send (repeatable)",
        (value: string, previous: string[]) => [...previous, value],
        [],
    )
    .option("--dry-run", "Show affected call sites without creating PRs")
    .addHelpText(
        "after",
        `
The core DriftLock loop:
  1. Scans for API call sites in your codebase
  2. Runs your test suite in a sandbox through a traffic-capture proxy
  3. First run establishes a baseline snapshot (.driftlock/snapshots)
  4. Later runs compare captured shapes against the baseline to detect drift
  5. Generates deterministic fixes (renames, null checks, coercions) and
     creates a PR with the fix (if --repo is provided)

Environment variables:
  GITHUB_TOKEN    Required for PR creation (not needed for --dry-run)

Examples:
  $ driftlock fix ./repo --dry-run
  $ driftlock fix ./repo --repo owner/repo
  $ driftlock fix ./repo --command "bun test"
`,
    )
    .action(
        async (
            repoPath: string,
            options: {
                base?: string;
                repo?: string;
                dryRun?: boolean;
                command?: string;
                forward?: string[];
            },
        ) => {
            const spinner = ora("Starting drift detection...").start();

            try {
                // Step 1-3: analyze, capture, compare against baseline
                const store = new SnapshotStore(repoPath);
                spinner.text = "Scanning for API call sites...";
                const result = await analyzeAndCompare({
                    repoPath,
                    command: options.command ?? "npm test",
                    forward: options.forward ?? [],
                    timeoutMs: 300000,
                    snapshotStore: store,
                });

                const allCallSites = result.callSites;
                const shapes = result.shapes;

                if (allCallSites.length === 0) {
                    spinner.warn("No API call sites found");
                    return;
                }

                spinner.text = `Captured traffic for ${shapes.size}/${allCallSites.length} call sites (${result.fills.size} endpoints inferred from traffic)`;

                const drifts = result.drifts;
                const baselines = result.baselines;
                spinner.text = `Comparing ${result.trafficCaptured} captured requests against baseline`;

                if (baselines.length > 0) {
                    console.log(chalk.bold("\nBaseline snapshots captured:"));
                    for (const cs of baselines) {
                        console.log(
                            `  ${chalk.cyan(cs.filePath)}:${chalk.yellow(cs.line)} (${chalk.green(cs.method)})`,
                        );
                    }
                    console.log(
                        chalk.dim(
                            "\nRe-run after the vendor API changes to detect drift.",
                        ),
                    );
                }

                if (drifts.length === 0) {
                    if (baselines.length === 0) {
                        spinner.succeed("No drift detected");
                    } else {
                        spinner.succeed(
                            "Baseline captured, no comparison yet",
                        );
                    }
                    return;
                }

                spinner.succeed(
                    `Detected drift at ${drifts.length} call site(s)`,
                );

                // Step 4: Apply deterministic fixes
                const fixes: Array<{
                    callSite: CallSite;
                    drift: DriftResult;
                    fix: Fix;
                }> = [];
                for (const drift of drifts) {
                    const file = join(
                        repoPath,
                        drift.callSite.filePath,
                    );
                    let content: string;
                    try {
                        content = readFileSync(file, "utf8");
                    } catch {
                        content = "";
                    }
                    const applied = applyDriftFix(drift, content);
                    if (!applied) {
                        console.log(
                            chalk.yellow(
                                `  ${drift.callSite.filePath}:${drift.callSite.line}: no static fix applicable`,
                            ),
                        );
                        continue;
                    }
                    fixes.push({
                        callSite: drift.callSite,
                        drift,
                        fix: applied.fix,
                    });
                    console.log(
                        chalk.bold(
                            `\n${chalk.cyan(drift.callSite.filePath)}:${chalk.yellow(drift.callSite.line)}`,
                        ),
                    );
                    console.log(
                        `  ${chalk.green(drift.callSite.method)} → ${chalk.blue(
                            drift.callSite.endpoint ?? "pending-capture",
                        )}`,
                    );
                    console.log(
                        `  ${chalk.yellow("Fix:")} ${applied.fix.description}`,
                    );
                    console.log(
                        `  ${chalk.dim(applied.fix.diff)}`,
                    );
                }

                if (fixes.length === 0) {
                    spinner.succeed("No statically applicable fixes");
                    return;
                }

                // Step 5: Create PR (if not dry run and repo is provided)
                if (options.dryRun) {
                    console.log(
                        chalk.yellow(
                            "\nDry run, skipping PR creation. Remove --dry-run to create PRs.",
                        ),
                    );
                    return;
                }

                if (!options.repo) {
                    console.log(
                        chalk.yellow(
                            "\nNo --repo specified. Skipping PR creation. Use --repo owner/repo to create PRs.",
                        ),
                    );
                    return;
                }

                const [owner, repo] = options.repo.split("/");
                if (!owner || !repo) {
                    console.error(
                        chalk.red("Invalid --repo format. Use owner/repo."),
                    );
                    process.exit(1);
                }

                const githubToken = process.env.GITHUB_TOKEN;
                if (!githubToken) {
                    console.error(
                        chalk.red(
                            "GITHUB_TOKEN environment variable is required for PR creation.",
                        ),
                    );
                    process.exit(1);
                }

                const prSpinner = ora("Creating PR...").start();
                const prRunner = new FixPRRunner(githubToken);

                for (const { callSite, drift, fix } of fixes) {
                    const driftEvent = buildDriftEvent(drift);
                    driftEvent.suggestedFix = fix;
                    driftEvent.status = "fix_generated";

                    const result = await prRunner.run({
                        owner,
                        repo,
                        base: options.base ?? "main",
                        branch: fixBranchName(callSite.id),
                        title: buildFixPRTitle({
                            driftEvent,
                            callSite,
                            fix,
                        }),
                        body: buildFixPRBody({ driftEvent, callSite, fix }, fix.files),
                        commitMessage: `driftlock: apply fix for ${callSite.method}`,
                        files: fix.files.map((f) => ({
                            path: f.path,
                            content: f.changes,
                        })),
                    });

                    if (result.status === "merged") {
                        const current = shapes.get(callSite.id);
                        if (current) {
                            await store.save(callSite.id, current);
                        }
                        prSpinner.succeed(
                            `Fix already merged (${result.url}); baseline refreshed`,
                        );
                        continue;
                    }
                    if (result.status === "already_open") {
                        prSpinner.succeed(`PR already open: ${result.url}`);
                        continue;
                    }
                    prSpinner.succeed(`PR created: ${result.url}`);
                }
            } catch (error) {
                spinner.fail("Fix generation failed");
                console.error(error);
                process.exit(1);
            }
        },
    );

program
    .command("init")
    .description("Initialize DriftLock configuration in current directory")
    .addHelpText(
        "after",
        `
Creates a .driftlock.yml configuration file with:
  - Test command (default: npm test)
  - HTTPS proxy settings for traffic capture
  - Sandbox configuration (Docker image, resource limits)

Environment variables:
  OPENAI_API_KEY   Required for AI-powered fix generation
`,
    )
    .action(async () => {
        const spinner = ora("Initializing DriftLock...").start();

        try {
            const answers = await inquirer.prompt([
                {
                    type: "input",
                    name: "testCommand",
                    message: "Test command:",
                    default: "npm test",
                },
                {
                    type: "confirm",
                    name: "enableProxy",
                    message: "Enable HTTPS proxy for traffic capture?",
                    default: true,
                },
            ]);

            // Create .driftlock.yml
            const config = `
# Supply credentials through the OPENAI_API_KEY environment variable, never this file.
testCommand: ${answers.testCommand}
enableProxy: ${answers.enableProxy}
sandbox:
  image: node:20-slim
  memoryLimit: 512m
  cpuLimit: 1.0
  timeout: 300000
`.trimStart();

            writeFileSync(".driftlock.yml", config);

            spinner.succeed("DriftLock initialized");
            console.log(chalk.green("Created .driftlock.yml"));
        } catch (error) {
            spinner.fail("Initialization failed");
            console.error(error);
            process.exit(1);
        }
    });

program
    .command("capture")
    .description("Turn HAR traffic into a consumer contract (SpecShield bdct capture from-har)")
    .option("--har <path>", "Input HAR file (HAR 1.2)")
    .option("--base-url <url>", "Keep only entries matching URL prefix")
    .option("--out <path>", "Output file (yaml/json), defaults to stdout")
    .action(async (opts: { har: string; baseUrl?: string; out?: string }) => {
        if (!opts.har) {
            console.error(chalk.red("Missing --har <path>"));
            process.exit(1);
        }
        const spinner = ora("Capturing HAR…").start();
        try {
            const har = JSON.parse(readFileSync(opts.har, "utf8"));
            const result = harToConsumerContract(har, { baseUrl: opts.baseUrl });
            const out = JSON.stringify(result, null, 2);
            if (opts.out) {
                writeFileSync(opts.out, out);
                spinner.succeed(`Wrote consumer contract ${result.stats.kept}/${result.stats.total} entries → ${opts.out}`);
            } else {
                spinner.stop();
                console.log(out);
            }
        } catch (e) {
            spinner.fail("Capture failed");
            console.error(e);
            process.exit(1);
        }
    });

program
    .command("migrate")
    .description("Migrate a repo via ProviderChange (p5 1.11→2.3 wedge)")
    .requiredOption("--repo <owner/repo>", "GitHub repo (owner/repo) or local path")
    .requiredOption("--change <path>", "ProviderChange JSON file")
    .option("--dry-run", "Don't push, just show patch")
    .action(async (opts: { repo: string; change: string; dryRun?: boolean }) => {
        const ai = process.env.CLOUDFLARE_API_TOKEN
            ? { provider: "cloudflare" as const, apiKey: process.env.CLOUDFLARE_API_TOKEN, accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "" }
            : process.env.AI_API_KEY
              ? { provider: "openai" as const, apiKey: process.env.AI_API_KEY }
              : undefined;
        await runMigrate({ repo: opts.repo, changePath: opts.change, dryRun: opts.dryRun, ai });
    });

program.parse();
