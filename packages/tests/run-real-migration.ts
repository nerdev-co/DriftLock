import { runMigrationAgent, type ChangePacket } from "@driftlock/agent";

const PACKETS: Record<string, ChangePacket> = {
    stripe: {
        provider: "stripe",
        fromVersion: "2022-08-01",
        toVersion: "2022-11-15",
        summary:
            "The legacy `source` field on the PaymentIntent object has been removed. It was a legacy Sources API field and is superseded by `payment_method`. Replace every read of `paymentIntent.source` with `paymentIntent.payment_method`.",
        migrationDocs: [
            "https://docs.stripe.com/upgrades#2022-11-15",
            "https://docs.stripe.com/payments/payment-methods",
        ],
    },
    p5: {
        provider: "p5.js",
        fromVersion: "1.11.13",
        toVersion: "2.3.0",
        summary:
            "p5 2.x reworked keyboard input. Comparing keyCode to a numeric literal no longer works, and `keyIsPressed && key === X` is replaced by `keyIsDown(X)`. Rewrite keyboard checks to use `keyIsDown(...)` with p5 key constants or KeyboardEvent.code strings.",
        migrationDocs: ["https://p5js.org/tutorials/v2_transition/"],
    },
};

const which = process.argv[2];
const root = process.argv[3];
const packet = PACKETS[which];

if (!packet || !root) {
    console.error("usage: bun run run-real-migration.ts <stripe|p5> <repoPath>");
    console.error("needs --env-file=../../.env for Cloudflare credentials");
    process.exit(1);
}

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const model = process.env.CLOUDFLARE_AI_MODEL;
if (!accountId || !process.env.CLOUDFLARE_API_TOKEN) {
    console.error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required");
    process.exit(1);
}

console.log(`repo:   ${root}`);
console.log(`packet: ${packet.provider} ${packet.fromVersion} -> ${packet.toVersion}`);
console.log(`model:  ${model}`);
console.log(`view:   git -C ${root} diff`);

const started = Date.now();
const result = await runMigrationAgent({
    root,
    packet,
    apiKey: process.env.CLOUDFLARE_API_TOKEN,
    baseURL: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
    model,
});

console.log("=".repeat(70));
console.log(`elapsed: ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`outcome: ${result.outcome}`);
console.log(`iterations: ${result.state.iteration} / ${result.state.maxIterations}`);
console.log(`files changed: ${result.filesChanged.join(", ") || "(none)"}`);
console.log(`commands run: ${result.state.commandsRun}`);
console.log(`verification passed: ${result.state.lastTestResult?.passed ?? "never ran"}`);
console.log(`pull request: ${JSON.stringify(result.state.pullRequest)}`);
console.log("-".repeat(70));
for (const entry of result.state.transcript) {
    for (const call of entry.toolCalls ?? []) {
        console.log(`\n>>> ${call.name} ${JSON.stringify(call.args)}`);
    }
    if (entry.role === "assistant" && entry.content) {
        console.log(`\nASSISTANT: ${entry.content}`);
    }
    if (entry.role === "tool") {
        console.log(`\n<< ${entry.toolName}:\n${entry.content}`);
    }
}
