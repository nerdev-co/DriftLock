import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    allowedCommands,
    buildSandboxEnv,
    editFile,
    inspectRepo,
    isAllowedCommand,
    patchTargets,
    readFile,
    replaceInFile,
    resolveInsideRoot,
    runCommand,
    searchCode,
} from "@driftlock/agent";

let root: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "driftlock-agent-"));
    await writeFile(
        join(root, "package.json"),
        JSON.stringify(
            {
                name: "fixture",
                dependencies: { stripe: "^8.0.0" },
                devDependencies: { typescript: "^5.3.0" },
                scripts: {
                    build: "node -e \"process.exit(0)\"",
                    typecheck: "node -e \"process.exit(1)\"",
                },
            },
            null,
            2,
        ),
    );
    await writeFile(
        join(root, "package-lock.json"),
        JSON.stringify({ lockfileVersion: 3 }),
    );
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
        join(root, "src/client.ts"),
        "export const id = response.legacy_id;\n",
    );
    await writeFile(join(root, ".env"), "SECRET=should-not-be-readable\n");
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe("resolveInsideRoot", () => {
    test("resolves a normal relative path", () => {
        expect(resolveInsideRoot("/tmp/repo", "src/client.ts")).toBe(
            "/tmp/repo/src/client.ts",
        );
    });

    test("normalizes redundant segments", () => {
        expect(resolveInsideRoot("/tmp/repo", "./src//client.ts")).toBe(
            "/tmp/repo/src/client.ts",
        );
    });

    test("rejects absolute paths", () => {
        expect(resolveInsideRoot("/tmp/repo", "/etc/passwd")).toBeNull();
    });

    test("rejects home expansion", () => {
        expect(resolveInsideRoot("/tmp/repo", "~/.ssh/id_rsa")).toBeNull();
    });

    test("rejects traversal", () => {
        expect(resolveInsideRoot("/tmp/repo", "../outside.ts")).toBeNull();
        expect(resolveInsideRoot("/tmp/repo", "src/../../outside.ts")).toBeNull();
    });

    test("rejects dotenv files", () => {
        expect(resolveInsideRoot("/tmp/repo", ".env")).toBeNull();
        expect(resolveInsideRoot("/tmp/repo", "config/.env.production")).toBeNull();
    });

    test("rejects keys and certificates", () => {
        expect(resolveInsideRoot("/tmp/repo", "certs/server.pem")).toBeNull();
        expect(resolveInsideRoot("/tmp/repo", "id_rsa")).toBeNull();
    });

    test("rejects git config", () => {
        expect(resolveInsideRoot("/tmp/repo", ".git/config")).toBeNull();
    });

    test("rejects an empty path", () => {
        expect(resolveInsideRoot("/tmp/repo", "./")).toBeNull();
    });
});

describe("readFile", () => {
    test("returns numbered content", async () => {
        const result = await readFile(root, "src/client.ts");
        expect(result.ok).toBe(true);
        expect(result.output).toContain("1 | export const id");
    });

    test("refuses protected paths", async () => {
        const result = await readFile(root, ".env");
        expect(result.ok).toBe(false);
        expect(result.output).not.toContain("SECRET");
    });

    test("reports missing files", async () => {
        const result = await readFile(root, "src/nope.ts");
        expect(result.ok).toBe(false);
        expect(result.output).toContain("File not found");
    });
});

describe("searchCode", () => {
    test("finds matches with line numbers", async () => {
        const result = await searchCode(root, "legacy_id");
        expect(result.ok).toBe(true);
        expect(result.output).toContain("src/client.ts:1");
    });

    test("reports no matches", async () => {
        const result = await searchCode(root, "not_present_anywhere");
        expect(result.ok).toBe(true);
        expect(result.output).toContain("No matches");
    });

    test("rejects an empty query", async () => {
        const result = await searchCode(root, "   ");
        expect(result.ok).toBe(false);
    });

    test("scopes the search to a subdirectory", async () => {
        await mkdir(join(root, "other"), { recursive: true });
        await writeFile(join(root, "other/legacy.ts"), "legacy_id\n");
        const result = await searchCode(root, "legacy_id", "other");
        expect(result.ok).toBe(true);
        expect(result.output).toContain("other/legacy.ts:1");
        expect(result.output).not.toContain("src/client.ts");
    });

    test("rejects traversal in the scope path", async () => {
        const result = await searchCode(root, "legacy_id", "..");
        expect(result.ok).toBe(false);
    });

    test("reports a missing scope path clearly", async () => {
        const result = await searchCode(root, "legacy_id", "nope");
        expect(result.ok).toBe(false);
        expect(result.output).toContain("Search path not found");
    });

    test("refuses a file as a scope path", async () => {
        const result = await searchCode(root, "legacy_id", "src/client.ts");
        expect(result.ok).toBe(false);
        expect(result.output).toContain("not a directory");
    });
});

