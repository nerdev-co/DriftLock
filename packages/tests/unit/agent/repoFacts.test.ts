import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    deriveVerificationCommands,
    describeRepoFacts,
    extensionOf,
    fingerprintRepo,
    isAllowedCommand,
    listRepoFiles,
    searchCode,
    versionOf,
} from "@driftlock/agent";
import type { RepoFacts } from "@driftlock/agent";

let root: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "driftlock-facts-"));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

async function writeJson(path: string, value: unknown): Promise<void> {
    const full = join(root, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, JSON.stringify(value, null, 2));
}

async function write(path: string, value: string): Promise<void> {
    const full = join(root, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, value);
}

describe("fingerprintRepo, npm", () => {
    test("reads scripts, declared ranges, and lockfile-resolved versions", async () => {
        await writeJson("package.json", {
            scripts: { test: "vitest run", typecheck: "tsc --noEmit", lint: "eslint ." },
            dependencies: { p5: "^1.11.0" },
            devDependencies: { typescript: "^5.3.0" },
        });
        await writeJson("package-lock.json", {
            lockfileVersion: 3,
            packages: {
                "": { name: "fixture" },
                "node_modules/p5": { version: "1.11.13" },
                "node_modules/typescript": { version: "5.3.3" },
            },
        });

        const facts = await fingerprintRepo(root);

        expect(facts.ecosystem).toBe("npm");
        expect(facts.packageManager).toBe("npm");
        expect(facts.scripts.typecheck).toBe("tsc --noEmit");
        expect(facts.dependencies.p5).toBe("^1.11.0");
        expect(facts.resolvedVersions.p5).toBe("1.11.13");
        expect(facts.verificationCommands).toEqual([
            "npm run typecheck",
            "npm test",
            "npm run lint",
        ]);
    });

    test("trusts the lockfile over the declared range", async () => {
        await writeJson("package.json", { dependencies: { p5: "^2.0.0" } });
        await writeJson("package-lock.json", {
            packages: { "node_modules/p5": { version: "1.11.13" } },
        });

        const facts = await fingerprintRepo(root);
        expect(versionOf(facts, "p5")).toBe("1.11.13");
    });

    test("derives nothing when the project has no verification scripts", async () => {
        await writeJson("package.json", { scripts: { dev: "vite" } });
        const facts = await fingerprintRepo(root);
        expect(facts.verificationCommands).toEqual([]);
        expect(describeRepoFacts(facts)).toContain("no verification command");
    });

    test("detects pnpm from the lockfile", async () => {
        await writeJson("package.json", { scripts: { test: "vitest" } });
        await write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");

        const facts = await fingerprintRepo(root);
        expect(facts.packageManager).toBe("pnpm");
        expect(facts.verificationCommands).toContain("pnpm test");
    });

    test("prefers an explicit packageManager field", async () => {
        await writeJson("package.json", {
            packageManager: "bun@1.3.11",
            scripts: { test: "bun test" },
        });

        const facts = await fingerprintRepo(root);
        expect(facts.packageManager).toBe("bun");
        expect(facts.verificationCommands).toContain("bun test");
    });

    test("still identifies npm when the manifest is unparseable", async () => {
        await write("package.json", "{ not json");

        const facts = await fingerprintRepo(root);
        expect(facts.warnings).toContain("package.json is not valid JSON");

        // The file is still a package.json, so the repository is still npm. The
        // old behaviour reported `unknown` here, which was simply false, and hid
        // the fact that only the manifest contents were lost.
        expect(facts.ecosystem).toBe("npm");
        expect(facts.ecosystemSupport).toBe("detected");
        expect(facts.verificationCommands).toEqual([]);
        expect(describeRepoFacts(facts)).toContain("cannot parse its manifest");
    });

    test("falls back to declared ranges when the lockfile is unreadable", async () => {
        await writeJson("package.json", { dependencies: { p5: "^1.11.0" } });
        await write("package-lock.json", "corrupt");

        const facts = await fingerprintRepo(root);
        expect(facts.warnings.length).toBe(1);
        expect(versionOf(facts, "p5")).toBe("^1.11.0");
    });

    test("reads the node version from .nvmrc", async () => {
        await writeJson("package.json", { scripts: { test: "vitest" } });
        await write(".nvmrc", "20.11.0\n");

        const facts = await fingerprintRepo(root);
        expect(facts.runtime).toEqual({ name: "node", version: "20.11.0" });
    });

    test("detects frameworks including non-web ones", async () => {
        await writeJson("package.json", { dependencies: { p5: "1.11.13", three: "^0.160" } });
        const facts = await fingerprintRepo(root);
        expect(facts.frameworks).toContain("p5");
        expect(facts.frameworks).toContain("three");
    });
});

