import type { VendorConfig } from "@driftlock/core";

/**
 * Ground truth about a vendor's API surface, used to check that the agent's edits
 * reference things that actually exist.
 *
 * A contract can come from three places, and they differ only in how much you
 * should trust an absence:
 *
 * - `live`: one real request to the vendor right now. Authoritative for the
 *   endpoint that was probed, and for nothing else. Absence at the top level of
 *   the probed resource is real evidence.
 * - `spec`: the vendor's own published declarations. Authoritative for the
 *   whole surface, so a deep absence is real evidence too.
 * - `recorded`: a union of previously observed responses. Absence is weak
 *   evidence, because a field simply may not have appeared in the sample. Only
 *   a top-level absence is treated as real, and only when the contract also
 *   carries an explicit `removed` list.
 *
 * `live` and `recorded` produce the same shape, so the verifier never branches
 * on provenance. Only the confidence in a negative result differs, and that is
 * encoded once, in `authority`, rather than scattered through the checks.
 */
export type ContractSource = "live" | "recorded" | "spec";

/** How much an absent member proves. */
export type Authority = "authoritative" | "sampled";

export interface VendorContract {
    provider: string;
    version: string;
    source: ContractSource;
    authority: Authority;
    /** Human readable provenance: the probed URL, the HAR path, the spec URL. */
    origin: string;
    capturedAt: string;
    /** Dotted member paths that exist, e.g. `payment_method`, `charges[].data[].id`. */
    members: string[];
    /** Members the vendor no longer exposes, from a diff against a baseline. */
    removed: string[];
}

const UPPER_SNAKE = /^[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)*$/;
const SAFE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * A vendor constant, e.g. `UP_ARROW` or p5's single word `CENTER`. Distinguished
 * from fields by casing, since that is how every vendor separates them and it is
 * what lets an unbound use be spotted without a type checker.
 */
export function isConstantName(name: string): boolean {
    return UPPER_SNAKE.test(name);
}

/**
 * Walks a decoded JSON value and records every member path reachable from the
 * root. Array elements are folded into `[]` so one observed element describes
 * every element, and the array index itself is not recorded as a member.
 */
export function flattenMembers(value: unknown, prefix = ""): string[] {
    if (Array.isArray(value)) {
        if (value.length === 0) return [];
        return flattenMembers(value[0], `${prefix}[]`);
    }
    if (typeof value !== "object" || value === null) return [];

    const paths: string[] = [];
    for (const [key, child] of Object.entries(value)) {
        const path = prefix ? `${prefix}.${key}` : key;
        paths.push(path);
        paths.push(...flattenMembers(child, path));
    }
    return paths;
}

export function uniqueSorted(values: Iterable<string>): string[] {
    return [...new Set(values)].sort();
}

export function contractMembers(contract: VendorContract): Set<string> {
    return new Set(contract.members);
}

/** Top-level members only. The strongest and cheapest negative signal. */
export function topLevelMembers(contract: VendorContract): Set<string> {
    const out = new Set<string>();
    for (const member of contract.members) {
        const [head, ...rest] = member.split(".");
        if (head) out.add(head);
        if (rest.length === 0) out.add(head);
    }
    return out;
}

export function contractConstants(contract: VendorContract): Set<string> {
    const out = new Set<string>();
    for (const member of contract.members) {
        const leaf = member.split(".").pop();
        if (leaf && isConstantName(leaf)) out.add(leaf);
    }
    return out;
}

export function diffContracts(
    previous: VendorContract,
    current: VendorContract,
): Pick<VendorContract, "removed" | "members"> {
    const before = contractMembers(previous);
    const after = contractMembers(current);
    return {
        members: current.members,
        removed: uniqueSorted([...before].filter((member) => !after.has(member))),
    };
}

interface TrieNode {
    children: Map<string, TrieNode>;
}

/**
 * Builds a lookup over the contract's member paths so a chain can be walked the
 * way the code actually reads it, including array hops.
 *
 * A flat set of strings cannot answer `charges.data[].refund`, because the code
 * says `charges.data[0].refund`. Walking a trie makes the array hop explicit
 * instead of relying on string prefixes agreeing, which is what makes a deep
 * absence trustworthy rather than a guess.
 */
