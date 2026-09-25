import { describe, expect, test } from "bun:test";
import { P5_VENDOR, STRIPE_VENDOR } from "@driftlock/core";
import {
    collectBoundNames,
    contractFromHar,
    contractFromSpec,
    describeContract,
    diffContracts,
    discoverVendorReceivers,
    flattenMembers,
    isConstantName,
    probeLiveContract,
    resolveVendorContract,
    verifyVendorSymbols,
    type VendorContract,
} from "@driftlock/agent";

function contract(overrides: Partial<VendorContract> = {}): VendorContract {
    return {
        provider: "test",
        version: "2.0.0",
        source: "spec",
        authority: "authoritative",
        origin: "test://contract",
        capturedAt: "2026-01-01T00:00:00.000Z",
        members: [],
        removed: [],
        ...overrides,
    };
}

describe("flattenMembers", () => {
    test("records nested paths", () => {
        expect(flattenMembers({ a: { b: { c: 1 } } })).toEqual(["a", "a.b", "a.b.c"]);
    });

    test("folds arrays into [] and does not record indices", () => {
        expect(flattenMembers({ items: [{ id: 1 }, { id: 2 }] })).toEqual([
            "items",
            "items[].id",
        ]);
    });

    test("returns nothing for scalars and empty arrays", () => {
        expect(flattenMembers(5)).toEqual([]);
        expect(flattenMembers({ a: [] })).toEqual(["a"]);
    });
});

describe("isConstantName", () => {
    test("separates constants from fields", () => {
        expect(isConstantName("UP_ARROW")).toBe(true);
        expect(isConstantName("CENTER")).toBe(true);
        expect(isConstantName("keyIsDown")).toBe(false);
        expect(isConstantName("payment_method")).toBe(false);
        expect(isConstantName("PascalCase")).toBe(false);
        expect(isConstantName("A")).toBe(false);
    });
});

describe("diffContracts", () => {
    test("reports what the vendor dropped", () => {
        const before = contract({ members: ["id", "source", "status"] });
        const after = contract({ members: ["id", "payment_method", "status"] });
        expect(diffContracts(before, after).removed).toEqual(["source"]);
    });

    test("is empty when nothing changed", () => {
        const one = contract({ members: ["a", "b"] });
        expect(diffContracts(one, one).removed).toEqual([]);
    });
});

describe("contractFromHar", () => {
    const har = {
        log: {
            entries: [
                {
                    request: { url: "https://api.stripe.com/v1/payment_intents/pi_1", method: "GET" },
                    response: {
                        status: 200,
                        content: {
                            mimeType: "application/json",
                            text: JSON.stringify({ id: "pi_1", source: "src_1", status: "succeeded" }),
                        },
                    },
                },
                {
                    request: { url: "https://api.stripe.com/v1/payment_intents/pi_2", method: "GET" },
                    response: {
                        status: 200,
                        content: {
                            mimeType: "application/json",
                            text: JSON.stringify({
                                id: "pi_2",
                                payment_method: "pm_1",
                                status: "succeeded",
                                charges: { data: [{ id: "ch_1" }] },
                            }),
                        },
                    },
                },
                {
                    request: { url: "https://api.stripe.com/v1/payment_intents/bad", method: "GET" },
                    response: {
                        status: 402,
                        content: { mimeType: "application/json", text: JSON.stringify({ error: { message: "nope" } }) },
                    },
                },
            ],
        },
    };

    test("unions members across every successful response", () => {
        const built = contractFromHar("stripe", "2022-11-15", har, "capture.har");
        expect(built.members).toContain("payment_method");
        expect(built.members).toContain("source");
        expect(built.members).toContain("charges.data[].id");
    });

    test("is sampled authority, never authoritative", () => {
        expect(contractFromHar("stripe", "x", har, "capture.har").authority).toBe("sampled");
    });

    test("ignores error responses", () => {
        const built = contractFromHar("stripe", "x", har, "capture.har");
        expect(built.members).not.toContain("error");
    });

    test("refuses an empty recording", () => {
        expect(() =>
            contractFromHar("stripe", "x", { log: { entries: [] } }, "empty.har"),
        ).toThrow(/empty/i);
    });
});

