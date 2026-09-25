# ADR 002: Webhook-First Wedge

## Status
Accepted

## Context
Routebase and mendapi both target outbound REST calls well. Outbound has specs, versioning, and existing diff tooling. DriftLock tried to be "all APIs" early, which diluted focus and led to the `source` → `payment_method` comment-out fix — the fix logic had no semantic model of webhook payloads.

Inbound webhooks are structurally different:
- You don't own the API; you receive `POST /webhooks/stripe` with an event payload.
- Rarely a usable OpenAPI for the exact event shape your code consumes.
- Vendor can add/remove fields silently; your handler breaks in production.

This is also where DriftLock's runtime observation wins most: the only contract is what the vendor actually sends and what your handler reads (`data.object.source`).

Stripe is the ideal first vertical: large target ICP (subscription SaaS), webhook-heavy, and we already have a reproducing fixture (`stripe-test`).

## Decision
Make **Stripe inbound webhooks** the first wedge. Not "all providers eventually" as a roadmap slide, but the only slice we try to make perfect for the next sprint.

Scope: `POST /webhooks/stripe` handlers that read `event.data.object.<field>`.

Out of scope for this wedge: generic REST outbound diffing beyond Stripe webhooks, 20-provider expansion, pricing/billing UI.

## Consequences

### Positive
- Narrow enough to build the full loop: observe → dependency graph → drift → fix → verify → PR with evidence.
- Clear demo story vs Routebase ("no spec needed").

### Negative
- Deliberately not chasing the broader market until wedge is proven.

### Risks
- Stripe-specific implementation could leak into generic architecture.

## Alternatives Considered
| Alternative | Pros | Cons | Why Not Chosen |
|-------------|------|------|----------------|
| 20 providers first | Marketing breadth | No depth; can't show verified fix | Defers hard problem |
| REST outbound first | Larger surface | Competes head-on with Routebase where spec exists | Less differentiated |
| Pricing/dashboard first | Revenue signal | Premature without evidence of fix correctness | Skillset progress-guard warns against this |

## Implementation Notes
- `apps/webhook/capture.ts` lazy detector + `InMemorySchemaStore`
- `packages/webhookCapture/schemaFlattener.ts` + `schemaDiff.ts` → `added/removed/typeChanged`
- CLI: `driftlock capture` / `driftlock diff` should be exercised only via webhook path this sprint.

## References
- ADR 001
- `10.md` lines on per-call-site contracts and API coverage

---
*Created: 2026-09-24*
