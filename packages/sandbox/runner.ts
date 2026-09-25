import Docker from "dockerode";
import { ProxyServer, type ProxySafetyConfig } from "./proxy";

export interface SandboxConfig {
    image: string;
    command: string[];
    env: Record<string, string>;
    timeout: number; // in milliseconds
    memoryLimit: string; // e.g., '512m'
    cpuLimit: number; // e.g., 1.0 for one CPU
    networkEnabled: boolean;
    allowedEndpoints: string[]; // e.g., ['api.stripe.com:443']
    /**
     * Forward guard. Non-idempotent methods are intercepted (captured, not
     * forwarded) unless listed here.
     */
    safety?: ProxySafetyConfig;
    /**
     * Mount the workspace read-only. Defaults to true. Callers that need a
     * build to write output (dist, .next, caches) must opt out, and should
     * point the mount at a disposable copy rather than a real checkout.
     */
    readOnly?: boolean;
    /**
     * Extra bind mounts, host path to container path. Use for read-only
     * mounts such as a shared node_modules.
     */
    extraBinds?: string[];
}

export interface SandboxResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    duration: number;
    trafficCaptured: TrafficCapture[];
}

export interface TrafficCapture {
    timestamp: Date;
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: unknown;
    response?: {
        status: number;
        headers: Record<string, string>;
        body?: unknown;
    };
    /** True when the proxy blocked the request instead of forwarding it. */
    intercepted?: boolean;
}

/**
 * Docker multiplexes stdout and stderr over one stream as 8-byte frames:
 * [streamType, 0, 0, 0, size(BE32)] then payload. streamType 1 is stdout,
 * 2 is stderr. Without splitting the frames the caller gets binary framing
 * garbage in the middle of the build output and an always-empty stderr.
 * Anything that does not parse as a frame is passed through as stdout, so a
 * TTY-attached stream still yields its text.
 */
export function demuxDockerStream(buffer: Buffer): {
    stdout: string;
    stderr: string;
} {
    let stdout = "";
    let stderr = "";
    let offset = 0;

    const emit = (streamType: number, payload: Buffer) => {
        if (streamType === 2) stderr += payload.toString("utf8");
        else stdout += payload.toString("utf8");
    };

    while (offset < buffer.length) {
        const remaining = buffer.length - offset;
        if (remaining < 8) {
            stdout += buffer.subarray(offset).toString("utf8");
            break;
        }

        const streamType = buffer[offset];
        const size = buffer.readUInt32BE(offset + 4);
        const structural =
            (streamType === 0 || streamType === 1 || streamType === 2) &&
            buffer[offset + 1] === 0 &&
            buffer[offset + 2] === 0 &&
            buffer[offset + 3] === 0 &&
            size > 0;

        if (!structural) {
            stdout += buffer.subarray(offset).toString("utf8");
            break;
        }

        const available = remaining - 8;
        if (size > available) {
            emit(streamType, buffer.subarray(offset + 8));
            break;
        }

        emit(streamType, buffer.subarray(offset + 8, offset + 8 + size));
        offset += 8 + size;
    }

    return { stdout, stderr };
}

export class SandboxRunner {
    private docker: Docker;

    constructor() {
        this.docker = new Docker();
    }

    async runTestSuite(
        repoPath: string,
        config: SandboxConfig,
    ): Promise<SandboxResult> {
        const startTime = Date.now();
        let container: Docker.Container | null = null;
        let proxy: ProxyServer | null = null;

        try {
            // Build or pull the sandbox image
            await this.ensureImage(config.image);

            // Start the traffic capture proxy when networking is enabled
            if (config.networkEnabled) {
                proxy = new ProxyServer(0, config.safety);
                await proxy.start();
            }

            const env = Object.entries(config.env).map(
                ([key, value]) => `${key}=${value}`,
            );
            if (proxy) {
                const proxyUrl = `http://host.docker.internal:${proxy.getPort()}`;
                env.push(`HTTP_PROXY=${proxyUrl}`);
                env.push(`HTTPS_PROXY=${proxyUrl}`);
                env.push("NO_PROXY=localhost,127.0.0.1");
            }

            // Create container
            const readOnly = config.readOnly ?? true;
            const binds = [
                `${repoPath}:/workspace${readOnly ? ":ro" : ""}`,
                ...(config.extraBinds ?? []),
            ];
            container = await this.docker.createContainer({
                Image: config.image,
                Cmd: config.command,
                WorkingDir: "/workspace",
                Env: env,
                HostConfig: {
                    Binds: binds,
                    Memory: this.parseMemoryLimit(config.memoryLimit),
                    NanoCpus: config.cpuLimit * 1e9,
                    NetworkMode: config.networkEnabled ? "bridge" : "none",
                    ExtraHosts: config.networkEnabled
                        ? ["host.docker.internal:host-gateway"]
                        : undefined,
                },
            });

            // Start container
            await container.start();

            // Wait for completion with timeout
            const result = await Promise.race([
                this.waitForContainer(container),
                this.createTimeout(config.timeout),
            ]);

            const duration = Date.now() - startTime;

            return {
                exitCode: result.exitCode,
                stdout: result.stdout,
                stderr: result.stderr,
                duration,
                trafficCaptured: proxy?.getCaptures() ?? [],
            };
        } catch (error) {
            const duration = Date.now() - startTime;
            return {
                exitCode: 1,
                stdout: "",
                stderr:
                    error instanceof Error ? error.message : "Unknown error",
                duration,
                trafficCaptured: proxy?.getCaptures() ?? [],
            };
        } finally {
            if (proxy) {
                try {
                    await proxy.stop();
                } catch {
                    // Ignore proxy cleanup errors
                }
            }
            if (container) {
                try {
                    await container.remove({ force: true });
                } catch {
                    // Ignore cleanup errors
                }
            }
        }
    }

    private async ensureImage(image: string): Promise<void> {
        try {
            await this.docker.getImage(image).inspect();
        } catch {
            // Image doesn't exist, pull it
            await this.docker.pull(image);
        }
    }

    private async waitForContainer(container: Docker.Container): Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
    }> {
        const stream = await container.attach({
            stream: true,
            stdout: true,
            stderr: true,
        });

        const chunks: Buffer[] = [];

        return new Promise((resolve) => {
            stream.on("data", (chunk: Buffer) => {
                chunks.push(Buffer.from(chunk));
            });

            stream.on("error", () => {
                // Resolved from the inspect below; a mid-stream attach error
                // should not hang the run.
            });

            stream.on("end", async () => {
                const info = await container.inspect();
                const { stdout, stderr } = demuxDockerStream(
                    Buffer.concat(chunks),
                );
                resolve({
                    exitCode: info.State.ExitCode,
                    stdout,
                    stderr,
                });
            });
        });
    }

    private createTimeout(ms: number): Promise<never> {
        return new Promise((_, reject) => {
            setTimeout(() => {
                reject(new Error(`Sandbox timed out after ${ms}ms`));
            }, ms);
        });
    }

    private parseMemoryLimit(limit: string): number {
        const match = limit.match(/^(\d+)(m|g)$/i);
        if (!match) {
            return 512 * 1024 * 1024; // Default 512MB
        }

        const value = parseInt(match[1], 10);
        const unit = match[2].toLowerCase();

        if (unit === "g") {
            return value * 1024 * 1024 * 1024;
        }
        return value * 1024 * 1024;
    }
}