describe("contractFromSpec", () => {
    test("reads OpenAPI component schemas", () => {
        const spec = {
            components: {
                schemas: {
                    PaymentIntent: {
                        type: "object",
                        properties: {
                            id: { type: "string" },
                            payment_method: { type: "string" },
                            charges: {
                                type: "object",
                                properties: { data: { type: "array", items: { $ref: "#/x" } } },
                            },
                        },
                    },
                },
            },
        };
        const built = contractFromSpec("stripe", "2022-11-15", spec, "openapi.json");
        expect(built.members).toEqual(["charges", "charges.data", "id", "payment_method"]);
        expect(built.authority).toBe("authoritative");
    });

    test("reads a p5 style entries list", () => {
        const spec = {
            entries: [
                { name: "keyIsDown" },
                { name: "UP_ARROW" },
                { name: "keyIsPressed" },
            ],
        };
        const built = contractFromSpec("p5", "2.3.0", spec, "data.json");
        expect(built.members).toEqual(["UP_ARROW", "keyIsDown", "keyIsPressed"]);
    });

    test("resolves allOf branches", () => {
        const spec = {
            components: {
                schemas: {
                    Thing: {
                        allOf: [
                            { type: "object", properties: { a: { type: "string" } } },
                            { type: "object", properties: { b: { type: "string" } } },
                        ],
                    },
                },
            },
        };
        expect(contractFromSpec("stripe", "x", spec, "s").members).toEqual(["a", "b"]);
    });

    test("refuses a spec with no declarations", () => {
        expect(() => contractFromSpec("stripe", "x", { unrelated: true }, "s")).toThrow(/empty/i);
    });
});

describe("collectBoundNames", () => {
    test("finds declarations, imports, params and catch bindings", () => {
        const bound = collectBoundNames(`
            import Stripe from "stripe";
            const local = 1;
            let mutable;
            function helper(arg) { return arg; }
            class Thing {}
            try { helper(local); } catch (UP_ARROW) { console.log(UP_ARROW); }
            const arrow = (param, other) => param + other;
        `);
        for (const name of [
            "Stripe", "local", "mutable", "helper", "Thing",
            "UP_ARROW", "arrow", "param", "other", "arg",
        ]) {
            expect(bound.has(name)).toBe(true);
        }
    });

    test("treats ambient names as bound", () => {
        expect(collectBoundNames("console.log(1)").has("console")).toBe(true);
    });

    test("does not bind a name that is only read", () => {
        expect(collectBoundNames("return UP_ARROW;").has("UP_ARROW")).toBe(false);
    });
});

describe("verifyVendorSymbols against the p5 instance-mode bug", () => {
    // The exact edit the model produced on the real p5 repository.
    const brokenSketch = `const sketch = (p) => {
    if (p.keyIsDown(UP_ARROW)) {
      y = p.constrain(y - 2, 12, p.height - 12);
    }
};
`;

    const p5Contract = contract({
        provider: "p5",
        members: [
            "UP_ARROW",
            "keyIsDown",
            "keyIsPressed",
            "key",
            "keyCode",
            "constrain",
            "height",
        ],
    });

    test("flags a vendor constant used as a free identifier", () => {
        const findings = verifyVendorSymbols(
            p5Contract,
            new Map([["src/sketch.js", brokenSketch]]),
            { vendor: P5_VENDOR },
        );
        expect(findings).toHaveLength(1);
        expect(findings[0].kind).toBe("unbound-constant");
        expect(findings[0].symbol).toBe("UP_ARROW");
        expect(findings[0].detail).toContain("p.UP_ARROW");
    });

    test("passes the same code once the constant is reached through the instance", () => {
        const fixed = brokenSketch.replace("keyIsDown(UP_ARROW)", "keyIsDown(p.UP_ARROW)");
        expect(
            verifyVendorSymbols(p5Contract, new Map([["src/sketch.js", fixed]]), {
                vendor: P5_VENDOR,
            }),
        ).toEqual([]);
    });

    test("passes when the constant is imported from the package", () => {
        const imported = `import { UP_ARROW } from "p5";\n${brokenSketch}`;
        expect(
            verifyVendorSymbols(p5Contract, new Map([["src/sketch.js", imported]]), {
                vendor: P5_VENDOR,
            }),
        ).toEqual([]);
    });

    test("does not flag a locally declared constant of the same name", () => {
        const local = `const UP_ARROW = 38;\n${brokenSketch}`;
        expect(
            verifyVendorSymbols(p5Contract, new Map([["src/sketch.js", local]]), {
                vendor: P5_VENDOR,
            }),
        ).toEqual([]);
    });

    test("ignores mentions inside comments", () => {
        const commented = `// TODO: keyIsDown(UP_ARROW) once we migrate\nconst x = 1;\n`;
        expect(
            verifyVendorSymbols(p5Contract, new Map([["src/sketch.js", commented]]), {
                vendor: P5_VENDOR,
            }),
        ).toEqual([]);
    });
});