function buildTrie(members: Iterable<string>): TrieNode {
    const root: TrieNode = { children: new Map() };
    for (const member of members) {
        const segments = member.split(".");
        let node = root;
        for (const rawSegment of segments) {
            const isArray = rawSegment.endsWith("[]");
            const name = isArray ? rawSegment.slice(0, -2) : rawSegment;
            if (!name) continue;
            let next = node.children.get(name);
            if (!next) {
                next = { children: new Map() };
                node.children.set(name, next);
            }
            void isArray;
            node = next;
        }
    }
    return root;
}

type ChainSegment =
    | { kind: "name"; value: string }
    | { kind: "index" };

export interface MemberChain {
    receiver: string;
    segments: ChainSegment[];
    raw: string;
}

const CHAIN =
    /([A-Za-z_$][A-Za-z0-9_$]*)((?:\s*(?:\?\.|\.)\s*[A-Za-z_$][A-Za-z0-9_$]*|\s*\[\s*\d*\s*\])+)/g;
const CHAIN_PART = /\?\.|\.|\[\s*\d*\s*\]|\[A-Za-z_$][\w$]*\]|[A-Za-z_$][A-Za-z0-9_$]*/g;

/**
 * Pulls out full access chains rather than just `receiver.member`, so a read
 * three levels deep is checked all the way down instead of only at the root.
 */
export function extractMemberChains(text: string): MemberChain[] {
    const chains: MemberChain[] = [];
    CHAIN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CHAIN.exec(text)) !== null) {
        const [, receiver, tail] = match;
        const segments: ChainSegment[] = [];
        CHAIN_PART.lastIndex = 0;
        let part: RegExpExecArray | null;
        while ((part = CHAIN_PART.exec(tail)) !== null) {
            const token = part[0];
            if (token.startsWith("[")) segments.push({ kind: "index" });
            else if (/^[A-Za-z_$]/.test(token)) segments.push({ kind: "name", value: token });
        }
        if (segments.some((segment) => segment.kind === "name")) {
            chains.push({ receiver, segments, raw: match[0].replace(/\s+/g, "") });
        }
    }
    return chains;
}

export type ChainResolution =
    | { ok: true }
    | { ok: false; missing: string; resolved: string };

/** Walks a chain against the contract, returning the first member it cannot place. */
export function resolveChain(
    contract: VendorContract,
    chain: MemberChain,
    trie: TrieNode = buildTrie(contract.members),
): ChainResolution {
    let node: TrieNode | undefined = trie;
    const resolved: string[] = [];

    for (const segment of chain.segments) {
        if (segment.kind === "index") continue;
        const next: TrieNode | undefined = node?.children.get(segment.value);
        if (!next) {
            return {
                ok: false,
                missing: [...resolved, segment.value].join("."),
                resolved: resolved.join("."),
            };
        }
        resolved.push(segment.value);
        node = next;
    }
    return { ok: true };
}

const WEBHOOK_CHAIN = /\.\s*(?:data\s*\.\s*object|body|payload|object)\b/;
const ASSIGNMENT = /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*([^;]+)/g;

/**
 * Finds the names that actually hold vendor objects.
 *
 * `VendorConfig.clientNames` only names the SDK client itself, and real code
 * almost never reads fields off the client. It reads them off whatever the call
 * returned, which is named anything: `pi`, `paymentIntent`, `intent`. Without
 * this the gate would pass on code that is entirely wrong, because it would
 * never look at the line that matters.
 *
 * Two shapes cover most code: a variable assigned from a vendor client call, and
 * a variable assigned from a webhook payload chain. This is a heuristic and it
 * is not exhaustive, so callers can and should pass receivers explicitly.
 *
 * Client names are only included when the vendor says its contract describes the
 * client itself. For a REST SDK the client's members are the request surface,
 * which a captured response says nothing about, so including it would report
 * every resource accessor as an invented field.
 */
export function discoverVendorReceivers(
    source: string,
    vendor: VendorConfig,
): Set<string> {
    const receivers = new Set<string>();
    if (vendor.contractSubject === "client") {
        for (const name of vendor.clientNames) receivers.add(name);
    }
    const clientPattern = new RegExp(
        `\\b(?:${vendor.clientNames.map(escapeRegExp).join("|")})\\s*(?:\\?\\.)?\\s*\\.`,
    );

    ASSIGNMENT.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ASSIGNMENT.exec(source)) !== null) {
        const [, name, value] = match;
        if (clientPattern.test(value) || WEBHOOK_CHAIN.test(value)) {
            receivers.add(name);
        }
    }
    return receivers;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function emptyContract(
    provider: string,
    version: string,
    source: ContractSource,
    authority: Authority,
    origin: string,
): VendorContract {
    return {
        provider,
        version,
        source,
        authority,
        origin,
        capturedAt: new Date().toISOString(),
        members: [],
        removed: [],
    };
}

