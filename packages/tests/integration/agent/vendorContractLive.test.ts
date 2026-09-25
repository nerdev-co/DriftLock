import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { P5_VENDOR, STRIPE_VENDOR } from "@driftlock/core";
import {
    contractFromSpec,
    discoverVendorReceivers,
    fetchSpec,
    probeLiveContract,
    verifyVendorSymbols,
    type VendorContract,
} from "@driftlock/agent";

/**
 * These tests talk to real vendor endpoints. They are the only proof that the
 * contract machinery reflects the vendor rather than our idea of the vendor, so
 * they are not mocked.
 *
 * They are also the only tests that can be made slow or flaky by a third party,
 * so each one skips loudly instead of failing when the network or the vendor is
 * unavailable, and each fetched spec is cached on disk for the rest of the run.
 * A vendor outage is not a regression in this repository, and the parsing itself
 * is covered deterministically in `unit/agent/vendorContract.test.ts`.
 */

const cacheDir = join(tmpdir(), "driftlock-spec-cache");

async function cachedSpec(url: string, timeoutMs: number): Promise<unknown> {
    const file = join(cacheDir, `${url.replace(/[^a-z0-9]+/gi, "_")}.json`);
    const cached = Bun.file(file);
    if (await cached.exists()) return cached.json();

    const { spec } = await fetchSpec(url, { timeoutMs });
    await mkdir(cacheDir, { recursive: true });
    await Bun.write(file, JSON.stringify(spec));
    return spec;
}

