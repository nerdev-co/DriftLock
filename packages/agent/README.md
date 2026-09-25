# @driftlock/agent

The migration agent. Takes a vendor API change, edits a customer repository to
match, verifies the result, and stops with a verdict.

## [shipped] Stage 0: knowing what repository this is

Before the model is asked to change anything, the agent reads the repository and
reports what it actually is. No model, no network, no guessing.

The reason is a specific observed failure. On a real run the agent executed
three verification commands that did not exist, because it guessed at script
names instead of reading the manifest. A wrong guess about a script name is
indistinguishable from a real build failure, so the diagnosis sends you looking in
completely the wrong place.

`fingerprintRepo(root)` returns `RepoFacts`:

| Field                   | What it answers                                        |
| ----------------------- | ------------------------------------------------------ |
| `ecosystem`             | npm, cargo, python, go, or unknown                    |
| `packageManager`        | which one to actually invoke                           |
| `scripts`               | script name to the command it runs                     |
| `dependencies`          | declared ranges                                        |
| `resolvedVersions`      | versions the lockfile pinned, which beat those ranges |
| `verificationCommands`  | commands that exist, ordered most authoritative first  |
| `ci`                    | what the workflows run, as evidence                    |
| `frameworks`, `runtime` | what kind of project this is                           |

`versionOf(facts, "p5")` returns `1.11.13` rather than `^1.11.0` when a lockfile
pins it, because the lockfile records what is installed. When there is no
lockfile, an exact pin in the manifest is still used, which matters: the p5
repository in the real run has no lockfile and states `"p5": "1.11.13"`, and
reading only the lockfile would have reported no version at all.

Two deliberate limits:

- **CI commands are read but never executed.** A workflow can contain a deploy
  or a migration. They are surfaced as evidence of what the project considers
  verification and are deliberately kept out of `verificationCommands`, because
  a repository can easily run a command in CI that its own manifest does not
  define.
- **A malformed manifest is a warning, not a failure.** A repository we cannot
  fully understand is still one we can migrate, and refusing would be worse than
  proceeding with the problem recorded.

`describeRepoFacts` renders this for the opening message, and the model is told
to run only the listed commands. When the list is empty the message says
verification is unavailable rather than leaving the model to invent one.

### Ecosystems are detected, not enumerated

`Ecosystem` is an open `string`, not a union. A closed union of `"npm" |
"cargo" | "python" | "go" | "unknown"` reports `unknown` for every language
nobody thought of, which is simply false: the repository is perfectly
identifiable, we just cannot parse it. Detection runs from a marker table
(`mix.exs` to elixir, `Gemfile` to ruby, `composer.json` to php, `pom.xml` to
java, `pubspec.yaml` to dart, `*.csproj` to dotnet) that is independent of
whether a parser exists, and `ecosystemSupport` says which of the two happened:

| `ecosystemSupport` | Meaning                                                    |
| ------------------ | ---------------------------------------------------------- |
| `parsed`           | dependencies and scripts were read out of the manifest      |
| `detected`         | the language is known, but nothing was parsed               |
| `none`             | no marker file was found, so we genuinely do not know       |

A detected-only repository is told so explicitly, and the warning names the
marker file that identified it, because "elixir is recognised from Gemfile"
sends the reader to the wrong file. `alsoDetected` reports polyglot and monorepo
repositories rather than silently picking one. Adding a language is a new row in
the marker table, not a new branch in a type.

The distinction matters most where it is least comfortable. A repository whose
`package.json` will not parse is still an npm repository; only the manifest
contents were lost. Reporting `unknown` there would hide that, so it reports npm
with `ecosystemSupport: "detected"` and no dependencies.

`DETECTED_PACKAGE_MANAGER` supplies the tool for a language we recognise but
cannot parse, and deliberately does not fall back to the ecosystem name, because
"using rust" and "using elixir" are not commands anyone can run.

### One directory walk