describe("verifyVendorSymbols against the stripe completeness bug", () => {
    // The real webhook.js, with the model having migrated one of the two
    // paymentIntent.source sites and forgotten the other.
    const halfMigratedWebhook = `async function handleWebhook(event) {
  const signature = verifySignature(event);
  if (!signature) return { status: 400 };

  const paymentIntent = event.data.object;
  console.log(\`Amount: \${paymentIntent.amount}\`);
  console.log(\`Payment Method: \${paymentIntent.payment_method}\`);
  console.log(\`Client Secret: \${paymentIntent.client_secret}\`);

  return {
    source: paymentIntent.source,
  };
}
`;

    const before = contract({
        members: ["id", "source", "status", "payment_method", "amount", "client_secret"],
    });
    const after = contract({
        members: ["id", "payment_method", "status", "amount", "currency", "client_secret"],
    });
    const { removed } = diffContracts(before, after);
    const sampled = { ...after, source: "recorded" as const, authority: "sampled" as const, removed };
    const live = { ...after, source: "live" as const, authority: "authoritative" as const, removed };

    test("discovers a webhook payload receiver without being told its name", () => {
        expect(discoverVendorReceivers(halfMigratedWebhook, STRIPE_VENDOR).has("paymentIntent")).toBe(true);
    });

    test("flags the call site the model forgot", () => {
        const findings = verifyVendorSymbols(sampled, new Map([["webhook.js", halfMigratedWebhook]]), {
            vendor: STRIPE_VENDOR,
        });
        expect(findings).toHaveLength(1);
        expect(findings[0].kind).toBe("stale");
        expect(findings[0].symbol).toBe("source");
        expect(findings[0].line).toBe(11);
    });

    test("keeps line numbers stable across multi-line block comments", () => {
        const source = `const paymentIntent = await stripe.paymentIntents.retrieve(id);
/* a stale-looking mention:
paymentIntent.source
end of comment */
return paymentIntent.source;
`;
        const findings = verifyVendorSymbols(sampled, new Map([["webhook.js", source]]), {
            vendor: STRIPE_VENDOR,
        });
        // The mention inside the comment is ignored, and the real read keeps
        // its original line number instead of shifting up by the removed lines.
        expect(findings).toHaveLength(1);
        expect(findings[0].line).toBe(5);
    });

    test("passes once every site is migrated", () => {
        const complete = halfMigratedWebhook.replace(
            "paymentIntent.source",
            "paymentIntent.payment_method",
        );
        expect(
            verifyVendorSymbols(sampled, new Map([["webhook.js", complete]]), {
                vendor: STRIPE_VENDOR,
            }),
        ).toEqual([]);
    });

    test("flags a field the vendor never had, with a near miss as a hint", () => {
        const invented = `const paymentIntent = await stripe.paymentIntents.retrieve(id);
return paymentIntent.payment_methods;
`;
        const findings = verifyVendorSymbols(live, new Map([["payment.js", invented]]), {
            vendor: STRIPE_VENDOR,
        });
        expect(findings).toHaveLength(1);
        expect(findings[0].kind).toBe("unresolved");
        expect(findings[0].symbol).toBe("payment_methods");
        expect(findings[0].detail).toContain("payment_method");
    });

    test("discovers a receiver assigned from the sdk client", () => {
        const real = `import Stripe from "stripe";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
async function createPayment(amount, currency) {
  const paymentIntent = await stripe.paymentIntents.create({ amount, currency });
  return {
    amount: paymentIntent.amount,
    currency: paymentIntent.currency,
    status: paymentIntent.status,
    source: paymentIntent.payment_method,
    client_secret: paymentIntent.client_secret,
  };
}
`;
        expect(discoverVendorReceivers(real, STRIPE_VENDOR).has("paymentIntent")).toBe(true);
        expect(verifyVendorSymbols(live, new Map([["payment.js", real]]), { vendor: STRIPE_VENDOR })).toEqual([]);
    });

    test("a sampled recording does not accuse a field it simply never saw", () => {
        const unseen = `const paymentIntent = await stripe.paymentIntents.retrieve(id);
return paymentIntent.rare_but_real_field;
`;
        expect(
            verifyVendorSymbols(sampled, new Map([["payment.js", unseen]]), {
                vendor: STRIPE_VENDOR,
            }),
        ).toEqual([]);
    });

    test("accepts explicitly supplied receivers", () => {
        expect(
            verifyVendorSymbols(live, new Map([["a.js", "return pi.charge;\n"]]), {
                vendor: STRIPE_VENDOR,
                clientNames: ["pi"],
            }),
        ).toHaveLength(1);
    });

    test("checks deep member paths on an authoritative contract", () => {
        const deep = contract({
            provider: "stripe",
            authority: "authoritative",
            members: ["charges", "charges[].data[].id", "charges[].data[].amount"],
        });
        const good = `const pi = await stripe.paymentIntents.retrieve(id);
return pi.charges.data[0].amount;
`;
        const bad = `const pi = await stripe.paymentIntents.retrieve(id);
return pi.charges.data[0].refund;
`;
        expect(verifyVendorSymbols(deep, new Map([["a.js", good]]), { vendor: STRIPE_VENDOR })).toEqual([]);
        const findings = verifyVendorSymbols(deep, new Map([["a.js", bad]]), { vendor: STRIPE_VENDOR });
        expect(findings).toHaveLength(1);
        expect(findings[0].symbol).toBe("charges.data.refund");
    });

    test("only inspects receivers the vendor owns", () => {
        const findings = verifyVendorSymbols(
            live,
            new Map([["a.js", "const myOwn = build();\nreturn myOwn.nonexistent_field;\n"]]),
            { vendor: STRIPE_VENDOR },
        );
        expect(findings).toEqual([]);
    });
});