/** Returns null when the source is unavailable, so the caller can skip. */
async function trySpec(
    url: string,
    provider: string,
    version: string,
    timeoutMs: number,
): Promise<VendorContract | null> {
    try {
        const spec = await cachedSpec(url, timeoutMs);
        return contractFromSpec(provider, version, spec, url);
    } catch (error) {
        console.warn(
            `skipping: could not read ${url}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
    }
}

let p5SpecCache: VendorContract | null = null;

async function realP5Contract(): Promise<VendorContract | null> {
    if (p5SpecCache) return p5SpecCache;
    const url = P5_VENDOR.docs!.specUrl!;
    try {
        const spec = await cachedSpec(url, 30_000);
        p5SpecCache = contractFromSpec("p5", "2.3.0", spec, url);
        return p5SpecCache;
    } catch (error) {
        console.warn(
            `skipping: could not read p5 reference: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
    }
}

describe("live vendor contract", () => {
    test("builds a p5 contract from p5's own published reference", async () => {
        const contract = await realP5Contract();
        if (!contract) return;

        expect(contract.source).toBe("spec");
        expect(contract.authority).toBe("authoritative");
        expect(contract.members.length).toBeGreaterThan(500);

        for (const member of ["keyIsDown", "keyIsPressed", "keyCode", "constrain"]) {
            expect(contract.members).toContain(member);
        }
        for (const constant of ["UP_ARROW", "CENTER", "LEFT"]) {
            expect(contract.members).toContain(constant);
        }
    }, 60_000);

    test("catches the bare UP_ARROW the model actually wrote, using the real p5 reference", async () => {
        const contract = await realP5Contract();
        if (!contract) return;

        // Verbatim from the failed run against /Users/nalindalal/driftlock-p5.js-test.
        const asWritten = `const sketch = (p) => {
  p.setup = () => {
    p.createCanvas(400, 400);
  };
  p.draw = () => {
    if (p.keyIsDown(UP_ARROW)) {
      y = p.constrain(y - 2, 12, p.height - 12);
    }
  };
};
`;

        const findings = verifyVendorSymbols(
            contract,
            new Map([["src/sketch.js", asWritten]]),
            { vendor: P5_VENDOR },
        );

        expect(findings).toHaveLength(1);
        expect(findings[0].kind).toBe("unbound-constant");
        expect(findings[0].symbol).toBe("UP_ARROW");
        expect(findings[0].detail).toContain("p.UP_ARROW");
    }, 60_000);

    test("passes the corrected migration, and still flags a method p5 does not have", async () => {
        const contract = await realP5Contract();
        if (!contract) return;

        const corrected = `const sketch = (p) => {
  p.setup = () => { p.createCanvas(400, 400); };
  p.draw = () => {
    if (p.keyIsDown(p.UP_ARROW)) {
      y = p.constrain(y - 2, 12, p.height - 12);
    }
  };
};
`;
        expect(
            verifyVendorSymbols(contract, new Map([["src/sketch.js", corrected]]), {
                vendor: P5_VENDOR,
            }),
        ).toEqual([]);

        const invented = corrected.replace("p.keyIsDown", "p.keyIsCurrentlyDown");
        const findings = verifyVendorSymbols(
            contract,
            new Map([["src/sketch.js", invented]]),
            { vendor: P5_VENDOR },
        );
        expect(findings).toHaveLength(1);
        expect(findings[0].kind).toBe("unresolved");
        expect(findings[0].symbol).toBe("keyIsCurrentlyDown");
    }, 60_000);

    test("stays quiet on a realistic sketch, including lifecycle assignments", async () => {
        const contract = await realP5Contract();
        if (!contract) return;

        // The shape real p5 instance-mode code actually has: the user assigns
        // setup and draw onto the instance, so the gate has to accept writes to
        // lifecycle hooks rather than treating them as invented members.
        const realistic = `const sketch = (p) => {
  let y = 200;

  p.setup = () => {
    p.createCanvas(400, 400);
    p.textAlign(p.CENTER, p.CENTER);
  };

  p.draw = () => {
    p.background(220);
    if (p.keyIsDown(p.UP_ARROW)) {
      y = p.constrain(y - 2, 12, p.height - 12);
    }
    if (p.keyIsDown(p.DOWN_ARROW)) {
      y = p.constrain(y + 2, 12, p.height - 12);
    }
    p.circle(200, y, 20);
  };
};

new p5(sketch);
`;

        expect(
            verifyVendorSymbols(contract, new Map([["src/sketch.js", realistic]]), {
                vendor: P5_VENDOR,
            }),
        ).toEqual([]);
    }, 60_000);

    test("probes a live vendor endpoint and treats the response as the contract", async () => {
        const url = "https://api.github.com/repos/processing/p5.js";
        let probed: Awaited<ReturnType<typeof probeLiveContract>>;
        try {
            probed = await probeLiveContract("github", "2022-11-28", url, {
                allowlist: ["api.github.com"],
            });
        } catch (error) {
            console.warn(
                `skipping live probe: ${error instanceof Error ? error.message : String(error)}`,
            );
            return;
        }

        const { contract, status, memberCount } = probed;
        expect(status).toBe(200);
        expect(contract.source).toBe("live");
        expect(contract.authority).toBe("authoritative");
        expect(contract.origin).toBe(url);
        expect(memberCount).toBe(contract.members.length);
        expect(contract.members).toContain("full_name");
        expect(contract.members).toContain("owner.login");

        const githubVendor = {
            name: "github",
            sdk: "",
            clientNames: ["repo"],
            basePath: "",
            contractSubject: "client" as const,
        };
        const correct = new Map([
            ["a.js", "const repo = await getRepo();\nreturn repo.full_name;\n"],
        ]);
        expect(verifyVendorSymbols(contract, correct, { vendor: githubVendor })).toEqual([]);

        const wrong = new Map([
            ["a.js", "const repo = await getRepo();\nreturn repo.fullName;\n"],
        ]);
        const findings = verifyVendorSymbols(contract, wrong, { vendor: githubVendor });
        expect(findings).toHaveLength(1);
        expect(findings[0].kind).toBe("unresolved");
        expect(findings[0].detail).toContain("full_name");
    }, 60_000);

    test("stripe's published spec url is reachable and yields a contract", async () => {
        const contract = await trySpec(
            STRIPE_VENDOR.docs!.specUrl!,
            "stripe",
            "2022-11-15",
            60_000,
        );
        if (!contract) return;
        expect(contract.members.length).toBeGreaterThan(100);
        expect(contract.members).toContain("payment_intent");
    }, 90_000);
});

describe("receiver discovery on real shapes", () => {
    test("finds the stripe client and a value returned from it", () => {
        const source = `import Stripe from "stripe";
const stripe = new Stripe(key);
async function go(id) {
  const paymentIntent = await stripe.paymentIntents.retrieve(id);
  return paymentIntent;
}
`;
        const receivers = discoverVendorReceivers(source, STRIPE_VENDOR);
        expect(receivers.has("paymentIntent")).toBe(true);
    });

    test("finds a webhook payload receiver", () => {
        const source = `function handle(event) {
  const paymentIntent = event.data.object;
  return paymentIntent;
}
`;
        expect(discoverVendorReceivers(source, STRIPE_VENDOR).has("paymentIntent")).toBe(true);
    });

    test("treats the p5 instance as a contract subject", () => {
        const receivers = discoverVendorReceivers("const sketch = (p) => { p.draw(); };", P5_VENDOR);
        expect(receivers.has("p")).toBe(true);
    });

    test("does not treat the stripe client as a response receiver", () => {
        const receivers = discoverVendorReceivers("const x = stripe.customers.list();", STRIPE_VENDOR);
        expect(receivers.has("stripe")).toBe(false);
        expect(receivers.has("x")).toBe(true);
    });
});