`listRepoFiles` is the only place the agent walks a repository. Both the
fingerprint and `searchCode` go through it, because two walks in one package
means two lists of skip directories that drift apart and then quietly disagree
about what a repository contains. A plain recursive glob is not enough: it
cannot prune, so a double-star pattern descends into `node_modules` and `target`
and spends its budget on build output.

`extensionOf` splits on the last dot in the basename, so `Dockerfile.prod` has
extension `.prod` and `.nvmrc` has none, rather than both being treated as
extensions.

## [shipped] Progressive instructions

The opening message does not contain the whole workflow. It contains the packet,
the repository facts, the contract, and **Step 1**. Each later step is appended
the moment the work reaches it, so a model is never asked to satisfy the edit
rules, the gate rules, and the hard rules before it has found a single call site.

`stageOf(state)` derives the stage from what actually happened, not from what the
model says it intends to do:

| Stage     | Becomes true when             | What the model is told                 |
| --------- | ----------------------------- | -------------------------------------- |
| `locate`  | nothing yet                   | search once per deprecated name        |
| `read`    | it has searched               | read each file, plus direct callers    |
| `edit`    | it has read a file            | prefer `replaceInFile`, minimal change |
| `verify`  | it changed a file             | run exactly one listed command         |
| `pr`      | a command passed              | summarise and open the pull request    |

A single instruction wall is a wall in which every constraint competes for
attention with every other one, and models reliably satisfy the rules nearest the
end. Progressive disclosure also means the ordering is enforced by the harness
rather than merely requested in a prompt, which is the difference between asking
for the right behaviour and depending on it.

## [shipped] Checking edits against the real vendor

A passing test suite does not mean a migration is correct. It means the code
still compiles. The gap that matters is between "the build is green" and "this
references APIs that exist".

The agent closes that gap with a `VendorContract`: ground truth about what the
vendor actually exposes, and a gate that refuses a pull request when the edited
code references something the contract cannot place.

### Where a contract comes from

| Source      | How                                    | Absence means                                    |
| ----------- | -------------------------------------- | ------------------------------------------------ |
| `live`      | one real GET to the vendor, right now  | the field is gone, for that endpoint              |
| `spec`      | the vendor's own published declarations| the member does not exist, anywhere              |
| `recorded`  | a union of previously observed traffic | probably just not in the sample, so mostly ignored |

A contract is `{ provider, version, source, authority, origin, capturedAt,
members[], removed[] }`. `members` are dotted paths (`payment_method`,
`charges.data[].id`), and `removed` is what a diff against a baseline showed the
vendor dropped.

`authority` is the whole point. A `live` or `spec` contract is authoritative, so
a missing member is a real finding. A `recorded` contract is sampled, so the
gate only reports something it can prove, namely an explicit entry in `removed`.
That asymmetry is deliberate: treating a narrow sample as proof of removal is how
you ship a confident, completely wrong migration.

### What the gate catches

| Finding           | Means                                                    | Real example                                    |
| ----------------- | -------------------------------------------------------- | ----------------------------------------------- |
| `unresolved`      | reads a member the vendor does not have                   | `paymentIntent.payment_methods`                 |
| `stale`           | still reads a field the vendor removed                    | one `paymentIntent.source` left behind           |
| `unbound-constant`| uses a vendor constant as a free identifier                | `keyIsDown(UP_ARROW)` in instance mode           |

`stale` is the completeness check, and it is why the gate sweeps files the agent
never touched. A migration that edits two of three call sites produces a diff
that looks finished and a green build, and the third file is never opened. A
stale read is a missed call site wherever it lives. Untouched files are scanned
for `stale` only, since pre-existing use of some other field is not this
migration's problem.

The gate runs inside `createPullRequest`, after the command check, and
`decideOutcome` will not return `auto_pr` while any finding stands. A green test
suite with an unresolved vendor symbol is `review_pr` at best. A green suite
with no contract at all is `review_pr` (`draft_pr` with `prMode: "draft"`) at
best, for the same reason: nothing verified the edits against the vendor.

