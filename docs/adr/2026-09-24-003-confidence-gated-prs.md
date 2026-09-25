# ADR 003: Confidence-Gated PRs with Verification Loop

## Status
Accepted

## Context
The `stripe-test#2` PR proved that opening a PR without verification is harmful. If DriftLock says `source` → comment-out and tests still pass (because they are mocked), the developer merges a silent data loss.

Autonomous tools that sometimes break semantics are dangerous. Trust comes from evidence, not autonomy claims.

## Decision
Every drift → PR path must be **confidence-gated** and **verified**:

```
Drift diff → affected code → migration hypothesis → patch → run affected tests → sandbox/API replay → evidence → confidence → PR
```

Three outcomes:
- **HIGH** — fix + verify + open PR automatically
- **MEDIUM** — candidate patch + verification + PR marked `review-required`
- **LOW** — explain impact, do **not** modify production code; surface mapping `removed: source → candidate: payment_method (LOW, different semantics) → human review`

Verification is mandatory before PR. PR body must contain:
- Detected: `Stripe payment_intent.source removed, payment_method added`
- Affected: `src/payment.js:42`, `src/webhook.js:19`
- Before/After: `3 tests passed` + `1 sandbox integration passed`
- Confidence: `HIGH/MEDIUM/LOW` + reason

## Consequences

### Positive
- Eliminates "comment-out" class of fixes; forces semantic reasoning.
- Makes the PR self-explanatory; reviewer sees why the patch is believed safe.
- Enables the "when NOT to fix" trust advantage.

### Negative
- Slower than LLM → PR; requires test + sandbox harness.

### Risks
- Tests that are mocked will not provide verification signal — ties to API coverage (ADR 001).

## Alternatives Considered
| Alternative | Pros | Cons | Why Not Chosen |
|-------------|------|------|----------------|
| Always open PR | Feels autonomous | Low-trust, as seen | Rejected |
| Never auto-fix | Safe | No value | Rejected |
| LLM-only fix | Fast | Hallucinates | Gated instead |

## Implementation Notes
- `packages/pipeline` `FileSnapshotStore`, `driftConfidence`, `driftSummary`
- `packages/rulesEngine` mock-vs-real detector feeds confidence.
- PR creation via `packages/git` + `FixPRRunner` must include evidence markdown.

## References
- CodeRabbit rating on `stripe-test#2` + docstring coverage gap (0% vs 80%)
- Skillset `verification-loop`

---
*Created: 2026-09-24*