describe("fingerprintRepo, CI", () => {
    test("reads verification commands out of a GitHub workflow", async () => {
        await writeJson("package.json", { scripts: { test: "vitest" } });
        await write(
            ".github/workflows/ci.yml",
            [
                "name: CI",
                "on: [push]",
                "jobs:",
                "  test:",
                "    steps:",
                "      - uses: actions/checkout@v4",
                "      - run: npm ci",
                "      - run: npm test",
                "      - run: npm run typecheck",
                "      - run: npm run build",
                "      - run: |",
                "          echo multi",
            ].join("\n"),
        );

        const facts = await fingerprintRepo(root);
        const ci = facts.ci[0];
        expect(ci.file).toBe(".github/workflows/ci.yml");
        expect(ci.commands).toEqual(["npm test", "npm run typecheck", "npm run build"]);
    });

    test("never turns a CI command into a runnable verification command", async () => {
        // CI runs a typecheck the manifest does not define, which is a real
        // repository shape and also the most dangerous thing to copy blindly:
        // the command looks right but `npm run typecheck` would exit 1 here.
        await writeJson("package.json", { scripts: { test: "vitest" } });
        await write(
            ".github/workflows/ci.yml",
            ["jobs:", "  test:", "    steps:", "      - run: npm run typecheck"].join("\n"),
        );

        const facts = await fingerprintRepo(root);
        expect(facts.ci[0].commands).toEqual(["npm run typecheck"]);
        expect(facts.verificationCommands).toEqual(["npm test"]);
        expect(facts.verificationCommands).not.toContain("npm run typecheck");
    });

    test("ignores install steps and block scalars", async () => {
        await writeJson("package.json", { scripts: { test: "vitest" } });
        await write(
            ".github/workflows/ci.yml",
            [
                "jobs:",
                "  test:",
                "    steps:",
                "      - run: npm ci",
                "      - run: npm test",
                "      - run: |",
                "          npm test -- --coverage",
            ].join("\n"),
        );

        const facts = await fingerprintRepo(root);
        expect(facts.ci[0].commands).toEqual(["npm test"]);
    });
});

describe("fingerprintRepo, cargo", () => {
    test("reads Cargo.toml dependencies and Cargo.lock versions", async () => {
        await write(
            "Cargo.toml",
            [
                "[package]",
                "name = \"fixture\"",
                "version = \"0.1.0\"",
                "",
                "[dependencies]",
                "serde = \"1.0\"",
                "tokio = { version = \"1.35\", features = [\"full\"] }",
                "",
                "[dev-dependencies]",
                "criterion = \"0.5\"",
            ].join("\n"),
        );
        await write(
            "Cargo.lock",
            [
                "[[package]]",
                "name = \"serde\"",
                "version = \"1.0.195\"",
                "",
                "[[package]]",
                "name = \"tokio\"",
                "version = \"1.35.1\"",
            ].join("\n"),
        );

        const facts = await fingerprintRepo(root);

        expect(facts.ecosystem).toBe("rust");
        expect(facts.packageManager).toBe("cargo");
        expect(facts.dependencies.serde).toBe("1.0");
        expect(facts.dependencies.tokio).toBe("1.35");
        expect(facts.dependencies.criterion).toBe("0.5");
        expect(facts.resolvedVersions.serde).toBe("1.0.195");
        // Cargo commands are on the executor allowlist, so they survive the
        // filter and stay both runnable and suggested.
        expect(facts.verificationCommands).toEqual([
            "cargo check",
            "cargo build",
            "cargo test",
        ]);
    });
});