### Why receiver discovery matters

`VendorConfig.clientNames` names the SDK client, and real code almost never
reads fields off the client. It reads them off whatever a call returned, named
anything: `pi`, `paymentIntent`, `intent`. Checking only `stripe.something`
would pass on code that is entirely wrong, because it would never look at the
line that matters.

`discoverVendorReceivers` finds a variable assigned from a vendor client call or
from a webhook payload chain. It is a heuristic and not exhaustive, so
`VerifyOptions.clientNames` takes explicit receivers when the heuristic misses.
`VendorConfig.contractSubject` separates the two cases: `resources` (Stripe, a
captured response says nothing about the client's own resource accessors) versus
`client` (p5, where the instance passed to the sketch *is* the API surface).

### Why this is not a typechecker

It checks that symbols **exist**, not that they are used correctly. It catches
`UP_ARROW` and it catches the missed `source` site. It does **not** catch
`keyIsDown("Space")`, where a real p5 member is called with a plausible but wrong
argument, and it cannot catch an SDK version skew where a member exists in 2.3
but the repo pins 2.1. Only executing against the vendor catches those. This is
a floor under the migration, not a ceiling.

## [shipped] Live vendor vs recorded vendor

Both produce the same `VendorContract`, so the gate has one code path. The
difference is freshness, cost, and what an absence proves.

|                     | Live                          | Recorded                        |
| ------------------- | ----------------------------- | ------------------------------- |
| Freshness           | right now                     | as old as the recording         |
| Cost                | a request, possibly a metered one | free, replayable            |
| Side effects        | none, GET only                | none                            |
| Determinism         | the vendor can change under you | identical every run          |
| Needs credentials   | usually yes, for anything useful | no                          |
| Catches             | fields the vendor added *yesterday* | nothing newer than the capture |
| Proves absence      | yes, for the probed endpoint  | no, only via an explicit `removed` |
| Works offline       | no                            | yes                             |

The practical split: a **live** probe is how you find out what changed since the
last recording, and a **recorded** contract is what you can rely on in CI, where
a network call to a third party on every build is a liability rather than a
feature. DriftLock's own shape already reflects this, with
`packages/pipeline` and `packages/webhookCapture` producing recorded contracts
from observed traffic, and `VendorConfig.docs.specUrl` pointing at published
declarations for the vendors that have them.

Neither substitutes for the other. A recorded contract cannot tell you the vendor
shipped a breaking change this morning, and a live probe cannot tell you whether
your migration is correct for the traffic you actually receive.

## [shipped] What this does

You hand it a `ChangePacket` (provider, from version, to version, summary,
migration docs) and a path to a git repository. Before the model sees anything,
the agent reads that repository to learn its package manager, its real scripts,
and the installed version of the library being migrated, and injects both those
facts and the vendor's real API surface into the opening message. It then finds
the affected call sites, reads them, applies minimal edits, runs a whitelisted
verification command, checks those edits against the contract, and reports one
of three outcomes (four when the caller prefers drafts):

| Outcome      | Meaning                                                              |
| ------------ | -------------------------------------------------------------------- |
| `auto_pr`    | Files changed, verification passed, and a vendor contract gates it   |
| `review_pr`  | Files changed but needs a human: validation failed, never ran, or no contract |
| `draft_pr`   | Same as `review_pr`, when the caller passed `prMode: "draft"`        |
| `no_action`  | Nothing changed, usually the API is not used                        |

`auto_pr` means the diff is ready for a human. It never means merged.
Without a vendor contract the outcome is capped at `review_pr` (or `draft_pr`
with `prMode: "draft"`): passing tests prove the code runs, but nothing checked
the edits against the vendor's real API surface, so the diff is never automatic.

## Files

- `tools.ts`: the seven tools the model can call, with their JSON schemas.
- `state.ts`: `ChangePacket`, `AgentState`, budgets, and the outcome rules.
- `executor.ts`: the sandbox. Every tool call lands here.
- `publisher.ts`: the pull request path, and the branch guard in front of it.
- `migrationAgent.ts`: the loop. Calls OpenAI, runs tools, applies ceilings.
- `prompt.ts`: the system prompt, including when to stop and report.
- `docsToConfig.ts`: vendor doc to `VendorConfig`, for the parser pipeline.

## The tools

| Tool               | What it does                              |
| ------------------ | ----------------------------------------- |
| `inspectRepo`      | Package manager, dependencies, source tree |
| `searchCode`       | Literal string search, returns `file:line` |
| `readFile`         | File contents with 1-indexed line numbers  |
| `editFile`         | Applies one unified diff                  |
| `replaceInFile`    | Replaces one exact snippet               |
| `runCommand`       | Runs an allowed verification command      |
| `createPullRequest`| Summarises the diff and targets a branch   |

## [shipped] Safety

The agent edits a real repository, so the executor is the boundary.

- `resolveInsideRoot` rejects absolute paths, `~`, and any `..` segment.
- Protected paths are refused: `.env` and variants, `id_rsa`, `*.pem`, `*.key`,
  `*.p12`, `*.pfx`, `.git/config`.
- `editFile` rejects anything that is not a unified diff with `@@` hunks and
  `---`/`+++` headers, then applies it with `git apply` so a bad hunk fails
  loudly instead of corrupting a file.
- `runCommand` is an exact string match against a fixed whitelist (`npm test`,
  `npm run build`, `npm run typecheck`, and pnpm/bun equivalents). Shell
  operators are not accepted, so `npm test && rm -rf /` is refused.
- A whitelisted command is not run on the host. It runs in a Docker container
  against a disposable copy of the repository, with the network off. See
  [Sandboxed command execution](#shipped-sandboxed-command-execution).
- The environment handed to a command is an allowlist. Anything matching
  `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL`, `PRIVATE`, `SESSION`,
  `COOKIE`, or `AUTH` is dropped, so a customer build script cannot read
  `OPENAI_API_KEY` or `GITHUB_TOKEN` out of the DriftLock process.
- `editFile` reads the `+++` headers out of the patch and refuses any patch
  that targets a different file, a protected path, or a path outside the root.
  A declared path the patch does not honour is a refusal, not a silent retarget.
- `editFile` canonicalises the `---`/`+++` header lines to `a/<path>` and
  `b/<path>` and applies with `git apply --recount -p1`, so a diff works
  whether the model writes `src/foo.ts` or `a/src/foo.ts`, and a miscounted
  hunk header is recomputed rather than rejected. One attempt, no silent
  fallbacks, so the error the model sees is always the error git produced.
- `replaceInFile` requires `oldText` to match exactly once. Zero matches and
  multiple matches are separate, explicit errors, so a wrong guess fails loudly
  instead of rewriting the wrong site.
- Search skips `node_modules`, `.git`, `dist`, `build`, `.next`, `coverage`,
  and `.turbo`.
- Outputs are truncated before they enter the transcript.

## [shipped] Why `replaceInFile` exists

Measured against real repositories, the model produces a valid unified diff far
less often than it produces a valid single-line change. The failure mode is
specific: a hunk header that skips a line, a closing brace, or a blank line
between two context lines. That hunk is not a contiguous slice of the file, so
`git apply` rejects it and no combination of flags can rescue it. On a retry
the model commonly re-emits the same shape, or invents a replacement value.

`replaceInFile` removes the part the model gets wrong. It supplies no line
numbers and no hunk body, only text copied from a `readFile` result, and it
refuses anything that is not unique. The diff-based `editFile` is kept for the
case where one contiguous hunk really is the clearest option.

Measured result: on two throwaway repositories, `replaceInFile` took a
migration the diff tool could not complete from 0/2 files edited to 3/3.

## [shipped] Budgets

| Budget            | Limit |
| ----------------- | ----- |
| Iterations        | 15    |
| Commands         | 30    |
| Files changed    | 20    |

Hitting the file ceiling ends the run with `review_pr`. The loop never spends
past its budget, and every refusal is reported back to the model as a tool
result rather than swallowed.

## Usage

```ts
import { createGitHubPublisher, runMigrationAgent } from "@driftlock/agent";

const result = await runMigrationAgent({
    root: "/path/to/checked-out-repo",
    packet: {
        provider: "p5",
        fromVersion: "1.11",
        toVersion: "2.3",
        summary: "createCanvas renamed to createSurface",
        migrationDocs: ["https://example.test/p5-2.3"],
    },
    apiKey: process.env.OPENAI_API_KEY,
    publisher: createGitHubPublisher(process.env.GITHUB_TOKEN),
    target: { owner: "acme", repo: "widgets", base: "main" },
});

result.outcome;         // "auto_pr" | "review_pr" | "draft_pr" | "no_action"
result.filesChanged;    // ["src/client.ts"]
result.state.pullRequest; // { status, url, number, branch } when a PR exists
result.state.transcript;  // full tool conversation
```

Pass `client` to supply your own OpenAI-compatible client, `model` to override
the default `gpt-4o-mini`, and `publisher` plus `target` to actually open a pull
request. With no publisher, `createPullRequest` returns a preview and says so.

## Running against a non-OpenAI provider

Pass `baseURL` to point the loop at any OpenAI-compatible endpoint. Cloudflare
Workers AI is the one this repo ships credentials for:

```ts
const result = await runMigrationAgent({
    root,
    packet,
    apiKey: process.env.CLOUDFLARE_API_TOKEN,
    baseURL: `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`,
    model: process.env.CLOUDFLARE_AI_MODEL,
});
```

Two wire-format details this proved the hard way, both worth knowing for any
compatible endpoint:

- An assistant message that carries `tool_calls` must send `content` as a
  **string**. OpenAI tolerates `null`; Cloudflare rejects the whole request with
  a 400. The agent sends `""`.
- Cloudflare's native `/ai/run/{model}` endpoint has no tool calling at all. Only
  the OpenAI-compatible `/ai/v1` path works for this loop.

## Opening a pull request

`createPullRequest` goes through `@driftlock/git`, so the commit is a pure delta
on the base branch: blobs, then a tree on top of `base_tree`, then a commit, a
ref, and the PR. No checkout, no push, no clone.

It is refused when any of these hold:

- The branch does not start with `driftlock/`. `PRWriter` force-updates whatever
  ref it is handed, so an unvalidated branch name would let the agent rewrite
  `main`. The prefix is enforced here, and traversal and shell characters are
  rejected.
- A verification command has not passed.
- No file changed, or the working tree is clean.
- The title is blank, or `root` is not a git repository.

`FixPRRunner` keeps one open PR per branch, so re-running the same migration
reports `already_open` rather than opening a second one. A merged PR reports
`merged`, which is the signal to rebaseline the snapshot.

## [shipped] Sandboxed command execution

`runCommand` defaults to `createSandboxCommandRunner()`, which runs the command
through `@driftlock/sandbox`:

- The repository is copied to a throwaway temp directory first, and the copy is
  what gets mounted. The real checkout is never passed to Docker, so a build
  script cannot write to it, and `.git` is not copied either.
- The copy is mounted writable (`readOnly: false`), so `tsc` and bundlers can
  emit. The original `node_modules` is bind-mounted read-only when present, so a
  full dependency tree does not have to be copied.
- The network is off (`NetworkMode: none`) and no endpoints are allowlisted.
- The container env is exactly `CI=1`. The host environment is never forwarded.
- The command is passed as argv, never as a shell string, after the whitelist
  check.
- Defaults: `node:22-alpine`, 5 minute timeout, 2 GB, 2 CPUs.
- The temp copy is removed in a `finally`, so a timeout or a Docker error does
  not leak it.

Pass `commandRunner` to `runMigrationAgent` to substitute your own seam, for
example a local `CommandRunner` that skips Docker entirely.

## [planned] Not done yet

- The agent does not create the temporary branch yet. It assumes one exists.
- No confidence signal beyond pass/fail. A richer verdict would feed the
  `auto_pr` threshold rather than hardcode "tests passed".
- The loop has only been proven against Cloudflare Workers AI
  (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`). A representative run against two
  throwaway repositories is recorded in [Real repository runs](#real-repository-runs);
  a wider model sweep is not done.
- The sandbox uses `SandboxRunner`'s proxy allowlist model, but the agent always
  disables the network. A migration that must reach a registry mid-run is not
  supported yet.
- After a failed edit the model sometimes moves on to verification instead of
  fixing the edit. The prompt tells it to retry; nothing enforces it.
- `discoverVendorReceivers` is a regex heuristic. It catches a value assigned
  from a vendor client call or a webhook payload chain, and misses anything
  routed through a factory, a class field, or a rename. Pass
  `VerifyOptions.clientNames` when it does, and expect to.
- The contract gate is not wired to the pipeline's captured traffic yet. Nothing
  converts a `DriftResult` or `DriftAlert` into a contract, so
  `changePacketFromDrift` is written but not yet fed by a live detector.
- `probeLiveContract` is not called from inside `runMigrationAgent`. A caller
  builds the contract and passes it in. That keeps credentials out of the model
  loop, but it also means nobody is probing on a schedule.
- The agent has no way to resolve a vendor symbol it has not been told about. The
  contract gate will correctly refuse `p.keyIsCurrentlyDown`, but the model has
  no tool that turns "I do not know what replaced this" into a cited answer, so
  its only remaining move is another guess. This is the next stage and it is the
  reason the gate currently grades honesty on a board the agent was never given.
- `fingerprintRepo` reads the top-level manifest only. Workspaces, monorepo
  members, and nested packages are not resolved, so a monorepo reports the root
  manifest's scripts and misses a package that has its own. `alsoDetected` is the
  only warning that a polyglot layout exists.
- Only npm, rust, python, and go are parsed. Every other ecosystem is reported as
  `detected`, which means the model is told to go read the manifest itself. There
  is no fallback that tries to guess a manifest format.
- CI command extraction is a regex over `run:` lines. It misses multi-line
  commands, composite actions, and anything expressed as a reusable workflow.
- `verificationCommands` is derived only for npm, rust, and go. Python and Go
  facts are populated, but the derived list is not authoritative for either.

## Real repository runs

Two throwaway repositories, real model, real Docker, no fixtures. Both were
clean on `main` before the run. Drive them with:

```bash
bun --env-file=.env run run-real-migration.ts stripe ../some-repo
bun --env-file=.env run run-real-migration.ts p5 ../some-repo
```

Results, `@cf/meta/llama-3.3-70b-instruct-fp8-fast`:

| Packet | Repo | Edits | Verification | PR |
| ------ | ---- | ----- | ------------ | -- |
| stripe `source` to `payment_method` | two small files | 2/2 files, 3/4 sites | impossible | refused |
| p5 1.x to 2.x keyboard input | one sketch | 1/1 file, 1/2 sites | impossible | refused |

Both runs ended `review_pr` with no pull request, and both refusals were
correct. The two repos have no `node_modules` and the sandbox has no network, so
`npm run build` exits 127 and the verification gate can never be satisfied. The
gate refusing to publish is the designed behaviour, not a defect.

The interesting part is what the gate caught. The p5 edit was syntactically
plausible and semantically wrong: the model wrote

```js
if (p.keyIsDown(UP_ARROW)) {
```

inside an instance-mode sketch where every other line uses the `p.` prefix. In
instance mode constants are only reachable through the instance, so that throws
`ReferenceError: UP_ARROW is not defined` on the first frame. Nothing but
running the code would have caught it, and the PR gate is what kept it from
being published. Two further defects showed up here:

- The model migrated `p.keyCode === 38` but left `p.key === " "` alone, so the
  migration is incomplete without the diff showing it as such.
- On stripe it edited the first of two `paymentIntent.source` sites, then moved
  on. The remaining site is visible in `git diff`, but nothing told the model.

Read together: the tool boundary is solid, and the model's API knowledge and
completeness are the weak links. The verification gate was the only thing
standing between a wrong migration and a merged one.

### What the contract gate does with those exact bugs

Both defects above are now caught deterministically, offline, with no model in
the loop. `integration/agent/vendorContractLive.test.ts` fetches p5's real
published reference (866 classitems, 243 constants) and runs the gate against
the verbatim sketch the model wrote:

```
1 pass  findings: 1
  kind:    unbound-constant
  symbol:  UP_ARROW
  detail:  UP_ARROW is a member of the p5 instance, not a global. Write p.UP_ARROW.
```

The same test also runs a realistic instance-mode sketch, including `p.setup =`
and `p.draw =` lifecycle assignments, and asserts zero findings. A gate that
fires on correct code is worse than no gate, so the quiet case is tested as
seriously as the loud one.

The stripe case is the `stale` path. `integration/agent/contractGate.test.ts`
migrates one of two `paymentIntent.source` sites, leaves a second file untouched,
and asserts the PR is refused with the finding pointing at the file the model
never opened.

## Tests

```bash
bun test --cwd packages/tests unit/agent/
bun test --cwd packages/tests integration/agent/
```

`unit/agent/vendorContract.test.ts` covers the contract machinery, including the
two real bugs as fixtures. `unit/agent/repoFacts.test.ts` covers the fingerprint
across npm, cargo, python, and go, including the malformed-manifest path.
`integration/agent/contractGate.test.ts` drives the whole agent with a stub model
and asserts the gate refuses the PR. None of these need credentials or a network.

`integration/agent/vendorContractLive.test.ts` is the one that talks to real
vendors: it fetches p5's reference dump, probes a live JSON API, and reads
Stripe's published OpenAPI. It is not mocked, because the whole claim is that the
contract reflects the vendor rather than our idea of the vendor. Each test skips
loudly if the network is unavailable.

`unit/agent` covers path guards, patch validation, command whitelist rejection,
the full inspect to PR walk against a real temp git repo, and each outcome
branch.

`integration/agent/sandboxIsolation.test.ts` is the one that proves the
isolation claims. It needs a running Docker daemon and it skips itself with a
loud failing prerequisite test when there is not one. It asserts against a real
`node:22-alpine` container that a build cannot write to the real checkout, cannot
resolve DNS, cannot see `.git`, and cannot read `OPENAI_API_KEY` out of the host
environment.

`integration/agent/liveModel.test.ts` runs the whole loop against a real model
and is skipped unless Cloudflare credentials are present. It needs the env file
loaded explicitly, because the test runs from `packages/tests`:

```bash
bun test --env-file=../../.env integration/agent/liveModel.test.ts
```

It asserts the wire contract rather than the migration succeeding: every
`tool_call` must get a matching `tool` result, every message must carry a string
`content`, and the outcome must be one of the three. A representative run
against `@cf/meta/llama-3.3-70b-instruct-fp8-fast`:

```
outcome: auto_pr
iterations: 7 / 15
tool calls: inspectRepo -> searchCode -> readFile -> editFile -> runCommand -> runCommand -> createPullRequest
files changed: src/client.ts
verification passed: true
```

The PR publisher is a stub in that test, so no real pull request is opened.


