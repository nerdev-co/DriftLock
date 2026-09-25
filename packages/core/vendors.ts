export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

/** Explicit endpoint override for a method the pattern inference can't derive. */
export interface EndpointOverride {
    endpoint: string;
    httpMethod?: HttpMethod;
}

/**
 * Optional enrichments for a single SDK resource.
 * The extractor's pattern inference handles the CRUD happy path on its own
 * (`create`/`retrieve`/`update`/`delete`/`list`); the registry only exists to
 * capture exceptions, custom action endpoints and non-default HTTP verbs.
 */
export interface ResourceConfig {
    /** method name → endpoint pattern (e.g. "finalizeInvoice" → "/v1/invoices/:id/finalize") */
    overrides?: Record<string, string | EndpointOverride>;
    /** Per-method HTTP verb hints that differ from the inferred default */
    httpMethods?: Partial<Record<string, HttpMethod>>;
}

export interface VendorDocs {
    url?: string;
    specUrl?: string;
}

/**
 * Data-driven description of an SDK. Vendor knowledge lives here (not in the
 * parser) so it can be shipped as JSON and generated/enriched by the docs
 * agent instead of being hardcoded per vendor in the extractor.
 */
export interface VendorConfig {
    /** Canonical name, e.g. "stripe". */
    name: string;
    /** npm package name that provides this client, e.g. "stripe". */
    sdk: string;
    /** Variable names that resolve to the SDK client in user code. */
    clientNames: string[];
    /** URL path prefix shared by every endpoint, e.g. "/v1". */
    basePath: string;
    /**
     * What a captured contract describes.
     *
     * `resources` (the default) means the contract describes the fields of the
     * objects the vendor *returns*, so `stripe.paymentIntents` is the SDK's own
     * request surface and is not covered by it. Only values derived from a call,
     * like `paymentIntent`, are checked.
     *
     * `client` means the contract describes the instance itself, as for a
     * browser library where the object handed to the sketch *is* the API surface.
     */
    contractSubject?: "resources" | "client";
    /** Optional per-resource enrichments. */
    resources?: Record<string, ResourceConfig>;
    /** Links to source documentation / OpenAPI spec. */
    docs?: VendorDocs;
}

export const STRIPE_VENDOR: VendorConfig = {
    name: "stripe",
    sdk: "stripe",
    clientNames: ["stripe"],
    basePath: "/v1",
    docs: {
        url: "https://docs.stripe.com/api",
        specUrl: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json",
    },
    resources: {
        // Custom invoice actions whose endpoints can't be inferred from the
        // method name (finalize/send/void/pay map to fixed action segments).
        invoices: {
            overrides: {
                finalizeInvoice: "/v1/invoices/:id/finalize",
                sendInvoice: "/v1/invoices/:id/send",
                voidInvoice: "/v1/invoices/:id/void",
                payInvoice: "/v1/invoices/:id/pay",
            },
        },
    },
};

export const TWILIO_VENDOR: VendorConfig = {
    name: "twilio",
    sdk: "twilio",
    clientNames: ["twilioClient", "twilio"],
    basePath: "/2010-04-01",
    docs: {
        url: "https://www.twilio.com/docs",
    },
};

export const P5_VENDOR: VendorConfig = {
    name: "p5",
    sdk: "p5",
    clientNames: ["p", "p5", "sketch"],
    basePath: "",
    contractSubject: "client",
    docs: {
        url: "https://p5js.org/reference/",
        specUrl: "https://p5js.org/reference/data.json",
    },
    resources: {
        // p5 2.x renames / behavior changes are instance-scoped (p.*), not REST
        sketch: {
            overrides: {
                keyIsPressed: "p5:instance:keyIsPressed",
                keyIsDown: "p5:instance:keyIsDown",
            },
        },
    },
};