describe("inspectRepo", () => {
    test("reports package manager, lockfile, and source files", async () => {
        const result = await inspectRepo(root);
        expect(result.ok).toBe(true);
        const payload = JSON.parse(result.output) as {
            packageManager: string;
            lockfiles: string[];
            dependencies: string[];
            sourceFiles: string[];
        };
        expect(payload.packageManager).toBe("npm");
        expect(payload.lockfiles).toContain("package-lock.json");
        expect(payload.dependencies).toContain("stripe");
        expect(payload.sourceFiles).toContain("src/client.ts");
    });

    test("never lists dotenv files", async () => {
        const result = await inspectRepo(root);
        expect(result.output).not.toContain(".env");
    });
});

describe("editFile", () => {
    test("applies a valid unified diff", async () => {
        const proc = Bun.spawn(["git", "init"], { cwd: root, stdout: "pipe" });
        await proc.exited;
        const patch = [
            "--- a/src/client.ts",
            "+++ b/src/client.ts",
            "@@ -1 +1 @@",
            "-export const id = response.legacy_id;",
            "+export const id = response.id;",
        ].join("\n");

        const result = await editFile(root, "src/client.ts", patch);
        expect(result.ok).toBe(true);
        const updated = await Bun.file(join(root, "src/client.ts")).text();
        expect(updated).toContain("response.id");
    });

    test("applies a diff with bare repo-relative paths", async () => {
        const proc = Bun.spawn(["git", "init"], { cwd: root, stdout: "pipe" });
        await proc.exited;
        const patch = [
            "--- src/client.ts",
            "+++ src/client.ts",
            "@@ -1 +1 @@",
            "-export const id = response.legacy_id;",
            "+export const id = response.id;",
        ].join("\n");

        const result = await editFile(root, "src/client.ts", patch);
        expect(result.ok).toBe(true);
        const updated = await Bun.file(join(root, "src/client.ts")).text();
        expect(updated).toContain("response.id");
    });

    test("applies a diff whose hunk line count is wrong", async () => {
        const proc = Bun.spawn(["git", "init"], { cwd: root, stdout: "pipe" });
        await proc.exited;
        const patch = [
            "--- src/client.ts",
            "+++ src/client.ts",
            "@@ -1,1 +1,1 @@",
            " export const id = response.legacy_id;",
            "+export const name = response.name;",
        ].join("\n");

        const result = await editFile(root, "src/client.ts", patch);
        expect(result.ok).toBe(true);
        const updated = await Bun.file(join(root, "src/client.ts")).text();
        expect(updated).toContain("response.name");
        expect(updated).toContain("response.legacy_id");
    });

    test("applies an a/ and b/ prefixed diff", async () => {
        const proc = Bun.spawn(["git", "init"], { cwd: root, stdout: "pipe" });
        await proc.exited;
        const patch = [
            "--- a/src/client.ts",
            "+++ b/src/client.ts",
            "@@ -1,1 +1,1 @@",
            "-export const id = response.legacy_id;",
            "+export const id = response.id;",
        ].join("\n");

        const result = await editFile(root, "src/client.ts", patch);
        expect(result.ok).toBe(true);
        const updated = await Bun.file(join(root, "src/client.ts")).text();
        expect(updated).toContain("response.id");
    });

    test("applies a patch that already ends with a newline", async () => {
        const proc = Bun.spawn(["git", "init"], { cwd: root, stdout: "pipe" });
        await proc.exited;
        await writeFile(
            join(root, "payment.js"),
            [
                "async function createPayment(amount, currency) {",
                "  const paymentIntent = {",
                "    amount,",
                "    currency,",
                "  };",
                "",
                "  return {",
                "    id: paymentIntent.id,",
                "    amount: paymentIntent.amount,",
                "    currency: paymentIntent.currency,",
                "    status: paymentIntent.status,",
                "    source: paymentIntent.source,",
                "    client_secret: paymentIntent.client_secret,",
                "  };",
                "}",
                "",
            ].join("\n"),
        );
        const patch = [
            "--- payment.js",
            "+++ payment.js",
            "@@ -15,7 +15,7 @@",
            "     status: paymentIntent.status,",
            "-    source: paymentIntent.source,",
            "+    payment_method: paymentIntent.payment_method,",
            "     client_secret: paymentIntent.client_secret,",
            "",
        ].join("\n");

        const result = await editFile(root, "payment.js", patch);
        expect(result.ok).toBe(true);
        const updated = await Bun.file(join(root, "payment.js")).text();
        expect(updated).toContain("payment_method: paymentIntent.payment_method");
        expect(updated).toContain("client_secret: paymentIntent.client_secret");
        expect(updated.endsWith("}\n")).toBe(true);
    });

    test("reports the real git error, not a misleading missing-file error", async () => {
        const proc = Bun.spawn(["git", "init"], { cwd: root, stdout: "pipe" });
        await proc.exited;
        const patch = [
            "--- src/client.ts",
            "+++ src/client.ts",
            "@@ -1,7 +1,7 @@",
            " export const id = response.legacy_id;",
            "-export const legacy = true;",
            "+export const migrated = true;",
        ].join("\n");

        const result = await editFile(root, "src/client.ts", patch);
        expect(result.ok).toBe(false);
        expect(result.output).not.toContain("No such file or directory");
    });

    test("rejects a patch without hunk headers", async () => {
        const result = await editFile(root, "src/client.ts", "just write this file");
        expect(result.ok).toBe(false);
        expect(result.output).toContain("@@");
    });

    test("rejects a patch without file headers", async () => {
        const result = await editFile(
            root,
            "src/client.ts",
            "@@ -1 +1 @@\n-a\n+b",
        );
        expect(result.ok).toBe(false);
        expect(result.output).toContain("headers");
    });

    test("refuses protected paths", async () => {
        const result = await editFile(
            root,
            ".env",
            "--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-A\n+B",
        );
        expect(result.ok).toBe(false);
    });

    test("refuses a patch that targets a different file", async () => {
        const proc = Bun.spawn(["git", "init"], { cwd: root, stdout: "pipe" });
        await proc.exited;
        const result = await editFile(
            root,
            "src/client.ts",
            [
                "--- a/src/other.ts",
                "+++ b/src/other.ts",
                "@@ -1 +1 @@",
                "-a",
                "+b",
            ].join("\n"),
        );
        expect(result.ok).toBe(false);
        expect(result.output).toContain("path mismatch");
    });

    test("refuses a patch that targets a protected file", async () => {
        const proc = Bun.spawn(["git", "init"], { cwd: root, stdout: "pipe" });
        await proc.exited;
        const result = await editFile(
            root,
            "src/client.ts",
            ["--- a/.env", "+++ b/.env", "@@ -1 +1 @@", "-A", "+B"].join("\n"),
        );
        expect(result.ok).toBe(false);
        expect(result.output).toContain("Refused to edit");
    });

    test("refuses a patch that escapes the root", async () => {
        const proc = Bun.spawn(["git", "init"], { cwd: root, stdout: "pipe" });
        await proc.exited;
        const result = await editFile(
            root,
            "src/client.ts",
            [
                "--- a/../../etc/passwd",
                "+++ b/../../etc/passwd",
                "@@ -1 +1 @@",
                "-a",
                "+b",
            ].join("\n"),
        );
        expect(result.ok).toBe(false);
    });
});

