import type { SpecChange, SpecDiffSummary } from "@driftlock/diff/spec";
import type { VerdictReceipt } from "@driftlock/diff/receipts";
import { toPerChangeReviews, renderPerChangeComment } from "./perChangeReview";

export type GovernanceVerdict = "ALLOW" | "WARN" | "REQUIRE_APPROVAL" | "BLOCK";

export interface GovernanceReport {
  verdict: GovernanceVerdict;
  summary: SpecDiffSummary;
  receipt: VerdictReceipt;
  policyViolations: string[];
  changelog: { breaking: string[]; added: string[]; changed: string[]; deprecated: string[] };
}

export function decideVerdict(s: SpecDiffSummary, violations: string[]): GovernanceVerdict {
  if (violations.some((v) => v.includes("block"))) return "BLOCK";
  if (s.riskScore.overall >= 70) return "BLOCK";
  if (s.riskScore.overall >= 40) return "REQUIRE_APPROVAL";
  if (s.breakingChanges.length > 0) return "WARN";
  return "ALLOW";
}

export function buildPrComment(r: GovernanceReport): string {
  const emoji = r.verdict === "BLOCK" ? "🛑" : r.verdict === "WARN" ? "⚠️" : "✅";
  const perChange = r.summary.changes.length > 1
    ? renderPerChangeComment(
        toPerChangeReviews(
          r.summary.changes as SpecChange[],
          r.summary.changes.map((_, i) => `${r.receipt.changeIRHash}-${i}`),
        ),
      )
    : "";
  return [
    `## ${emoji} DriftLock Governance — ${r.verdict}`,
    ``,
    `**Risk ${r.summary.riskScore.overall}/100** (revenue:${r.summary.riskScore.dimensions.revenue} blast:${r.summary.riskScore.dimensions.blast_radius} compat:${r.summary.riskScore.dimensions.app_compatibility} sec:${r.summary.riskScore.dimensions.security}) → \`${r.summary.riskScore.recommendation}\``,
    ``,
    r.summary.breakingChanges.length ? `**Breaking (${r.summary.breakingChanges.length})**\n${r.summary.breakingChanges.map((c) => `- ${c}`).join("\n")}` : `No breaking changes.`,
    perChange ? `\n${perChange}\n` : "",
    r.policyViolations.length ? `**Policy violations**\n${r.policyViolations.map((v) => `- ${v}`).join("\n")}` : ``,
    ``,
    `**Changelog** — Breaking: ${r.changelog.breaking.length}, Added: ${r.changelog.added.length}, Changed: ${r.changelog.changed.length}`,
    ``,
    `<details><summary>Receipt</summary>\n\n\`verdict:${r.receipt.verdictFingerprint.slice(0,12)}…\` \`ir:${r.receipt.changeIRHash.slice(0,12)}…\` \`key:${r.receipt.receiptKey}\` ${r.receipt.issued}\n\nVerify: \`bun run verify ${r.receipt.verdictFingerprint}\`\n</details>`,
    ``,
    `*Confidence: ${r.summary.confidence} — ${r.summary.riskScore.reasoning}*`,
  ]
    .filter(Boolean)
    .join("\n");
}
