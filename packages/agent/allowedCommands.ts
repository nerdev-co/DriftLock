/**
 * The exact commands the agent may run, shared by the executor that enforces
 * the list and the fingerprint that suggests commands to the model.
 *
 * Lives in its own module so `repoFacts` can filter derived commands without
 * importing `executor` (which already imports `repoFacts`).
 */
const ALLOWED_COMMANDS = new Set([
    "npm test",
    "npm run test",
    "npm run build",
    "npm run typecheck",
    "npm run lint",
    "pnpm test",
    "pnpm run build",
    "pnpm run typecheck",
    "pnpm run lint",
    "bun test",
    "bun run build",
    "bun run typecheck",
    "bun run lint",
    // Rust and Go. `deriveVerificationCommands` filters the fingerprint's
    // suggested commands through this same list, so omitting these silently
    // gave every cargo and go repository an empty verification set: the model
    // was told to verify nothing, and the executor would have refused them
    // anyway. The entries are the exact strings `readCargoFacts` and
    // `readGoFacts` produce, because the match is exact, not a prefix.
    "cargo check",
    "cargo build",
    "cargo test",
    "go build ./...",
    "go test ./...",
]);

export function isAllowedCommand(command: string): boolean {
    return ALLOWED_COMMANDS.has(command.trim());
}

export function allowedCommands(): string[] {
    return [...ALLOWED_COMMANDS];
}