describe("replaceInFile", () => {
    test("replaces a unique snippet", async () => {
        await writeFile(
            join(root, "payment.js"),
            "    status: pi.status,\n    source: pi.source,\n    client_secret: pi.client_secret,\n",
        );

        const result = await replaceInFile(
            root,
            "payment.js",
            "    source: pi.source,\n",
            "    payment_method: pi.payment_method,\n",
        );

        expect(result.ok).toBe(true);
        const updated = await Bun.file(join(root, "payment.js")).text();
        expect(updated).toContain("payment_method: pi.payment_method");
        expect(updated).not.toContain("pi.source");
        expect(updated).toContain("client_secret: pi.client_secret");
    });

    test("rejects an oldText that appears more than once", async () => {
        await writeFile(join(root, "a.js"), "x();\nx();\n");

        const result = await replaceInFile(root, "a.js", "x();", "y();");

        expect(result.ok).toBe(false);
        expect(result.output).toContain("2 matches");
        expect(await Bun.file(join(root, "a.js")).text()).toBe("x();\nx();\n");
    });

    test("rejects an oldText that is not present", async () => {
        await writeFile(join(root, "a.js"), "x();\n");

        const result = await replaceInFile(root, "a.js", "nope();", "y();");

        expect(result.ok).toBe(false);
        expect(result.output).toContain("no match");
        expect(await Bun.file(join(root, "a.js")).text()).toBe("x();\n");
    });

    test("refuses protected paths", async () => {
        const result = await replaceInFile(root, ".env", "SECRET=should-not-be-readable\n", "x");
        expect(result.ok).toBe(false);
    });

    test("refuses to escape the root", async () => {
        const result = await replaceInFile(root, "../outside.js", "a", "b");
        expect(result.ok).toBe(false);
    });

    test("reports a missing file", async () => {
        const result = await replaceInFile(root, "nope.js", "a", "b");
        expect(result.ok).toBe(false);
        expect(result.output).toContain("cannot find");
    });

    test("rejects empty oldText", async () => {
        await writeFile(join(root, "a.js"), "x();\n");
        const result = await replaceInFile(root, "a.js", "", "y();");
        expect(result.ok).toBe(false);
    });

    test("rejects a no-op replacement", async () => {
        await writeFile(join(root, "a.js"), "x();\n");
        const result = await replaceInFile(root, "a.js", "x();", "x();");
        expect(result.ok).toBe(false);
    });

    test("can delete text with an empty newText", async () => {
        await writeFile(join(root, "a.js"), "keep();\ndrop();\n");
        const result = await replaceInFile(root, "a.js", "drop();\n", "");
        expect(result.ok).toBe(true);
        expect(await Bun.file(join(root, "a.js")).text()).toBe("keep();\n");
    });
});

