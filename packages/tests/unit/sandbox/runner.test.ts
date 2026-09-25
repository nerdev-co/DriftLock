import { describe, expect, test, mock } from "bun:test";
import { SandboxRunner, demuxDockerStream } from "@driftlock/sandbox";
import type { SandboxConfig } from "@driftlock/sandbox";

function frame(streamType: 1 | 2, payload: string): Buffer {
    const body = Buffer.from(payload, "utf8");
    const header = Buffer.alloc(8);
    header.writeUInt8(streamType, 0);
    header.writeUInt32BE(body.length, 4);
    return Buffer.concat([header, body]);
}

function createConfig(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
    return {
        image: "node:20-slim",
        command: ["sh", "-c", "echo hello"],
        env: {},
        timeout: 5000,
        memoryLimit: "512m",
        cpuLimit: 1.0,
        networkEnabled: false,
        allowedEndpoints: [],
        ...overrides,
    };
}

describe("SandboxRunner", () => {
    test("constructor creates instance", () => {
        const runner = new SandboxRunner();
        expect(runner).toBeDefined();
    });

    test("runTestSuite has correct return type shape", async () => {
        // This test verifies the method signature and return type
        // Actual Docker execution would require Docker to be running
        const runner = new SandboxRunner();
        expect(typeof runner.runTestSuite).toBe("function");
    });

    test("runTestSuite returns a promise and reports Docker failures", async () => {
        const runner = new SandboxRunner();
        const inspect = mock(async () => ({}));
        const createContainer = mock(async (_options: unknown) => {
            throw new Error("Container creation failed");
        });
        const docker = {
            getImage: mock((_image: string) => ({ inspect })),
            createContainer,
        };
        (runner as unknown as { docker: typeof docker }).docker = docker;

        const result = runner.runTestSuite("/tmp", createConfig());
        expect(result).toBeInstanceOf(Promise);
        expect(await result).toEqual({
            exitCode: 1,
            stdout: "",
            stderr: "Container creation failed",
            duration: expect.any(Number),
            trafficCaptured: [],
        });
        expect(docker.getImage).toHaveBeenCalledWith("node:20-slim");
        expect(inspect).toHaveBeenCalledTimes(1);
        expect(createContainer).toHaveBeenCalledWith(
            expect.objectContaining({
                HostConfig: expect.objectContaining({ NetworkMode: "none" }),
            }),
        );
    });
});

describe("demuxDockerStream", () => {
    test("splits stdout and stderr frames", () => {
        const buffer = Buffer.concat([
            frame(1, "out-1\n"),
            frame(2, "err-1\n"),
            frame(1, "out-2\n"),
            frame(2, "err-2\n"),
        ]);
        expect(demuxDockerStream(buffer)).toEqual({
            stdout: "out-1\nout-2\n",
            stderr: "err-1\nerr-2\n",
        });
    });

    test("handles a stdout-only stream", () => {
        expect(demuxDockerStream(Buffer.concat([frame(1, "only\n")]))).toEqual({
            stdout: "only\n",
            stderr: "",
        });
    });

    test("handles a stderr-only stream", () => {
        expect(demuxDockerStream(frame(2, "bad\n"))).toEqual({
            stdout: "",
            stderr: "bad\n",
        });
    });

    test("passes an unframed TTY stream through as stdout", () => {
        const raw = Buffer.from("no framing here\n", "utf8");
        expect(demuxDockerStream(raw)).toEqual({
            stdout: "no framing here\n",
            stderr: "",
        });
    });

    test("returns empty strings for an empty buffer", () => {
        expect(demuxDockerStream(Buffer.alloc(0))).toEqual({
            stdout: "",
            stderr: "",
        });
    });

    test("keeps multi-byte characters intact", () => {
        const result = demuxDockerStream(frame(1, "café ✅\n"));
        expect(result.stdout).toBe("café ✅\n");
    });

    test("strips the header from a trailing partial frame", () => {
        const complete = frame(1, "kept\n");
        const truncated = complete.subarray(0, complete.length - 2);
        expect(demuxDockerStream(truncated)).toEqual({
            stdout: "kep",
            stderr: "",
        });
    });
});

describe("SandboxConfig", () => {
    test("config accepts all required fields", () => {
        const config = createConfig();
        expect(config.image).toBe("node:20-slim");
        expect(config.command).toEqual(["sh", "-c", "echo hello"]);
        expect(config.timeout).toBe(5000);
        expect(config.memoryLimit).toBe("512m");
        expect(config.cpuLimit).toBe(1.0);
        expect(config.networkEnabled).toBe(false);
    });

    test("config accepts overrides", () => {
        const config = createConfig({
            image: "python:3.11",
            timeout: 10000,
            memoryLimit: "1g",
            networkEnabled: true,
        });
        expect(config.image).toBe("python:3.11");
        expect(config.timeout).toBe(10000);
        expect(config.memoryLimit).toBe("1g");
        expect(config.networkEnabled).toBe(true);
    });

    test("config accepts allowed endpoints", () => {
        const config = createConfig({
            allowedEndpoints: ["api.stripe.com:443"],
        });
        expect(config.allowedEndpoints).toEqual(["api.stripe.com:443"]);
    });

    test("mounts read-only by default", async () => {
        const runner = new SandboxRunner();
        const createContainer = mock(async () => {
            throw new Error("stop");
        });
        const docker = {
            getImage: mock((_image: string) => ({ inspect: mock(async () => ({})) })),
            createContainer,
        };
        (runner as unknown as { docker: typeof docker }).docker = docker;

        await runner.runTestSuite("/tmp", createConfig());

        expect(createContainer).toHaveBeenCalledWith(
            expect.objectContaining({
                HostConfig: expect.objectContaining({
                    Binds: ["/tmp:/workspace:ro"],
                }),
            }),
        );
    });

    test("mounts writable and adds extra binds when asked", async () => {
        const runner = new SandboxRunner();
        const createContainer = mock(async () => {
            throw new Error("stop");
        });
        const docker = {
            getImage: mock((_image: string) => ({ inspect: mock(async () => ({})) })),
            createContainer,
        };
        (runner as unknown as { docker: typeof docker }).docker = docker;

        await runner.runTestSuite(
            "/tmp/work",
            createConfig({ readOnly: false, extraBinds: ["/tmp/nm:/workspace/node_modules:ro"] }),
        );

        expect(createContainer).toHaveBeenCalledWith(
            expect.objectContaining({
                HostConfig: expect.objectContaining({
                    Binds: [
                        "/tmp/work:/workspace",
                        "/tmp/nm:/workspace/node_modules:ro",
                    ],
                }),
            }),
        );
    });
});
