import { afterEach, describe, expect, test } from "bun:test";
import {
    generateAIFix,
    generateAIFixSync,
    type FixContext,
    type AIFixConfig,
} from "../index";
import type { FixWork, ShapeDiffResult } from "@driftlock/diff";
import { applyFixWork } from "@driftlock/diff";

const originalFetch = globalThis.fetch;
const mockAIResponse = `\`\`\`typescript
const stripe = new Stripe("sk_test");

export async function createCharge(amount: number) {
    return stripe.charges.create({ amount, payment_method: "pm_123" });
}
\`\`\`

Changed the removed field to the new required field.
Confidence: 95`;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

function installFetch(response: Response): () => {
    url: string;
    init?: RequestInit;
} {
    let url = "";
    let init: RequestInit | undefined;
    globalThis.fetch = async (input, requestInit) => {
        url = input.toString();
        init = requestInit;
        return response;
    };
    return () => ({ url, init });
}

function makeContext(
    overrides: Partial<FixContext> = {},
): FixContext {
    const diff: ShapeDiffResult = {
        addedFields: ["payment_method"],
        removedFields: ["source"],
        typeChanges: [],
        optionalityChanges: [],
        breakingChanges: [],
        nonBreakingChanges: [],
        confidence: "high",
        changes: [],
    };

    const works: FixWork[] = [
        {
            kind: "field_rename",
            field: "source",
            from: "source",
            to: "payment_method",
            description: "Rename source to payment_method",
            template: "rename",
            confidence: "high",
        },
    ];

    const sourceCode = `
import Stripe from "stripe";
const stripe = new Stripe("sk_test");

export async function createCharge(amount: number) {
    const result = await stripe.charges.create({
        amount,
        source: "tok_visa",
    });
    return result.source;
}
`;

    return {
        diff,
        works,
        sourceCode,
        filePath: "src/stripe-handler.ts",
        eventType: "charge.created",
        ...overrides,
    };
}

describe("generateAIFixSync", () => {
    test("extracts code from markdown block", () => {
        const mockResponse = `\`\`\`typescript
import Stripe from "stripe";
const stripe = new Stripe("sk_test");

export async function createCharge(amount: number) {
    const result = await stripe.charges.create({
        amount,
        payment_method: "pm_123",
    });
    return result.payment_method;
}
\`\`\`

Changed \`source\` to \`payment_method\` to match the new schema.
Confidence: 95`;

        const result = generateAIFixSync(makeContext(), mockResponse);

        expect(result.fixedCode).toContain("payment_method");
        expect(result.fixedCode).not.toContain('source: "tok_visa"');
        expect(result.confidence).toBe(95);
        expect(result.explanation).toContain("Changed");
    });

    test("extracts confidence from response", () => {
        const mockResponse = `\`\`\`typescript
const x = 1;
\`\`\`

Confidence: 80`;

        const result = generateAIFixSync(makeContext(), mockResponse);
        expect(result.confidence).toBe(80);
    });

    test("returns 0 when confidence not specified", () => {
        const mockResponse = `\`\`\`typescript
const x = 1;
\`\`\`

No confidence mentioned.`;

        const result = generateAIFixSync(makeContext(), mockResponse);
        expect(result.confidence).toBe(0);
    });

    test("preserves final newline", () => {
        const mockResponse = `\`\`\`typescript
const x = 1;
\`\`\`

Confidence: 90`;
        const result = generateAIFixSync(makeContext(), mockResponse);
        expect(result.fixedCode.endsWith("\n")).toBe(true);
        expect(result.fixedCode).toBe("const x = 1;\n");
    });

    test("throws when no code block found", () => {
        const mockResponse = "I cannot fix this code.";

        expect(() => generateAIFixSync(makeContext(), mockResponse)).toThrow(
            "AI returned no code",
        );
    });

    test("handles multiline code with imports", () => {
        const mockResponse = `\`\`\`typescript
import Stripe from "stripe";
import { logger } from "./utils";

const stripe = new Stripe("sk_test");

export async function createCharge(amount: number) {
    logger.info("Creating charge");
    const result = await stripe.charges.create({
        amount,
        payment_method: process.env.PAYMENT_METHOD ?? "pm_default",
    });
    return result.payment_method;
}
\`\`\`

Added null check for payment_method.
Confidence: 90`;

        const result = generateAIFixSync(makeContext(), mockResponse);

        expect(result.fixedCode).toContain("import Stripe");
        expect(result.fixedCode).toContain("import { logger }");
        expect(result.fixedCode).toContain("payment_method");
        expect(result.confidence).toBe(90);
    });

    test("builds correct prompt context", () => {
        const ctx = makeContext({
            filePath: "src/payments/checkout.ts",
            eventType: "checkout.session.completed",
        });

        expect(ctx.filePath).toBe("src/payments/checkout.ts");
        expect(ctx.eventType).toBe("checkout.session.completed");
        expect(ctx.diff.addedFields).toContain("payment_method");
        expect(ctx.diff.removedFields).toContain("source");
    });
});