describe("fingerprintRepo, python and go", () => {
    test("reads pinned requirements", async () => {
        await write("requirements.txt", ["flask==3.0.0", "# comment", "numpy>=1.26"].join("\n"));
        await write(".python-version", "3.12.1\n");

        const facts = await fingerprintRepo(root);
        expect(facts.ecosystem).toBe("python");
        expect(facts.dependencies.flask).toBe("3.0.0");
        expect(facts.dependencies.numpy).toBeUndefined();
        expect(facts.runtime).toEqual({ name: "python", version: "3.12.1" });
    });

    test("reads go.mod requirements", async () => {
        await write(
            "go.mod",
            ["module example.com/app", "", "go 1.22", "", "require (", "\tgithub.com/gin-gonic/gin v1.9.1", ")"].join(
                "\n",
            ),
        );

        const facts = await fingerprintRepo(root);
        expect(facts.ecosystem).toBe("go");
        expect(facts.dependencies["github.com/gin-gonic/gin"]).toBe("v1.9.1");
        // Same allowlist filtering as cargo above: the go commands are on the
        // allowlist, so they are suggested and `runCommand` will accept them.
        expect(facts.verificationCommands).toEqual([
            "go build ./...",
            "go test ./...",
        ]);
    });
});

describe("ecosystem detection is open, not a closed union", () => {
    test("recognises elixir rather than reporting unknown", async () => {
        await write("mix.exs", "defmodule App.MixProject do\nend\n");
        await write("lib/app.ex", "defmodule App do\nend\n");

        const facts = await fingerprintRepo(root);

        expect(facts.ecosystem).toBe("elixir");
        expect(facts.ecosystemSupport).toBe("detected");
        expect(facts.packageManager).toBe("mix");
        expect(facts.manifests).toContain("mix.exs");
        expect(facts.sourceFiles).toContain("lib/app.ex");
        expect(describeRepoFacts(facts)).toContain("cannot parse its manifest");
    });

    test("recognises ruby, php, java, dart, and dotnet from markers alone", async () => {
        const cases: readonly [string, string, string][] = [
            ["Gemfile", "app.rb", "ruby"],
            ["composer.json", "app.php", "php"],
            ["pom.xml", "App.java", "java"],
            ["pubspec.yaml", "lib/main.dart", "dart"],
            ["App.csproj", "Program.cs", "dotnet"],
        ];

        for (const [manifest, source, ecosystem] of cases) {
            // A fresh root per case, otherwise the previous case's marker file
            // is still on disk and detection correctly reports whichever comes
            // first in the marker table.
            const dir = await mkdtemp(join(tmpdir(), `driftlock-${ecosystem}-`));
            await writeFile(join(dir, manifest), "{}\n");
            await mkdir(join(dir, "lib"), { recursive: true });
            await writeFile(join(dir, source), "// fixture\n");

            const facts = await fingerprintRepo(dir);
            expect(facts.ecosystem).toBe(ecosystem);
            expect(facts.ecosystemSupport).toBe("detected");
            expect(facts.sourceFiles).toContain(source);

            await rm(dir, { recursive: true, force: true });
        }
    });

    test("names the marker file that actually identified the ecosystem", async () => {
        // Regression: the warning credited the first manifest alphabetically,
        // so an elixir repository with a Gemfile alongside it was told its
        // marker was Gemfile, which points at the wrong file entirely.
        await write("mix.exs", "defmodule App do\nend\n");
        await write("Gemfile", "gem \"rails\"\n");

        const facts = await fingerprintRepo(root);
        const warning = facts.warnings.find((entry) => entry.includes("elixir")) ?? "";

        expect(facts.ecosystem).toBe("elixir");
        expect(warning).toContain("mix.exs");
        expect(warning).not.toContain("Gemfile");
    });

    test("uses a correct article before the ecosystem name", async () => {
        await write("mix.exs", "defmodule App do\nend\n");
        expect(describeRepoFacts(await fingerprintRepo(root))).toContain(
            "is an elixir project",
        );

        await write("Cargo.toml", "[package]\nname = \"x\"\n");
        expect(describeRepoFacts(await fingerprintRepo(root))).toContain("is a rust project");
    });

    test("never guesses a package manager that is not a runnable command", async () => {
        await write("Cargo.toml", "[package]\nname = \"x\"\n");
        const facts = await fingerprintRepo(root);
        // A manifest we cannot parse must not be reported as a command to run.
        expect(facts.packageManager).not.toBe("rust");
    });

    test("reports a polyglot repository rather than picking one silently", async () => {
        await write("package.json", JSON.stringify({ scripts: { test: "vitest" } }));
        await write("mix.exs", "defmodule App do\nend\n");

        const facts = await fingerprintRepo(root);
        expect(facts.ecosystem).toBe("npm");
        expect(facts.alsoDetected).toContain("elixir");
        expect(describeRepoFacts(facts)).toContain("polyglot or monorepo");
    });

    test("reports unknown honestly when there is no marker at all", async () => {
        await write("notes.txt", "hello\n");
        const facts = await fingerprintRepo(root);
        expect(facts.ecosystem).toBe("unknown");
        expect(facts.ecosystemSupport).toBe("none");
        expect(facts.packageManager).toBe("unknown");
    });
});