export interface LiveProbeOptions {
    /** Exact host, or a suffix like `.stripe.com` that a host must end with. */
    allowlist: string[];
    timeoutMs?: number;
    /**
     * Credentials for the probe. Never sourced from the model and never written
     * to the transcript, so a live probe against a metered or authenticated API
     * stays the operator's explicit decision.
     */
    headers?: Record<string, string>;
}

export interface LiveProbeResult {
    contract: VendorContract;
    status: number;
    memberCount: number;
}

export class ContractProbeError extends Error {}

/**
 * One real request to the vendor, then the response is treated as the contract.
 *
 * Deliberately narrow. The method must be `GET`, the host must be allowlisted,
 * redirects are refused, and there is no retry. A probe that can mutate state,
 * follow a redirect to an unlisted host, or silently hammer an endpoint is not
 * something to hand to an autonomous loop.
 */
export async function probeLiveContract(
    provider: string,
    version: string,
    url: string,
    options: LiveProbeOptions,
): Promise<LiveProbeResult> {
    if (options.allowlist.length === 0) {
        throw new ContractProbeError(
            "Live probe refused: allowlist is empty, so no host is trusted",
        );
    }

    let target: URL;
    try {
        target = new URL(url);
    } catch {
        throw new ContractProbeError(`Live probe refused: ${url} is not a valid URL`);
    }

    if (target.protocol !== "https:") {
        throw new ContractProbeError(
            `Live probe refused: ${target.protocol} is not https, so the response cannot be trusted`,
        );
    }

    const host = target.hostname.toLowerCase();
    const trusted = options.allowlist.some((entry) => {
        const normalized = entry.toLowerCase().replace(/^\./, "");
        return host === normalized || host.endsWith(`.${normalized}`);
    });
    if (!trusted) {
        throw new ContractProbeError(
            `Live probe refused: ${host} is not in the allowlist (${options.allowlist.join(", ")})`,
        );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
    let response: Response;
    try {
        response = await fetch(target, {
            method: "GET",
            redirect: "manual",
            signal: controller.signal,
            headers: { accept: "application/json", ...options.headers },
        });
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new ContractProbeError(`Live probe failed: ${reason}`);
    } finally {
        clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
        throw new ContractProbeError(
            `Live probe refused: ${host} returned a redirect to ${response.headers.get("location")}, which is not followed`,
        );
    }
    if (!response.ok) {
        throw new ContractProbeError(
            `Live probe failed: ${host} returned ${response.status}. An error body describes the error, not the resource, so it is not a usable contract.`,
        );
    }

    let payload: unknown;
    try {
        payload = await response.json();
    } catch {
        throw new ContractProbeError(
            `Live probe failed: ${host} returned a body that is not JSON`,
        );
    }

    const members = flattenMembers(payload);
    if (members.length === 0) {
        throw new ContractProbeError(
            `Live probe produced no members: ${host} returned JSON with no object fields`,
        );
    }

    return {
        status: response.status,
        memberCount: members.length,
        contract: {
            ...emptyContract(provider, version, "live", "authoritative", target.toString()),
            members: uniqueSorted(members),
        },
    };
}

export interface HarEntryLike {
    request: { url: string; method: string };
    response: {
        status: number;
        content: { mimeType: string; text?: string; encoding?: string };
    };
}

/**
 * A contract assembled from previously observed traffic. Every JSON response
 * body in the recording contributes its members, so the union covers every field
 * that was ever seen, not just the last response.
 *
 * The authority is `sampled` on purpose. A field missing from a recording is
 * far more likely to mean the sample was narrow than that the vendor dropped
 * it, and treating that as proof of removal is how you get a confident,
 * completely wrong migration.
 */
export function contractFromHar(
    provider: string,
    version: string,
    har: { log: { entries: HarEntryLike[] } },
    origin: string,
): VendorContract {
    const members: string[] = [];
    let kept = 0;

    for (const entry of har.log.entries) {
        if (entry.response.status >= 400) continue;
        if (!entry.response.content.mimeType.includes("json")) continue;
        const raw =
            entry.response.content.encoding === "base64" && entry.response.content.text
                ? Buffer.from(entry.response.content.text, "base64").toString("utf8")
                : entry.response.content.text;
        if (!raw) continue;
        try {
            const parsed: unknown = JSON.parse(raw);
            members.push(...flattenMembers(parsed));
            kept += 1;
        } catch {
            continue;
        }
    }

    if (kept === 0) {
        throw new ContractProbeError(
            "Recorded contract is empty: no successful JSON responses in the recording",
        );
    }

    return {
        ...emptyContract(provider, version, "recorded", "sampled", origin),
        members: uniqueSorted(members),
    };
}

function isOpenApiSpec(value: unknown): value is { components?: { schemas?: Record<string, unknown> } } {
    return (
        typeof value === "object" &&
        value !== null &&
        "components" in value &&
        typeof (value as { components?: unknown }).components === "object"
    );
}

function membersFromOpenApiSchema(schema: unknown, prefix = "", depth = 0): string[] {
    if (depth > 12 || typeof schema !== "object" || schema === null) return [];
    const node = schema as Record<string, unknown>;

    const paths: string[] = [];
    const properties = node.properties;
    if (properties && typeof properties === "object") {
        for (const [key, child] of Object.entries(properties as Record<string, unknown>)) {
            const path = prefix ? `${prefix}.${key}` : key;
            paths.push(path);
            paths.push(...membersFromOpenApiSchema(child, path, depth + 1));
        }
    }
    if (node.items) {
        const elementPrefix = prefix ? `${prefix}[]` : "[]";
        paths.push(...membersFromOpenApiSchema(node.items, elementPrefix, depth + 1));
    }
    for (const combinator of ["allOf", "anyOf", "oneOf"]) {
        const branches = node[combinator];
        if (Array.isArray(branches)) {
            for (const branch of branches) {
                paths.push(...membersFromOpenApiSchema(branch, prefix, depth + 1));
            }
        }
    }
    return paths;
}

function isReferenceDump(
    value: unknown,
): value is { classitems?: { name?: string }[]; consts?: Record<string, unknown> } {
    if (typeof value !== "object" || value === null) return false;
    const record = value as Record<string, unknown>;
    return Array.isArray(record.classitems) || typeof record.consts === "object";
}

/**
 * Builds a contract from a vendor's own API reference dump.
 *
 * This is the only source that can describe a library with no server to talk
 * to. A browser library like p5 emits no HTTP traffic, so traffic capture can
 * never see it, but p5 publishes its full reference as JSON, and every member
 * and constant in it is declared. For that class of vendor this is not a
 * fallback, it is the only way to check anything at all.
 *
 * Handles the two shapes vendors actually publish: a class/const reference dump
 * (p5's `data.json`, where members and constants are listed separately) and an
 * OpenAPI document (where members are nested under each schema).
 */
export function contractFromSpec(
    provider: string,
    version: string,
    spec: unknown,
    origin: string,
): VendorContract {
    const members: string[] = [];

    if (isOpenApiSpec(spec)) {
        for (const schema of Object.values(spec.components?.schemas ?? {})) {
            members.push(...membersFromOpenApiSchema(schema));
        }
    } else if (isReferenceDump(spec)) {
        for (const item of spec.classitems ?? []) {
            if (typeof item?.name === "string") members.push(item.name);
        }
        for (const name of Object.keys(spec.consts ?? {})) {
            members.push(name);
        }
    } else if (typeof spec === "object" && spec !== null) {
        const record = spec as Record<string, unknown>;
        const entries =
            typeof record.entries === "object" && record.entries !== null
                ? Object.values(record.entries as Record<string, unknown>)
                : [];
        for (const entry of entries) {
            if (typeof entry !== "object" || entry === null) continue;
            const member = entry as Record<string, unknown>;
            const name = member.name ?? member.class ?? member.member;
            if (typeof name === "string") members.push(name);
        }
    }

    if (members.length === 0) {
        throw new ContractProbeError(
            `Spec contract is empty: no member declarations found in ${origin}`,
        );
    }

    return {
        ...emptyContract(provider, version, "spec", "authoritative", origin),
        members: uniqueSorted(members),
    };
}

export interface FetchSpecOptions {
    timeoutMs?: number;
}

export async function fetchSpec(
    specUrl: string,
    options: FetchSpecOptions = {},
): Promise<{ spec: unknown; origin: string }> {
    if (!specUrl.startsWith("https://")) {
        throw new ContractProbeError(`Refusing to fetch spec from non-https ${specUrl}`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
    try {
        const response = await fetch(specUrl, {
            signal: controller.signal,
            headers: { accept: "application/json" },
        });
        if (!response.ok) {
            throw new ContractProbeError(
                `Fetching spec from ${specUrl} returned ${response.status}`,
            );
        }
        return { spec: await response.json(), origin: specUrl };
    } catch (error) {
        if (error instanceof ContractProbeError) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        throw new ContractProbeError(`Fetching spec from ${specUrl} failed: ${reason}`);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Builds a contract for a vendor from whichever source is available, preferring
 * the one that matches what the vendor actually is. A vendor with a REST
 * surface and credentials available can be probed live; one with a published
 * spec is described by that spec; anything else falls back to a recording.
 */
export interface ContractRequest {
    vendor: VendorConfig;
    version: string;
    live?: { url: string; headers?: Record<string, string>; allowlist: string[] };
    recordedHarPath?: string;
    useSpec?: boolean;
}

export async function resolveVendorContract(
    request: ContractRequest,
): Promise<{ contract: VendorContract; note: string }> {
    if (request.live) {
        const { contract } = await probeLiveContract(
            request.vendor.name,
            request.version,
            request.live.url,
            { allowlist: request.live.allowlist, headers: request.live.headers },
        );
        return { contract, note: `probed live at ${contract.origin}` };
    }

    const specUrl = request.vendor.docs?.specUrl;
    if (request.useSpec !== false && specUrl) {
        const { spec, origin } = await fetchSpec(specUrl);
        const contract = contractFromSpec(request.vendor.name, request.version, spec, origin);
        return { contract, note: `read the published spec at ${origin}` };
    }

    if (request.recordedHarPath) {
        const har = JSON.parse(await Bun.file(request.recordedHarPath).text()) as {
            log: { entries: HarEntryLike[] };
        };
        const contract = contractFromHar(
            request.vendor.name,
            request.version,
            har,
            request.recordedHarPath,
        );
        return { contract, note: `replayed the recording at ${request.recordedHarPath}` };
    }

    throw new ContractProbeError(
        `No contract source for ${request.vendor.name}: needs a live url, a specUrl, or a recording`,
    );
}

/**
 * Structural input for a drift observation, so this module composes with
 * `DriftResult` in the pipeline and `DriftAlert` in the webhook capture without
 * depending on either package.
 */
export interface ObservedDrift {
    provider: string;
    fromVersion: string;
    toVersion: string;
    removed: string[];
    added: string[];
    typeChanged: { field: string; from: string; to: string }[];
    docs?: string[];
}

/**
 * Builds a ChangePacket from an observed drift instead of from prose.
 *
 * This is the difference between a packet that asserts the vendor removed
 * `source` and a packet that was derived from a real PaymentIntent response
 * where `source` is gone and `payment_method` is present. The first is only as
 * trustworthy as whoever typed it, which in practice means it is exactly as
 * trustworthy as the model's memory of the vendor. The second cannot disagree
 * with the vendor, because the vendor produced it.
 */
export function changePacketFromDrift(drift: ObservedDrift): {
    provider: string;
    fromVersion: string;
    toVersion: string;
    summary: string;
    migrationDocs: string[];
    removed: string[];
    added: string[];
} {
    const lines: string[] = [
        `Observed on the wire between ${drift.fromVersion} and ${drift.toVersion}.`,
    ];

    if (drift.removed.length > 0) {
        lines.push(
            `The vendor stopped sending these fields: ${drift.removed.join(", ")}. Remove every read of them.`,
        );
    }
    if (drift.added.length > 0) {
        lines.push(
            `The vendor started sending these fields: ${drift.added.join(", ")}. They are the replacements.`,
        );
    }
    for (const change of drift.typeChanged) {
        lines.push(
            `${change.field} changed type from ${change.from} to ${change.to}. Update any code that assumed the old type.`,
        );
    }
    if (
        drift.removed.length === 0 &&
        drift.added.length === 0 &&
        drift.typeChanged.length === 0
    ) {
        lines.push("No field level change was observed.");
    }

    return {
        provider: drift.provider,
        fromVersion: drift.fromVersion,
        toVersion: drift.toVersion,
        summary: lines.join(" "),
        migrationDocs: drift.docs ?? [],
        removed: drift.removed,
        added: drift.added,
    };
}

export function describeContract(contract: VendorContract): string {
    const lines = [
        `vendor: ${contract.provider} ${contract.version}`,
        `source: ${contract.source} (${contract.authority}) from ${contract.origin}`,
        `captured: ${contract.capturedAt}`,
        `members: ${contract.members.length}`,
    ];
    if (contract.removed.length > 0) {
        lines.push(`removed by the vendor: ${contract.removed.join(", ")}`);
    }
    const shown = contract.members.slice(0, 200);
    lines.push("", "members:");
    for (const member of shown) lines.push(`- ${member}`);
    if (contract.members.length > shown.length) {
        lines.push(`- ...and ${contract.members.length - shown.length} more`);
    }
    lines.push(
        "",
        "Only reference members listed above. This list is the vendor's real surface, not a summary of the docs.",
    );
    return lines.join("\n");
}

const DECLARATION_PATTERNS: RegExp[] = [
    /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
    /\bfunction\s*\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)/g,
    /\bclass\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
    /\bimport\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\b/g,
    /\bimport\s*\{([^}]*)\}\s*from\b/g,
    /\bimport\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*,/g,
    /\bcatch\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)/g,
    /\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
];

const AMBIENT = new Set([
    "console", "process", "globalThis", "global", "window", "document", "Math",
    "JSON", "Object", "Array", "String", "Number", "Boolean", "Promise", "Symbol",
    "Date", "RegExp", "Error", "TypeError", "RangeError", "Map", "Set", "WeakMap",
    "WeakSet", "Proxy", "Reflect", "BigInt", "parseInt", "parseFloat", "isNaN",
    "isFinite", "encodeURIComponent", "decodeURIComponent", "fetch", "setTimeout",
    "clearTimeout", "setInterval", "clearInterval", "require", "module", "exports",
    "undefined", "NaN", "Infinity", "arguments", "this", "super", "void", "delete",
    "typeof", "instanceof", "in", "of", "return", "if", "else", "for", "while",
    "do", "switch", "case", "break", "continue", "try", "catch", "finally", "throw",
    "new", "await", "async", "class", "extends", "const", "let", "var", "function",
    "true", "false", "null", "yield", "static", "get", "set",
]);

/**
 * Every name bound somewhere in the source, used to tell a vendor constant used
 * correctly apart from one used as a free identifier.
 *
 * A regex scan over a whole file is coarse, and it is deliberately coarse in the
 * safe direction: it can only ever over-report bindings, which means it can only
 * ever fail to flag a genuine unbound constant. It cannot invent an unbound
 * name. A false negative is a missed bug, never a false accusation.
 */
export function collectBoundNames(source: string): Set<string> {
    const bound = new Set<string>(AMBIENT);

    for (const pattern of DECLARATION_PATTERNS) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(source)) !== null) {
            for (const group of match.slice(1)) {
                if (!group) continue;
                for (const part of group.split(",")) {
                    const name = part.split(":").pop()?.split("=")[0]?.trim() ?? "";
                    const cleaned = name.replace(/^\.\.\./, "");
                    if (SAFE_IDENTIFIER.test(cleaned)) bound.add(cleaned);
                }
            }
        }
    }

    const paramList = /\(([^)]*)\)\s*(?:=>|\{)/g;
    let params: RegExpExecArray | null;
    while ((params = paramList.exec(source)) !== null) {
        for (const part of params[1].split(",")) {
            const name = part.split("=")[0]?.trim().replace(/^\.\.\./, "") ?? "";
            if (SAFE_IDENTIFIER.test(name)) bound.add(name);
        }
    }

    return bound;
}

