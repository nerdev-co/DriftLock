import { describe, expect, test, mock } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { InMemorySchemaStore } from "../schemaStore";
import { DriftDetector } from "../driftDetector";
import { flattenPayload } from "../schemaFlattener";
import { diffSchemas } from "../schemaDiff";
import { isValidAIFix } from "../prCreator";
import { generateAIFixSync, type FixContext } from "@driftlock/aiFix";

function tmpRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "driftlock-webhook-pr-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    return dir;
}

describe("AI fix syntax validation", () => {
    const rename = {
        kind: "field_rename" as const,
        field: "source",
        from: "source",
        to: "payment_method",
        description: "Rename source to payment_method",
        template: "rename",
        confidence: "high" as const,
    };

    for (const [filePath, code] of [
        ["handler.ts", 'import type { Payment } from "./types"; export const id = (payment: Payment) => payment.payment_method as string;'],
        ["handler.tsx", 'export const View = ({ payment }: { payment: any }) => <div>{payment.payment_method}</div>;'],
        ["handler.jsx", 'export const View = ({ payment }) => <div>{payment.payment_method}</div>;'],
        ["handler.js", 'export const id = payment.payment_method;'],
        ["handler.mjs", 'import payment from "./payment.mjs"; export const id = payment.payment_method;'],
        ["handler.cjs", 'module.exports = payment.payment_method;'],
    ]) {
        test(`accepts valid source in ${filePath}`, () => {
            expect(isValidAIFix(code, [rename], "const id = payment.source;", filePath)).toBe(true);
        });
    }

    test("rejects malformed source and TypeScript in a JavaScript file", () => {
        expect(isValidAIFix("export const id = (", [], "original", "handler.ts")).toBe(false);
        expect(isValidAIFix("export const id: string = 'pm_123';", [], "original", "handler.js")).toBe(false);
    });

    test("keeps semantic and unchanged-source guards", () => {
        const code = "export const id = payment.source;";
        expect(isValidAIFix(code, [rename], "original", "handler.ts")).toBe(false);
        expect(isValidAIFix("export const id = payment.other;", [rename], code, "handler.ts")).toBe(false);
        expect(isValidAIFix(code, [], code, "handler.ts")).toBe(false);
    });

    test("does not execute generated code", () => {
        expect(isValidAIFix('throw new Error("must not execute");', [], "original", "handler.js")).toBe(true);
    });
});

describe("AI fix invented object-literal keys", () => {
    const rename = {
        kind: "field_rename" as const,
        field: "source",
        from: "source",
        to: "payment_method",
        description: "Rename source to payment_method",
        template: "rename",
        confidence: "high" as const,
    };
    const original = 'const c = await stripe.charges.create({ amount: 100, source: "tok_visa" });';

    // The access check only sees `a.b` and `a["b"]`, so a bare key next to a
    // correct rename used to be accepted. The comment sniff at the top of
    // isValidAIFix was the only other guard, and it is bypassed by not commenting.
    for (const [name, fixed] of [
        ["identifier key", 'const c = await stripe.charges.create({ amount: 100, payment_method: "pm", paymentMethod: "pm" });'],
        ["quoted key", 'const c = await stripe.charges.create({ amount: 100, payment_method: "pm", "paymentMethod": "pm" });'],
        ["unrelated key", 'const c = await stripe.charges.create({ amount: 100, payment_method: "pm", customer_email: "a@b.c" });'],
    ] as const) {
        test(`rejects an invented ${name}`, () => {
            expect(isValidAIFix(fixed, [rename], original, "handler.ts")).toBe(false);
        });
    }

    for (const [name, code] of [
        ["clean rename", 'const c = await stripe.charges.create({ amount: 100, payment_method: "pm" });'],
        ["shorthand reference", 'const payment_method = "pm"; const c = await stripe.charges.create({ amount: 1, payment_method });'],
        ["switch default and label", 'switch (1) { default: { payment_method: "pm" } } out: for (;;) { break out; }'],
        ["method shorthand and computed key", 'const c = await stripe.charges.create({ amount: 1, get amt() { return 1 }, ["payment_method"]: "pm" });'],
        ["commented-out key", '// paymentMethod: "invented"\nconst c = await stripe.charges.create({ amount: 1, payment_method: "pm" });'],
    ] as const) {
        test(`accepts ${name}`, () => {
            expect(isValidAIFix(code, [rename], original, "handler.ts")).toBe(true);
        });
    }

    test("accepts a ternary value", () => {
        const before = 'const c = await stripe.charges.create({ amount: 1, source: "s", flag: x ? 1 : 2 });';
        const after = 'const c = await stripe.charges.create({ amount: 1, flag: x ? 1 : 2, payment_method: "pm" });';
        expect(isValidAIFix(after, [rename], before, "handler.ts")).toBe(true);
    });

    test("accepts a type literal, which is not an invented field", () => {
        const code = 'export const View = ({ payment }: { payment: any }) => <div>{payment.payment_method}</div>;';
        expect(isValidAIFix(code, [rename], "const id = payment.source;", "handler.tsx")).toBe(true);
    });

    test("accepts a rename that preserves existing nested keys", () => {
        const before = 'const c = await stripe.charges.create({ amount: 100, source: "s", metadata: { order_id: "9" } });';
        const after = 'const c = await stripe.charges.create({ amount: 100, metadata: { order_id: "9" }, payment_method: "pm" });';
        expect(isValidAIFix(after, [rename], before, "handler.ts")).toBe(true);
    });
});