describe("generateAIFix", () => {
    test("calls Cloudflare Workers AI", async () => {
        const request = installFetch(
            Response.json({
                result: { response: mockAIResponse },
                success: true,
            }),
        );
        const config: AIFixConfig = {
            provider: "cloudflare",
            apiKey: "test-cloudflare-token",
            accountId: "test-account",
        };

        const result = await generateAIFix(makeContext(), config);
        const captured = request();
        const body = JSON.parse(String(captured.init?.body));

        expect(result.fixedCode).toContain("payment_method");
        expect(result.confidence).toBe(95);
        expect(captured.url).toBe(
            "https://api.cloudflare.com/client/v4/accounts/test-account/ai/run/@cf/google/gemma-4-26b-a4b-it",
        );
        expect(new Headers(captured.init?.headers).get("Authorization")).toBe(
            "Bearer test-cloudflare-token",
        );
        expect(body.messages[0].role).toBe("system");
        expect(body.messages[1].content).toContain("src/stripe-handler.ts");
        expect(body.temperature).toBe(0.2);
    });

    test("calls Gemini without putting the key in the URL", async () => {
        const request = installFetch(
            Response.json({
                candidates: [
                    { content: { parts: [{ text: mockAIResponse }] } },
                ],
            }),
        );
        const config: AIFixConfig = {
            provider: "gemini",
            apiKey: "test-gemini-key",
        };

        const result = await generateAIFix(makeContext(), config);
        const captured = request();
        const body = JSON.parse(String(captured.init?.body));

        expect(result.fixedCode).toContain("payment_method");
        expect(result.confidence).toBe(95);
        expect(captured.url).toBe(
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        );
        expect(captured.url).not.toContain("test-gemini-key");
        expect(new Headers(captured.init?.headers).get("x-goog-api-key")).toBe(
            "test-gemini-key",
        );
        expect(body.contents[0].parts[0].text).toContain(
            "src/stripe-handler.ts",
        );
        expect(body.generationConfig.maxOutputTokens).toBe(4096);
    });

    test("requires a Cloudflare account ID", async () => {
        const config: AIFixConfig = {
            provider: "cloudflare",
            apiKey: "test-cloudflare-token",
        };

        await expect(generateAIFix(makeContext(), config)).rejects.toThrow(
            "Cloudflare account ID is required",
        );
    });
});

describe("regression: PR #3 bad output", () => {
    test("deterministic fallback produces correct snake_case", () => {
        const works: FixWork[] = [
            {
                kind: "field_rename",
                field: "data.object.source",
                from: "source",
                to: "payment_method",
                description: "Rename source to payment_method",
                template: "rename",
                confidence: "high",
            },
        ];
        const source = `
import Stripe from "stripe";
const stripe = new Stripe("sk_test");

export async function createCharge(amount: number) {
    const result = await stripe.charges.create({
        amount,
        source: "tok_visa",
    });
    return result.source;
}
`;
        let fixed: string | null = source;
        for (const work of works) {
            const r = applyFixWork(work, fixed!);
            if (r) fixed = r;
        }
        expect(fixed).toContain("payment_method");
        expect(fixed).not.toContain("paymentMethod");
        expect(fixed).not.toContain("// Added new field");
        expect(fixed!.endsWith("\n")).toBe(true);
        expect(/\bpayment_method\b/.test(fixed!)).toBe(true);
        expect(/\bpaymentMethod\b/.test(fixed!)).toBe(false);
    });

    test("rejects missing confidence (returns 0)", () => {
        const noConf = `\`\`\`typescript
const x = 1;
\`\`\`

No confidence here`;
        const result = generateAIFixSync(makeContext(), noConf);
        expect(result.confidence).toBe(0);
        expect(result.confidence < 60).toBe(true);
    });
});