describe("patchTargets", () => {
    test("reads a/ and b/ prefixes", () => {
        expect(
            patchTargets(["--- a/src/a.ts", "+++ b/src/a.ts"].join("\n")),
        ).toEqual(["src/a.ts"]);
    });

    test("reads an unprefixed target", () => {
        expect(patchTargets(["--- src/a.ts", "+++ src/a.ts"].join("\n"))).toEqual([
            "src/a.ts",
        ]);
    });

    test("reads a /dev/null deletion target as no new path", () => {
        expect(patchTargets(["--- a/src/a.ts", "+++ /dev/null"].join("\n"))).toEqual([
            null,
        ]);
    });
});

describe("buildSandboxEnv", () => {
    test("keeps PATH and HOME", () => {
        const env = buildSandboxEnv({ PATH: "/bin", HOME: "/home/u" });
        expect(env.PATH).toBe("/bin");
        expect(env.HOME).toBe("/home/u");
    });

    test("drops secrets, tokens, and private keys", () => {
        const env = buildSandboxEnv({
            PATH: "/bin",
            OPENAI_API_KEY: "sk-real",
            GITHUB_TOKEN: "ghp_real",
            AWS_SECRET_ACCESS_KEY: "real",
            GITHUB_PRIVATE_KEY_PATH: "/key.pem",
            SESSION_SECRET: "real",
            DB_PASSWORD: "real",
        });
        expect(env.OPENAI_API_KEY).toBeUndefined();
        expect(env.GITHUB_TOKEN).toBeUndefined();
        expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
        expect(env.GITHUB_PRIVATE_KEY_PATH).toBeUndefined();
        expect(env.SESSION_SECRET).toBeUndefined();
        expect(env.DB_PASSWORD).toBeUndefined();
        expect(env.PATH).toBe("/bin");
    });

    test("always sets CI", () => {
        expect(buildSandboxEnv({}).CI).toBe("1");
    });

    test("keeps benign vars", () => {
        const env = buildSandboxEnv({ PATH: "/bin", NODE_ENV: "test" });
        expect(env.NODE_ENV).toBe("test");
    });
});

describe("runCommand", () => {
    test("rejects commands outside the whitelist", async () => {
        const result = await runCommand(root, "rm -rf /");
        expect(result.ok).toBe(false);
        expect(result.output).toContain("Command not allowed");
    });

    test("rejects shell metacharacter injection", async () => {
        const result = await runCommand(root, "npm test && rm -rf /");
        expect(result.ok).toBe(false);
    });

    test("runs a whitelisted command that exits zero", async () => {
        const result = await runCommand(root, "npm run build");
        expect(result.ok).toBe(true);
        expect(result.output).toContain("exit code: 0");
    });

    test("reports failure when a whitelisted command exits non-zero", async () => {
        const result = await runCommand(root, "npm run typecheck");
        expect(result.ok).toBe(false);
        expect(result.output).toContain("exit code: 1");
    });

    test("exposes the whitelist", () => {
        expect(allowedCommands()).toContain("npm run typecheck");
        expect(isAllowedCommand("npm test")).toBe(true);
        expect(isAllowedCommand("git push")).toBe(false);
    });

    test("does not hand secrets to a customer build script", async () => {
        await writeFile(
            join(root, "package.json"),
            JSON.stringify({
                name: "hostile",
                scripts: {
                    build: 'node -e "console.log(JSON.stringify(Object.keys(process.env).filter(k=>/KEY|TOKEN|SECRET|PASSWORD/.test(k))))"',
                },
            }),
        );
        const previous = process.env.OPENAI_API_KEY;
        process.env.OPENAI_API_KEY = "sk-probe-not-real";
        try {
            const result = await runCommand(root, "npm run build");
            expect(result.output).toContain("[]");
        } finally {
            if (previous === undefined) delete process.env.OPENAI_API_KEY;
            else process.env.OPENAI_API_KEY = previous;
        }
    });
});
