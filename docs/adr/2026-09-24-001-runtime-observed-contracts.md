# ADR 001: Runtime-Observed Contracts over Vendor-Announced Changes

## Status
Accepted

## Context
DriftLock was started from YC's "Self-Maintaining APIs" RFS: an agent scans customer codebases and opens a PR when a provider like Stripe changes. The initial implementation tried to detect drift by scanning code and suggesting fixes, but the live demo PR (`NalinDalal/stripe-test#2`) revealed a core flaw:

Stripe webhook `payment_intent.succeeded` changed `data.object.source` → `data.object.payment_method`. DriftLock detected the diff but the auto-fix was `// source: paymentIntent.source` (comment-out), not a migration to `payment_method`. CodeRabbit rated it "minimal risk" because commenting out is low-risk, but downstream consumers silently lost data.

Competitors already occupy adjacent positions:
- **Routebase** — OpenAPI-spec-first, continuous live-response validation, MCP, broader API lifecycle.
- **mendapi/SelfHeal-API** — vendor-change-intel → AST scan → migration packs (20 providers).

If DriftLock only detects drift, it is commoditized. If it deletes usage, it is untrustworthy. The wedge must be verifiable correctness of the migration, not breadth of providers.

Evidence that vendor docs diverge from behavior also exists (mendapi notes incorrect breaking vs non-breaking in changelogs). Trusting announcements is insufficient.

## Decision
DriftLock will treat **runtime-observed behavior** as the source of truth, not vendor changelogs or static OpenAPI alone.

1. Run customer's real sandbox/test traffic through a capture proxy.
2. Infer a per-call-site contract: `request shape → endpoint → response schema (fields, types, enums, values)`.
3. Snapshot and compare `Snapshot #1 vs #2` to detect behavioral drift.
4. Only after that, consult vendor docs as secondary corroboration.

This is **not** spec-free idealism — if a spec exists we still use it — but the observed contract is primary.

## Consequences

### Positive
- Works without vendor cooperation; catches undocumented field removals (webhooks rarely have useful OpenAPI).
- Gives a before/after evidence chain: `vendor behavior → your dependency → reproduced failure → fix → verification`.
- Enables "API coverage" (monitored vs mocked vs untested) as a persistent product reason to stay installed.

### Negative
- Requires sandbox execution + traffic capture infrastructure (Docker, proxy, test classification).
- Higher per-repo setup than pure changelog polling.
- Must handle test doubles: mocked tests produce no observable contract.

### Risks
- Flaky sandbox runs if customer tests need secrets/network.
- Mis-inferring a contract from a single mocked sample.

## Alternatives Considered
| Alternative | Pros | Cons | Why Not Chosen |
|-------------|------|------|----------------|
| Changelog-first (mendapi) | No sandbox, easy to scale to 20 providers | Misses undocumented drift; trusts vendor correctness | Complements us, but not our primary wedge |
| OpenAPI-diff-only (Routebase) | Clean when spec exists | Most webhook payloads have no spec; misses code-level dependency | Good for REST, not for inbound webhooks |
| Pure LLM patch | Flexible | Hallucinates semantic equivalence (see `source` → `payment_method` failure) | Must be gated by verification |

## Implementation Notes
- `packages/pipeline` → `extractShapesFromCaptures`, `buildDriftResult`, `FileSnapshotStore`
- `packages/diff/spec.ts` → `SpecChangeKind` taxonomy, `RiskScore`
- Future: `packages/rulesEngine` mock-vs-real detector (`jest.mock("stripe")` → BLIND)

## References
- YC RFS "Self-Maintaining APIs" (verbatim in README.md)
- `NalinDalal/stripe-test#2` — detected `source` removed, `payment_method` added, fix was comment-out
- Routebase live demo + mendapi architecture notes (2026-09-23 research)
- Pasted `10.md` + skillset `NalinDalal/skillset` (69 skills)

## Related ADRs
- ADR 002: Webhook-First Wedge
- ADR 003: Confidence-Gated PRs

---
*Created: 2026-09-24*