describe("AI fix validator regressions", () => {
    function makeContext(
        sourceCode = "export const id = payment.source;\n",
        to = "payment_method",
    ): FixContext {
        return {
            diff: {
                addedFields: [to],
                removedFields: ["source"],
                typeChanges: [],
                optionalityChanges: [],
                breakingChanges: [],
                nonBreakingChanges: [],
                confidence: "high",
                changes: [],
            },
            works: [{
                kind: "field_rename",
                field: "source",
                from: "source",
                to,
                description: `Rename source to ${to}`,
                template: "rename",
                confidence: "high",
            }],
            sourceCode,
            filePath: "handler.ts",
        };
    }

    function validateResponse(ctx: FixContext, response: string): boolean {
        const result = generateAIFixSync(ctx, response);
        return isValidAIFix(result.fixedCode, ctx.works, ctx.sourceCode, ctx.filePath);
    }

    function validateCode(ctx: FixContext, code: string): boolean {
        return validateResponse(ctx, `\`\`\`typescript\n${code}\n\`\`\`\nConfidence: 95`);
    }

    test("rejects PR #3 bad output through the production validator", () => {
        const ctx = makeContext(`const Stripe = require('stripe');
const stripe = Stripe('sk_test_123');

async function createPayment(amount, currency) {
  const paymentIntent = await stripe.paymentIntents.create({ amount, currency });
  return {
    amount: paymentIntent.amount,
    currency: paymentIntent.currency,
    status: paymentIntent.status,
    source: paymentIntent.source,
    client_secret: paymentIntent.client_secret,
  };
}
`);
        const badOutput = `\`\`\`typescript
const Stripe = require('stripe');
const stripe = Stripe('sk_test_123');

async function createPayment(amount, currency) {
  const paymentIntent = await stripe.paymentIntents.create({
    amount,
    currency,
  });
  return {
    amount: paymentIntent.amount,
    currency: paymentIntent.currency,
    status: paymentIntent.status,
    paymentMethod: paymentIntent.payment_method, // Added new field
    client_secret: paymentIntent.client_secret,
  };
}
\`\`\`

Changed source to payment_method.
Confidence: 85`;

        expect(validateResponse(ctx, badOutput)).toBe(false);
    });

    test("accepts clean output through the production validator", () => {
        const ctx = makeContext(`const stripe = new Stripe("sk_test");

export async function createCharge(amount: number) {
    return stripe.charges.create({ amount, source: "tok_visa" });
}
`);
        const cleanOutput = `\`\`\`typescript
const stripe = new Stripe("sk_test");

export async function createCharge(amount: number) {
    return stripe.charges.create({ amount, payment_method: "pm_123" });
}
\`\`\`

Changed the removed field to the new required field.
Confidence: 95`;

        expect(validateResponse(ctx, cleanOutput)).toBe(true);
    });

    for (const access of [
        "payment.paymentMethod",
        "payment?.paymentMethod",
        'payment["paymentMethod"]',
        "payment['paymentMethod']",
    ]) {
        test(`rejects mixed exact field and invented ${access}`, () => {
            const code = `export const id = payment.payment_method; export const method = ${access};`;
            expect(validateCode(makeContext(), code)).toBe(false);
        });
    }

    test("derives the camelCase name from a non-payment rename target", () => {
        const ctx = makeContext("export const id = customer.source;\n", "billing_address");
        expect(validateCode(ctx, "export const id = customer.billing_address; export const address = customer.billingAddress;")).toBe(false);
        expect(validateCode(ctx, "export const id = customer.billing_address;")).toBe(true);
    });

    test("preserves a preexisting local alias and output property", () => {
        const ctx = makeContext("const paymentMethod = payment.source; export const view = { paymentMethod };\n");
        expect(validateCode(ctx, "const paymentMethod = payment.payment_method; export const view = { paymentMethod };")).toBe(true);
    });

    test("preserves a preexisting destructuring alias", () => {
        const ctx = makeContext("const { source: paymentMethod } = payment; export { paymentMethod };\n");
        expect(validateCode(ctx, "const { payment_method: paymentMethod } = payment; export { paymentMethod };")).toBe(true);
    });

    test("preserves a preexisting camelCase property on the same receiver", () => {
        const ctx = makeContext("export const id = payment.source; export const method = payment.paymentMethod;\n");
        expect(validateCode(ctx, "export const id = payment.payment_method; export const method = payment.paymentMethod;")).toBe(true);
    });

    test("preserves preexisting property accesses across formatting and optional chaining", () => {
        const ctx = makeContext("export const id = payment.source; export const method = view.paymentMethod;\n");
        expect(validateCode(ctx, 'export const id = payment.payment_method; export const method = view ?. ["paymentMethod"];')).toBe(true);
    });

    test("an existing alias on another object does not excuse an invented access", () => {
        const ctx = makeContext("export const id = payment.source; export const method = view.paymentMethod;\n");
        const code = "export const id = payment.payment_method; export const method = view.paymentMethod; export const invented = payment.paymentMethod;";
        expect(validateCode(ctx, code)).toBe(false);
    });
});