describe("listRepoFiles is the single walk", () => {
    test("prunes ignored directories rather than descending into them", async () => {
        await write("src/app.ts", "export const a = 1;\n");
        await write("node_modules/pkg/index.js", "module.exports = {};\n");
        await write("dist/bundle.js", "compiled\n");
        await write("target/debug/main.rs", "fn main() {}\n");

        const files = await listRepoFiles(root);

        expect(files).toContain("src/app.ts");
        expect(files.some((file) => file.startsWith("node_modules/"))).toBe(false);
        expect(files.some((file) => file.startsWith("dist/"))).toBe(false);
        expect(files.some((file) => file.startsWith("target/"))).toBe(false);
    });

    test("keeps nested paths relative to the root", async () => {
        await write("a/b/c/deep.ts", "export const d = 1;\n");
        const files = await listRepoFiles(root);
        expect(files).toContain("a/b/c/deep.ts");
    });

    test("refuses a root that is itself inside an ignored tree", async () => {
        const nested = await mkdtemp(join(tmpdir(), "driftlock-nested-"));
        await mkdir(join(nested, "node_modules", "pkg"), { recursive: true });
        await writeFile(join(nested, "node_modules", "pkg", "index.js"), "x\n");

        // The ignored-tree check runs on the search scope relative to the
        // repository root (what searchCode passes as `path`), never on
        // segments of the absolute root path.
        expect(await listRepoFiles(join(nested, "node_modules"), { scope: "node_modules" })).toEqual([]);
        expect(
            await listRepoFiles(join(nested, "node_modules", "pkg"), {
                scope: "node_modules/pkg",
            }),
        ).toEqual([]);

        await rm(nested, { recursive: true, force: true });
    });

    test("searchCode and the fingerprint agree on what the repository contains", async () => {
        await write("package.json", JSON.stringify({ scripts: { test: "vitest" } }));
        await write("src/client.ts", "const stripe = 1;\n");

        const facts = await fingerprintRepo(root);
        const searched = await searchCode(root, "stripe");

        expect(searched.ok).toBe(true);
        expect(searched.output).toContain("src/client.ts");
        expect(facts.sourceFiles).toContain("src/client.ts");
    });
});