export interface SymbolFinding {
    kind: "unresolved" | "stale" | "unbound-constant";
    symbol: string;
    file: string;
    line: number;
    text: string;
    detail: string;
}

export interface VerifyOptions {
    vendor: VendorConfig;
    /**
     * Only meaningful to callers that also filter `sources` themselves. The file
     * list is already the map's keys, so this is documentation of intent.
     */
    files?: string[];
    /** Restrict checks to these receiver names, in addition to discovered ones. */
    clientNames?: string[];
    /**
     * When false, only `stale` findings are reported. Used for files the agent
     * did not change: a leftover read of a removed field is a missed call site
     * wherever it lives, but pre-existing use of some other field is not this
     * migration's problem and accusing it would be noise.
     */
    reportOnlyStale?: boolean;
}

const FREE_IDENTIFIER = /(?<![.\w$])([A-Z][A-Z0-9]+(?:_[A-Z0-9]+)*)(?![\w$])/g;
const LINE_COMMENT = /\/\/.*$/gm;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;

/**
 * Checks every vendor reference in the changed files against the contract.
 *
 * Three failure modes, each of which has actually happened:
 *
 * - `unresolved`: the code reads a member the contract does not have, so the
 *   model used a field or method that does not exist. Inventing a plausible
 *   name is the single most common way this goes wrong.
 * - `stale`: the code still reads a member the vendor removed. This is the
 *   completeness check, and it is the only thing that catches a migration that
 *   fixed four of five call sites.
 * - `unbound-constant`: the code uses a vendor constant as a free identifier
 *   when it is a member of an instance. `keyIsDown(UP_ARROW)` throws at runtime
 *   in instance mode; it typechecks, it lints, and it is wrong.
 */
