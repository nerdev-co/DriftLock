/**
 * HAR → consumer contract, inspired by SpecShield `bdct capture from-har`
 * Source: https://github.com/specshield-io/specshield-cli#bdct-capture-from-har
 * What to adapt: turn real test traffic (HAR) into a consumer contract, no Pact DSL.
 * How in DriftLock: reuses schemaFlattener, path templating, per-status schema merging.
 * Where: packages/webhookCapture/harCapture.ts, used by CLI `driftlock capture --har`
 */

import { flattenPayload, type FlatSchema } from "./schemaFlattener";

export interface HarCaptureOptions {
  baseUrl?: string;
  includeNonJson?: boolean;
}

export interface HarEntry {
  request: {
    url: string;
    method: string;
    postData?: { mimeType?: string; text?: string };
  };
  response: { status: number; content: { mimeType: string; text?: string; encoding?: string } };
}

function templatedPath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.split("/").map((segment) => {
      if (/^\d+$/.test(segment)) return "{id}";
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) {
        return "{uuid}";
      }
      return segment;
    }).join("/");
  } catch {
    return url;
  }
}

function inferSchema(text: string | undefined): FlatSchema {
  if (!text) return {};
  try {
    const payload: unknown = JSON.parse(text);
    if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
      return flattenPayload(payload as Record<string, unknown>);
    }
    // Use $ for non-object roots so arrays and scalar JSON retain their type.
    return flattenPayload({ $: payload });
  } catch {
    // Missing or invalid JSON should not discard the endpoint observation.
    return {};
  }
}

function mergeSchemas(previous: FlatSchema, current: FlatSchema): FlatSchema {
  const merged = { ...previous };
  for (const [field, type] of Object.entries(current)) {
    const types = new Set(
      Object.hasOwn(previous, field) ? previous[field].split("|") : [],
    );
    types.add(type);
    // Preserve every observed type, with stable output regardless of sample order.
    Object.defineProperty(merged, field, {
      value: [...types].sort().join("|"),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return merged;
}

export function harToConsumerContract(har: { log: { entries: HarEntry[] } }, opts: HarCaptureOptions = {}) {
  const baseUrl = opts.baseUrl ? new URL(opts.baseUrl) : undefined;
  const basePath = baseUrl?.pathname.replace(/\/+$/, "") ?? "";
  const filtered = har.log.entries.filter((e) => {
    if (baseUrl) {
      try {
        const url = new URL(e.request.url);
        if (url.origin !== baseUrl.origin) return false;
        if (basePath && url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
          return false;
        }
      } catch {
        return false;
      }
    }
    if (!opts.includeNonJson && !e.response.content.mimeType.includes("json")) return false;
    return true;
  });

  const endpoints = new Map<string, {
    samples: number;
    requestSchema: FlatSchema;
    responseSchema: FlatSchema;
  }>();
  for (const e of filtered) {
    const path = templatedPath(e.request.url);
    const key = `${e.request.method} ${path} ${e.response.status}`;
    const cur = endpoints.get(key) ?? { samples: 0, requestSchema: {}, responseSchema: {} };
    cur.requestSchema = mergeSchemas(cur.requestSchema, inferSchema(e.request.postData?.text));
    const content = e.response.content;
    const responseText = content.encoding === "base64" && content.text
      ? Buffer.from(content.text, "base64").toString("utf8")
      : content.text;
    cur.responseSchema = mergeSchemas(cur.responseSchema, inferSchema(responseText));
    cur.samples++;
    endpoints.set(key, cur);
  }

  return {
    endpoints: [...endpoints.entries()].map(([key, value]) => ({ key, ...value })),
    stats: { total: har.log.entries.length, kept: filtered.length },
  };
}