describe("extensionOf", () => {
    test("reads the real extension and ignores dotfiles", () => {
        expect(extensionOf("src/app.ts")).toBe(".ts");
        expect(extensionOf("src/app.TSX")).toBe(".tsx");
        expect(extensionOf("Dockerfile.prod")).toBe(".prod");
        expect(extensionOf(".nvmrc")).toBe("");
        expect(extensionOf("Makefile")).toBe("");
    });
});

describe("describeRepoFacts", () => {
    test("names the installed version, not just the declared range", async () => {
        await writeJson("package.json", {
            scripts: { test: "vitest", build: "vite build" },
            dependencies: { p5: "^1.11.0" },
        });
        await writeJson("package-lock.json", {
            packages: { "node_modules/p5": { version: "1.11.13" } },
        });

        const description = describeRepoFacts(await fingerprintRepo(root));

        expect(description).toContain("npm project using npm");
        expect(description).toContain("p5@1.11.13");
        expect(description).toContain("npm test");
        expect(description).toContain("npm run build");
    });

    test("reports the manifest pin when there is no lockfile", async () => {
        // Regression: reading only resolvedVersions dropped the version entirely
        // for a repository with no lockfile, which is exactly the shape of the
        // p5 repository that produced the failed run.
        await writeJson("package.json", {
            scripts: { dev: "vite", build: "vite build" },
            dependencies: { p5: "1.11.13" },
        });

        const description = describeRepoFacts(await fingerprintRepo(root));

        expect(description).toContain("p5@1.11.13");
    });

    test("prefers the lockfile version over the declared range", async () => {
        await writeJson("package.json", { dependencies: { p5: "^1.11.0" } });
        await writeJson("package-lock.json", {
            packages: { "node_modules/p5": { version: "1.11.13" } },
        });

        const description = describeRepoFacts(await fingerprintRepo(root));
        expect(description).toContain("p5@1.11.13");
        expect(description).not.toContain("p5@^1.11.0");
    });

    test("says plainly when there is nothing to verify with", async () => {
        await writeJson("package.json", { scripts: { dev: "vite" } });
        const description = describeRepoFacts(await fingerprintRepo(root));
        expect(description).toContain("no verification command");
        expect(description).not.toContain("npm test");
    });
});

describe("deriveVerificationCommands", () => {
    test("orders typecheck ahead of test ahead of build", async () => {
        await writeJson("package.json", {
            scripts: { build: "vite build", test: "vitest", typecheck: "tsc" },
        });
        const facts = await fingerprintRepo(root);
        expect(deriveVerificationCommands(facts)).toEqual([
            "npm run typecheck",
            "npm test",
            "npm run build",
        ]);
    });

    test("produces an empty list rather than a guess", async () => {
        const facts = await fingerprintRepo(root);
        expect(deriveVerificationCommands(facts)).toEqual([]);
    });

    // The suggested commands are filtered through the same allowlist the
    // executor enforces. A non-JS ecosystem absent from that allowlist does not
    // fail loudly: it simply verifies nothing, and the migration looks clean.
    test("every ecosystem's derived commands are ones the executor can run", () => {
        const byEcosystem = [
            { ecosystem: "rust", packageManager: "cargo", scripts: { check: "cargo check", build: "cargo build", test: "cargo test" } },
            { ecosystem: "go", packageManager: "go", scripts: { build: "go build ./...", test: "go test ./..." } },
        ] as unknown as RepoFacts[];

        for (const facts of byEcosystem) {
            const commands = deriveVerificationCommands(facts);
            expect(commands.length).toBeGreaterThan(0);
            for (const command of commands) {
                expect(isAllowedCommand(command)).toBe(true);
            }
        }
    });

    test("still refuses a command no ecosystem declares", () => {
        const facts = {
            ecosystem: "rust",
            packageManager: "cargo",
            scripts: { test: "cargo publish --dry-run" },
        } as unknown as RepoFacts;
        expect(deriveVerificationCommands(facts)).toEqual([]);
        expect(isAllowedCommand("npm run validate")).toBe(false);
    });
});