describe("Webhook drift → fix chain (unit)", () => {
    test("flatten → diff → detect → works generation", async () => {
        const store = new InMemorySchemaStore();
        const detector = new DriftDetector(store);

        await detector.processPayload("stripe", "payment_intent.succeeded", {
            id: "pi_123",
            amount: 2000,
            source: "tok_visa",
        });

        const alert = await detector.processPayload(
            "stripe",
            "payment_intent.succeeded",
            {
                id: "pi_123",
                amount: 2000,
                payment_method: "pm_123",
            },
        );

        expect(alert).not.toBeNull();
        expect(alert!.diff.added).toContain("payment_method");
        expect(alert!.diff.removed).toContain("source");
    });

    test("generates fix works from schema diff", async () => {
        const previous = flattenPayload({
            amount: 2000,
            source: "tok_visa",
        });
        const current = flattenPayload({
            amount: 2000,
            payment_method: "pm_123",
        });

        const diff = diffSchemas(previous, current);
        expect(diff.removed).toEqual(["source"]);
        expect(diff.added).toEqual(["payment_method"]);
    });

    test("applies field rename fix to source code", async () => {
        const { applyFixWork } = await import("@driftlock/diff");

        const source = `
const charge = await stripe.charges.create({
    amount: 2000,
    source: "tok_visa",
});
return charge.source;
`;

        const work = {
            kind: "field_rename" as const,
            field: "source",
            from: "source",
            to: "payment_method",
            description: "Rename source to payment_method",
            template: "rename source to payment_method",
            confidence: "high" as const,
        };

        const fixed = applyFixWork(work, source);
        expect(fixed).not.toBeNull();
        expect(fixed).toContain("payment_method: \"tok_visa\"");
        expect(fixed).not.toContain("source: \"tok_visa\"");
        expect(fixed).toContain("charge.payment_method");
    });

    test("scans repo for affected files containing old field", () => {
        const repo = tmpRepo();
        writeFileSync(
            join(repo, "src", "handler.ts"),
            `
export function handlePayment(event: any) {
    const id = event.data.object.source;
    return id;
}
`,
        );
        writeFileSync(
            join(repo, "src", "unrelated.ts"),
            `
export const source = "constant";
`,
        );

        const affectedFiles: string[] = [];
        const files = require("fs").readdirSync(repo, { recursive: true });
        for (const file of files) {
            if (typeof file !== "string") continue;
            if (!/\.(ts|tsx|js)$/.test(file)) continue;
            if (file.includes("node_modules")) continue;
            const content = readFileSync(join(repo, file), "utf8");
            if (/\bsource\b/.test(content)) {
                affectedFiles.push(file);
            }
        }

        expect(affectedFiles).toContain("src/handler.ts");
        expect(affectedFiles).toContain("src/unrelated.ts");
    });

    test("end-to-end: detect drift then apply fix to repo", async () => {
        const repo = tmpRepo();
        writeFileSync(
            join(repo, "src", "stripe-handler.ts"),
            `
import Stripe from "stripe";
const stripe = new Stripe("sk_test");

export async function createCharge(amount: number) {
    const result = await stripe.charges.create({
        amount,
        source: "tok_visa",
    });
    return result.source;
}
`,
        );

        const store = new InMemorySchemaStore();
        const detector = new DriftDetector(store);

        await detector.processPayload("stripe", "charge.created", {
            amount: 2000,
            source: "tok_visa",
        });

        const alert = await detector.processPayload(
            "stripe",
            "charge.created",
            {
                amount: 2000,
                payment_method: "pm_123",
            },
        );

        expect(alert).not.toBeNull();

        const { applyFixWork } = await import("@driftlock/diff");
        const source = readFileSync(
            join(repo, "src", "stripe-handler.ts"),
            "utf8",
        );

        const renameWork = {
            kind: "field_rename" as const,
            field: "source",
            from: "source",
            to: "payment_method",
            description: "Rename source to payment_method",
            template: "rename",
            confidence: "high" as const,
        };

        const fixed = applyFixWork(renameWork, source);
        expect(fixed).not.toBeNull();
        expect(fixed).toContain("payment_method: \"tok_visa\"");
        expect(fixed).not.toContain("source: \"tok_visa\"");
        expect(fixed).toContain("result.payment_method");
    });
});
