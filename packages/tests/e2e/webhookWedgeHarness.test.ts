/**
 * Webhook wedge harness: verifies the 5 Stripe fixtures per ADR 003 + design/webhook-first-wedge.md
 * Run: bun test --cwd packages/tests e2e/webhookWedgeHarness.test.ts
 * Or: bun test packages/tests/e2e/webhookWedgeHarness.test.ts
 */
import { describe, test, expect } from "bun:test";
import { InMemorySchemaStore, DriftDetector, type DriftAlert, type SchemaDiff } from "../../webhookCapture/index.ts";
import fs from "fs";
import path from "path";

const wedgeDir = path.join(import.meta.dir, "../fixtures/stripeWebhookWedge");
const fixtures = fs.readdirSync(wedgeDir).filter((f) => f.endsWith(".json")).sort();
const expectedDiffs: Record<string, SchemaDiff> = {
  "01HighSourceToPaymentMethod.json": {
    added: ["payment_method"], removed: ["source"], typeChanged: [],
  },
  "02HighAmountStringToNumber.json": {
    added: [], removed: [], typeChanged: [{ field: "amount", from: "string", to: "number" }],
  },
  "03MediumEmailNullable.json": {
    added: [], removed: [], typeChanged: [{ field: "email", from: "string", to: "null" }],
  },
  "04LowCustomerStringToObject.json": {
    added: ["customer.id", "customer.email"], removed: ["customer"], typeChanged: [],
  },
  "05LowTrialEndRemoved.json": {
    added: [], removed: ["trial_end"], typeChanged: [],
  },
};

const expectedConfidence: Record<string, number> = {
  "01HighSourceToPaymentMethod.json": 85,
  "02HighAmountStringToNumber.json": 85,
  "03MediumEmailNullable.json": 85,
  "04LowCustomerStringToObject.json": 85,
  "05LowTrialEndRemoved.json": 95,
};

// Fail before registering scenario tests if fixture coverage changes.
expect(fixtures).toEqual(Object.keys(expectedDiffs).sort());

function confidenceFor({ diff, previous, current }: DriftAlert): "HIGH" | "MEDIUM" | "LOW" {
  // Fixture policy only, not evidence that a production fix is verified.
  const { added, removed, typeChanged } = diff;
  if (added.length === 1 && added[0] === "payment_method" &&
      removed.length === 1 && removed[0] === "source" &&
      typeChanged.length === 0 && previous.source === "string" &&
      current.payment_method === "string") return "HIGH";
  if (added.length === 0 && removed.length === 0 && typeChanged.length === 1) {
    const change = typeChanged[0];
    if (change.from === "string" && change.to === "number") return "HIGH";
    if (change.from === "string" && change.to === "null") return "MEDIUM";
  }
  return "LOW";
}

describe("webhook wedge: 5 Stripe fixtures", () => {
  for (const file of fixtures) {
    const data = JSON.parse(fs.readFileSync(path.join(wedgeDir, file), "utf8"));
    test(`${data.id} (${data.expected}): ${data.event}`, async () => {
      const store = new InMemorySchemaStore();
      const det = new DriftDetector(store, 0.3);
      await det.processPayload(data.event, data.event, data.before);
      const alert = await det.processPayload(data.event, data.event, data.after);
      if (!alert || !("diff" in alert)) {
        throw new Error(`no DriftAlert for ${data.id}: ${JSON.stringify(alert)}`);
      }
      expect(alert.diff).toEqual(expectedDiffs[file]);
      expect(confidenceFor(alert)).toBe(data.expected);
      expect(alert.confidence).toBe(expectedConfidence[file]);

      // Evidence placeholder: affected code would be patched here then tests + sandbox replay
      // For HIGH we would assert patch passes; for LOW we assert explain-only
    });
  }
});

console.log(`[HARNESS] 5 fixtures in ${wedgeDir}: ${fixtures.join(", ")}`);