describe("describeContract", () => {
    test("states provenance and the removed list", () => {
        const text = describeContract(
            contract({
                provider: "stripe",
                source: "live",
                origin: "https://api.stripe.com/v1/payment_intents/pi_1",
                members: ["id", "payment_method"],
                removed: ["source"],
            }),
        );
        expect(text).toContain("source: live (authoritative)");
        expect(text).toContain("removed by the vendor: source");
        expect(text).toContain("payment_method");
    });
});

describe("probeLiveContract refusals", () => {
    test("refuses an empty allowlist", async () => {
        await expect(
            probeLiveContract("stripe", "x", "https://api.stripe.com/v1/x", { allowlist: [] }),
        ).rejects.toThrow(/allowlist is empty/);
    });

    test("refuses a host that is not allowlisted", async () => {
        await expect(
            probeLiveContract("stripe", "x", "https://evil.example.com/v1", {
                allowlist: ["api.stripe.com"],
            }),
        ).rejects.toThrow(/not in the allowlist/);
    });

    test("refuses plain http", async () => {
        await expect(
            probeLiveContract("stripe", "x", "http://api.stripe.com/v1", {
                allowlist: ["api.stripe.com"],
            }),
        ).rejects.toThrow(/not https/);
    });

    test("refuses a malformed url", async () => {
        await expect(
            probeLiveContract("stripe", "x", "not-a-url", { allowlist: ["api.stripe.com"] }),
        ).rejects.toThrow(/not a valid URL/);
    });

    test("matches a suffix allowlist entry without matching a lookalike host", async () => {
        await expect(
            probeLiveContract("stripe", "x", "https://notstripe.com/v1", {
                allowlist: [".stripe.com"],
            }),
        ).rejects.toThrow(/not in the allowlist/);
    });
});

describe("resolveVendorContract", () => {
    test("refuses when no source is available", async () => {
        await expect(
            resolveVendorContract({
                vendor: { name: "acme", sdk: "acme", clientNames: ["acme"], basePath: "" },
                version: "1.0.0",
            }),
        ).rejects.toThrow(/No contract source/);
    });
});