export function verifyVendorSymbols(
    contract: VendorContract,
    sources: Map<string, string>,
    options: VerifyOptions,
): SymbolFinding[] {
    const members = contractMembers(contract);
    const removed = new Set(contract.removed);
    const constants = contractConstants(contract);
    const trie = buildTrie(contract.members);
    const authoritative = contract.authority === "authoritative";
    const findings: SymbolFinding[] = [];
    const instanceHint = options.vendor.clientNames[0] ?? "the instance";

    for (const [file, raw] of sources) {
        const source = raw
            .replace(BLOCK_COMMENT, (match) => match.replace(/[^\n]/g, " "))
            .replace(LINE_COMMENT, "");
        const receivers = new Set([
            ...discoverVendorReceivers(raw, options.vendor),
            ...(options.clientNames ?? []),
        ]);
        const lines = source.split("\n");
        const bound = collectBoundNames(raw);

        for (let index = 0; index < lines.length; index += 1) {
            const text = lines[index];
            const line = index + 1;

            for (const chain of extractMemberChains(text)) {
                if (!receivers.has(chain.receiver)) continue;
                const resolution = resolveChain(contract, chain, trie);
                if (resolution.ok) continue;

                const leaf = resolution.missing.split(".").pop() ?? resolution.missing;
                const stale = removed.has(leaf);

                if (!authoritative && !stale) continue;

                const kind = stale ? ("stale" as const) : ("unresolved" as const);
                if (options.reportOnlyStale && kind !== "stale") continue;

                findings.push({
                    kind,
                    symbol: resolution.missing,
                    file,
                    line,
                    text: text.trim(),
                    detail: stale
                        ? `the vendor removed ${leaf}, and this line still reads it`
                        : `${contract.provider} has no member ${resolution.missing}. The closest recorded names are ${closest(leaf, members, 3).join(", ") || "none"}.`,
                });
            }

            if (options.reportOnlyStale) continue;

            FREE_IDENTIFIER.lastIndex = 0;
            let free: RegExpExecArray | null;
            while ((free = FREE_IDENTIFIER.exec(text)) !== null) {
                const name = free[1];
                if (bound.has(name)) continue;
                if (!constants.has(name)) continue;

                findings.push({
                    kind: "unbound-constant",
                    symbol: name,
                    file,
                    line,
                    text: text.trim(),
                    detail: `${name} is a member of the ${contract.provider} instance, not a global. Write ${instanceHint}.${name}.`,
                });
            }
        }
    }

    return findings;
}

function closest(target: string, pool: Set<string>, limit: number): string[] {
    const scored = [...pool]
        .filter((candidate) => !candidate.includes("."))
        .map((candidate) => ({ candidate, distance: editDistance(target, candidate) }))
        .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate));
    return scored.slice(0, limit).map((entry) => entry.candidate);
}

function editDistance(a: string, b: string): number {
    const rows = a.length + 1;
    const cols = b.length + 1;
    let previous = Array.from({ length: cols }, (_, i) => i);
    for (let i = 1; i < rows; i += 1) {
        const current = [i];
        for (let j = 1; j < cols; j += 1) {
            current[j] = Math.min(
                previous[j] + 1,
                current[j - 1] + 1,
                previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
        }
        previous = current;
    }
    return previous[cols - 1];
}
