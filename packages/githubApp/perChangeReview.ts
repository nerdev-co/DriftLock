/**
 * Per-change review — inspired by OASDiff 755-check exhaustive model + hosted PR review
 * Source: https://www.oasdiff.com/ + https://github.com/oasdiff/oasdiff + docs/openapi-changes-model
 * What to adapt: exhaustive breaking-change enumeration, fingerprint, per-change approve/reject with commit status
 * How in DriftLock: extends report.ts whole-PR verdict to per-change review, fingerprints via receipts.ts changeIRHash
 */

import type { SpecChange } from "@driftlock/diff/spec";

export interface ChangeReview {
  id: string; // fingerprint e.g., sha256:abcd...
  change: SpecChange;
  severity: "breaking" | "warning" | "info";
  approvedBy?: string;
  status: "pending" | "approved" | "rejected";
}

export function toPerChangeReviews(changes: SpecChange[], fingerprints: string[]): ChangeReview[] {
  return changes.map((c, i) => ({
    id: fingerprints[i] ?? `fp-${i}`,
    change: c,
    severity: c.breaking ? "breaking" : "warning",
    status: "pending" as const,
  }));
}

export function renderPerChangeComment(reviews: ChangeReview[]): string {
  const breaking = reviews.filter((r) => r.severity === "breaking");
  const pending = reviews.filter((r) => r.status === "pending").length;
  return [
    `### 🔴 ${breaking.length} breaking · ⏳ ${pending} pending review`,
    ...reviews.map((r) => `- [${r.severity}] \`${r.change.kind}\` ${r.change.field ?? r.change.endpoint} — ${r.status}`),
  ].join("\n");
}
