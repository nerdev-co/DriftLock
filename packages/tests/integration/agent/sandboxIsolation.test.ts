import {
    afterAll,
    beforeAll,
    describe,
    expect,
    setDefaultTimeout,
    test,
} from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSandboxCommandRunner } from "@driftlock/agent";

setDefaultTimeout(60_000);

let root: string;

const dockerAvailable = (() => {
    const probe = Bun.spawnSync(["docker", "version", "--format", "{{.Server.Version}}"]);
    return probe.exitCode === 0;
})();

const commandRunner = createSandboxCommandRunner();

beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "driftlock-docker-"));
});

afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
});

async function writeRepo(script: string): Promise<void> {
    await rm(root, { recursive: true, force: true });
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
        join(root, "package.json"),
        JSON.stringify({ name: "fixture", private: true, scripts: { build: script } }),
    );
    await writeFile(join(root, "src/client.ts"), "export const x = 1;\n");
}

describe("sandbox prerequisites", () => {
    test("Docker daemon is reachable", () => {
        expect(dockerAvailable).toBe(true);
    });
});

function hasFramingBytes(text: string): boolean {
    for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        if (code < 9) return true;
        if (code === 11 || code === 12) return true;
        if (code > 13 && code < 32) return true;
    }
    return false;
}

describe.skipIf(!dockerAvailable)("sandboxed build isolation", () => {
    test("runs a build in the container and leaves the checkout untouched", async () => {
        await writeRepo(
            'node -e "require(\'fs\').writeFileSync(\'build-marker.txt\',\'built\')"',
        );

        const result = await commandRunner.run(root, "npm run build");

        expect(result.ok).toBe(true);
        expect(existsSync(join(root, "build-marker.txt"))).toBe(false);
    });

    test("cannot reach the network", async () => {
        await writeRepo(
            "node -e \"const m='NET_'+String.fromCharCode(82,69,65,67,72,69,68);require('https').get('https://registry.npmjs.org',r=>{console.log(m);process.exit(0)}).on('error',e=>{console.log('NET_BLOCKED');process.exit(3)})\"",
        );

        const result = await commandRunner.run(root, "npm run build");

        expect(result.ok).toBe(false);
        expect(result.output).toContain("exit code: 3");
        expect(result.output).toContain("NET_BLOCKED");
        expect(result.output).not.toContain("NET_REACHED");
    });

    test("cannot see the original .git directory", async () => {
        await writeRepo(
            'node -e "const fs=require(\'fs\');console.log(fs.existsSync(\'.git\')?\'HAS_GIT\':\'NO_GIT\')"',
        );

        const result = await commandRunner.run(root, "npm run build");

        expect(result.ok).toBe(true);
        expect(result.output).toContain("NO_GIT");
    });

    test("cannot read a secret from the host environment", async () => {
        await writeRepo(
            'node -e "console.log(process.env.OPENAI_API_KEY?\'LEAKED\':\'CLEAN\')"',
        );

        const previous = process.env.OPENAI_API_KEY;
        process.env.OPENAI_API_KEY = "sk-should-not-be-visible";
        try {
            const result = await commandRunner.run(root, "npm run build");
            expect(result.output).toContain("CLEAN");
        } finally {
            if (previous === undefined) delete process.env.OPENAI_API_KEY;
            else process.env.OPENAI_API_KEY = previous;
        }
    });

    test("reports a failing build as a failure", async () => {
        await writeRepo('node -e "console.error(\'type error TS2345\');process.exit(2)"');

        const result = await commandRunner.run(root, "npm run build");

        expect(result.ok).toBe(false);
        expect(result.output).toContain("exit code: 2");
        expect(result.output).toContain("type error TS2345");
    });

    test("keeps build errors out of stdout and free of framing bytes", async () => {
        await writeRepo(
            'node -e "console.log(\'STDOUT_MARK\');console.error(\'STDERR_MARK\');process.exit(0)"',
        );

        const result = await commandRunner.run(root, "npm run build");

        expect(result.output).toContain("STDOUT_MARK");
        expect(result.output).toContain("STDERR_MARK");
        expect(hasFramingBytes(result.output)).toBe(false);
    });

    test("still refuses a non-whitelisted command", async () => {
        await writeRepo("true");
        const result = await commandRunner.run(root, "curl https://example.com");
        expect(result.ok).toBe(false);
        expect(result.output).toContain("Command not allowed");
    });
});
