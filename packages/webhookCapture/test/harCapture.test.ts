import { describe, expect, test } from "bun:test";
import { harToConsumerContract, type HarEntry } from "../harCapture";

function entry(
    url: string,
    options: {
        method?: string;
        status?: number;
        requestText?: string;
        responseText?: string;
        mimeType?: string;
    } = {},
): HarEntry {
    return {
        request: {
            url,
            method: options.method ?? "GET",
            ...(options.requestText === undefined ? {} : {
                postData: {
                    mimeType: "application/json",
                    text: options.requestText,
                },
            }),
        },
        response: {
            status: options.status ?? 200,
            content: {
                mimeType: options.mimeType ?? "application/json",
                text: options.responseText,
            },
        },
    };
}

describe("harToConsumerContract", () => {
    test("templates only complete numeric and UUID path segments", () => {
        const uuid = "123e4567-e89b-12d3-a456-426614174000";
        const entries = [
            entry("https://api.example.com/users/123/orders/456/?page=2"),
            entry("https://api.example.com/users/789/orders/012/?page=3"),
            entry(`https://api.example.com/users/${uuid}/items/${uuid.toUpperCase()}`),
            entry("https://api.example.com/users/123abc/v2/123.json"),
            entry(`https://api.example.com/users/${uuid}-extra`),
            entry(`https://api.example.com/users/prefix-${uuid}`),
            entry("https://api.example.com/users/abcdef12-3456-incomplete"),
        ];
        const result = harToConsumerContract({ log: { entries } });

        expect(result.endpoints.map(({ key, samples }) => ({ key, samples }))).toEqual([
            { key: "GET /users/{id}/orders/{id}/ 200", samples: 2 },
            { key: "GET /users/{uuid}/items/{uuid} 200", samples: 1 },
            { key: "GET /users/123abc/v2/123.json 200", samples: 1 },
            { key: `GET /users/${uuid}-extra 200`, samples: 1 },
            { key: `GET /users/prefix-${uuid} 200`, samples: 1 },
            { key: "GET /users/abcdef12-3456-incomplete 200", samples: 1 },
        ]);
    });

    test("filters by parsed origin rather than a URL string prefix", () => {
        const entries = [
            entry("https://api.example.com/users"),
            entry("https://API.EXAMPLE.COM:443/orders"),
            entry("https://api.example.com.evil.test/users"),
            entry("https://api.example.com@evil.test/users"),
            entry("http://api.example.com/users"),
            entry("https://api.example.com:444/users"),
            entry("not a URL"),
        ];
        for (const baseUrl of ["https://api.example.com", "https://api.example.com/"]) {
            const result = harToConsumerContract({ log: { entries } }, { baseUrl });
            expect(result.stats).toEqual({ total: 7, kept: 2 });
            expect(result.endpoints.map(({ key }) => key)).toEqual([
                "GET /users 200",
                "GET /orders 200",
            ]);
        }
    });

    test("matches a base path itself and descendants at segment boundaries", () => {
        const entries = [
            entry("https://api.example.com/api"),
            entry("https://api.example.com/api/?page=1"),
            entry("https://api.example.com/api/users/123"),
            entry("https://api.example.com/apiv2"),
            entry("https://api.example.com/api-other/users"),
            entry("https://api.example.com/other/api"),
        ];
        for (const baseUrl of [
            "https://api.example.com/api",
            "https://api.example.com/api/",
            "https://API.EXAMPLE.COM:443/api/?ignored=true#fragment",
        ]) {
            const result = harToConsumerContract({ log: { entries } }, { baseUrl });
            expect(result.stats).toEqual({ total: 6, kept: 3 });
            expect(result.endpoints.map(({ key }) => key)).toEqual([
                "GET /api 200",
                "GET /api/ 200",
                "GET /api/users/{id} 200",
            ]);
        }
    });

    test("infers and merges request and response schemas across samples", () => {
        const entries = [
            entry("https://api.example.com/users/1", {
                method: "POST",
                status: 201,
                requestText: JSON.stringify({ user: { name: "Ada", age: 30 }, tags: [] }),
                responseText: JSON.stringify({ id: 1, items: [{ active: true }], note: null }),
            }),
            entry("https://api.example.com/users/2", {
                method: "POST",
                status: 201,
                requestText: JSON.stringify({ user: { name: "Grace", age: "31" }, active: true }),
                responseText: JSON.stringify({ id: "2", items: [{ name: "item" }], note: "ok" }),
            }),
            entry("https://api.example.com/users/3", {
                method: "POST",
                status: 201,
                requestText: JSON.stringify({ user: { age: 32 } }),
                responseText: JSON.stringify({ id: 3 }),
            }),
        ];
        const result = harToConsumerContract({ log: { entries } });
        const expected = [{
            key: "POST /users/{id} 201",
            samples: 3,
            requestSchema: {
                "user.name": "string",
                "user.age": "number|string",
                tags: "array",
                active: "boolean",
            },
            responseSchema: {
                id: "number|string",
                items: "array",
                "items[].active": "boolean",
                "items[].name": "string",
                note: "null|string",
            },
        }];

        expect(result.endpoints).toEqual(expected);
        expect(result.stats).toEqual({ total: 3, kept: 3 });
        expect(harToConsumerContract({ log: { entries: [...entries].reverse() } }).endpoints)
            .toEqual(expected);
    });

    test("keeps schemas separate by method, templated path, and status", () => {
        const entries = [
            entry("https://api.example.com/users/1", { responseText: '{"id":1}' }),
            entry("https://api.example.com/users/2", {
                method: "POST",
                requestText: '{"name":"Ada"}',
                responseText: '{"created":true}',
            }),
            entry("https://api.example.com/users/3", {
                status: 404,
                responseText: '{"error":"missing"}',
            }),
            entry("https://api.example.com/orders/1", { responseText: '{"total":10}' }),
        ];
        const result = harToConsumerContract({ log: { entries } });

        expect(result.endpoints).toEqual([
            {
                key: "GET /users/{id} 200",
                samples: 1,
                requestSchema: {},
                responseSchema: { id: "number" },
            },
            {
                key: "POST /users/{id} 200",
                samples: 1,
                requestSchema: { name: "string" },
                responseSchema: { created: "boolean" },
            },
            {
                key: "GET /users/{id} 404",
                samples: 1,
                requestSchema: {},
                responseSchema: { error: "string" },
            },
            {
                key: "GET /orders/{id} 200",
                samples: 1,
                requestSchema: {},
                responseSchema: { total: "number" },
            },
        ]);
    });

    test("decodes base64 response content before schema inference", () => {
        const sample = entry("https://api.example.com/users/1");
        sample.response.content = {
            mimeType: "application/json",
            encoding: "base64",
            text: "eyJpZCI6MX0=",
        };
        const result = harToConsumerContract({ log: { entries: [sample] } });
        expect(result.endpoints[0].responseSchema).toEqual({ id: "number" });
    });

    test("retains observations with absent, empty, or malformed bodies", () => {
        const entries = [
            entry("https://api.example.com/users/1"),
            entry("https://api.example.com/users/2", { requestText: "", responseText: "" }),
            entry("https://api.example.com/users/3", {
                requestText: "{invalid",
                responseText: '{"id":3}',
            }),
            entry("https://api.example.com/users/4", {
                requestText: '{"name":"Ada"}',
                responseText: "{invalid",
            }),
        ];
        const result = harToConsumerContract({ log: { entries } });

        expect(result.endpoints).toEqual([{
            key: "GET /users/{id} 200",
            samples: 4,
            requestSchema: { name: "string" },
            responseSchema: { id: "number" },
        }]);
        expect(result.stats).toEqual({ total: 4, kept: 4 });
    });

    test("infers root arrays, null, and scalar JSON using the root marker", () => {
        const entries = [
            entry("https://api.example.com/items", {
                requestText: "null",
                responseText: '[{"id":1}]',
            }),
            entry("https://api.example.com/items", {
                requestText: "false",
                responseText: "[]",
            }),
        ];
        const result = harToConsumerContract({ log: { entries } });

        expect(result.endpoints[0].requestSchema).toEqual({ $: "boolean|null" });
        expect(result.endpoints[0].responseSchema).toEqual({ $: "array", "$[].id": "number" });
    });

    test("preserves JSON filtering and the includeNonJson option", () => {
        const entries = [
            entry("https://api.example.com/json", {
                mimeType: "application/problem+json; charset=utf-8",
                responseText: '{"error":"missing"}',
            }),
            entry("https://api.example.com/html", {
                mimeType: "text/html",
                requestText: '{"query":"search"}',
                responseText: "<html></html>",
            }),
        ];
        const filtered = harToConsumerContract({ log: { entries } });
        expect(filtered.stats).toEqual({ total: 2, kept: 1 });
        expect(filtered.endpoints[0].responseSchema).toEqual({ error: "string" });

        const included = harToConsumerContract({ log: { entries } }, { includeNonJson: true });
        expect(included.stats).toEqual({ total: 2, kept: 2 });
        expect(included.endpoints[1]).toEqual({
            key: "GET /html 200",
            samples: 1,
            requestSchema: { query: "string" },
            responseSchema: {},
        });
    });
});
