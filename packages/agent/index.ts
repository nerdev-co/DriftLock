import OpenAI from "openai";
import { DiffSummary, Fix, DriftEvent, VendorConfig } from "@driftlock/core";
import { validateVendorConfig } from "./docsToConfig";

export * from "./docsToConfig";
export * from "./tools";
export * from "./state";
export * from "./prompt";
export * from "./executor";
export * from "./vendorContract";
export * from "./repoFacts";
export * from "./commandRunner";
export * from "./publisher";
export * from "./migrationAgent";

export interface VendorConfigHints {
    /** Canonical vendor name, e.g. "stripe". */
    name?: string;
    /** npm package that provides the SDK. */
    sdk?: string;
    /** Variable names that resolve to the client in user code. */
    clientNames?: string[];
}

/**
 * Where resolved VendorConfigs live at runtime. The parser itself holds no
 * vendor knowledge; the pipeline consults one of these stores, seeded from
 * docs (this agent) or sandbox traffic, so ANY vendor works with no code
 * changes and no hardcoded table.
 */
export interface VendorConfigStore {
    /** Look a package up by npm name. Returns null when unknown. */
    get(packageName: string): VendorConfig | null;
    /** Persist a validated config. */
    set(config: VendorConfig): void;
}

/**
 * In-memory endpoint-knowledge cache, keyed by npm package name.
 * Seeded by the docs agent or the sandbox; read by the parser pipeline.
 */
export class InMemoryVendorStore implements VendorConfigStore {
    private configs = new Map<string, VendorConfig>();

    /**
     * @param packageName - npm package, e.g. "stripe" or "@acme/posts-sdk".
     * @returns The config for that package, or null when unknown.
     */
    get(packageName: string): VendorConfig | null {
        return this.configs.get(packageName) ?? null;
    }

    /**
     * Store a config under both its sdk and its name.
     * @param config - Validated VendorConfig.
     */
    set(config: VendorConfig): void {
        for (const key of [config.sdk, config.name]) {
            if (key) this.configs.set(key, config);
        }
    }

    /** Every distinct config held, in insertion order. */
    get all(): VendorConfig[] {
        return [...new Set(this.configs.values())];
    }

    /** Drop every held config (test teardown). */
    clear(): void {
        this.configs.clear();
    }
}

const defaultStore = new InMemoryVendorStore();

export interface ChangeAnalysis {
    summary: string;
    impact: "breaking" | "non-breaking" | "unknown";
    confidence: "high" | "medium" | "low";
    affectedCallSites: string[];
    reasoning: string;
}

export interface FixGeneration {
    fix: Fix;
    explanation: string;
    alternatives: Array<{
        description: string;
        diff: string;
        tradeoffs: string;
    }>;
}

export class Agent {
    private openai: OpenAI;

    constructor(apiKey: string) {
        this.openai = new OpenAI({ apiKey });
    }

    async analyzeChange(
        oldSnapshot: Record<string, unknown>,
        newSnapshot: Record<string, unknown>,
        diff: DiffSummary,
    ): Promise<ChangeAnalysis> {
        const prompt = this.buildAnalysisPrompt(oldSnapshot, newSnapshot, diff);

        const response = await this.openai.chat.completions.create({
            model: "gpt-4",
            messages: [
                {
                    role: "system",
                    content: `You are an API drift analysis expert. Analyze changes between API snapshots and determine:
1. What changed (summary)
2. Impact level (breaking/non-breaking/unknown)
3. Confidence level (high/medium/low)
4. Which call sites are affected
5. Your reasoning

Be precise and technical. Focus on backward compatibility.`,
                },
                {
                    role: "user",
                    content: prompt,
                },
            ],
            temperature: 0.1,
        });

        const content = response.choices[0]?.message?.content || "";
        return this.parseAnalysisResponse(content);
    }

    async generateFix(
        driftEvent: DriftEvent,
        callSiteContext: string,
    ): Promise<FixGeneration> {
        const prompt = this.buildFixPrompt(driftEvent, callSiteContext);

        const response = await this.openai.chat.completions.create({
            model: "gpt-4",
            messages: [
                {
                    role: "system",
                    content: `You are a code fix generator. Generate precise, minimal fixes for API drift issues.

Rules:
1. Generate the smallest possible change
2. Maintain backward compatibility when possible
3. Provide clear explanations
4. Include alternative approaches if applicable
5. Consider edge cases and error handling

Output format:
- Primary fix with diff
- Explanation of the fix
- Alternative approaches with tradeoffs`,
                },
                {
                    role: "user",
                    content: prompt,
                },
            ],
            temperature: 0.2,
        });

        const content = response.choices[0]?.message?.content || "";
        return this.parseFixResponse(content, driftEvent.id);
    }

    /**
     * Turn raw vendor documentation (prose and/or an embedded OpenAPI spec)
     * into a validated VendorConfig the parser can consume. Uses JSON mode and
     * runtime validation, so a malformed model response fails loudly rather
     * than poisoning downstream extraction.
     */
    async inferVendorConfig(
        docsText: string,
        hints: VendorConfigHints = {},
    ): Promise<VendorConfig> {
        const response = await this.openai.chat.completions.create({
            model: "gpt-4",
            response_format: { type: "json_object" },
            temperature: 0,
            messages: [
                {
                    role: "system",
                    content: `You extract an SDK description from vendor API documentation into JSON.

Return a single JSON object with exactly these fields:
{
  "name": string,            // canonical vendor name, lowercase, e.g. "stripe"
  "sdk": string,             // npm package that provides the SDK, e.g. "stripe"
  "clientNames": string[],   // variable names users assign the client to, e.g. ["stripe"]
  "basePath": string,        // URL prefix shared by all endpoints, e.g. "/v1"
  "resources": {             // OPTIONAL; only exceptions to standard CRUD inference
    "<resource>": {
      "overrides": { "<method>": "/path/:id/action" },
      "httpMethods": { "<method>": "DELETE" }
    }
  },
  "docs": { "url": string, "specUrl": string }  // OPTIONAL
}

Rules:
- Use camelCase resource segments; nested resources are dot-separated ("checkout.sessions").
- Standard CRUD methods (create/list/retrieve/update/delete) need NO entry; only emit
  overrides for custom actions or endpoints that differ from the default inference
  (collection for create/list, /:id for retrieve/update/delete, /:id/<action> otherwise).
- httpMethods is only needed when a method's verb differs from its default
  (create/update → POST, retrieve/list → GET, delete → DELETE, actions → POST).
- Return only the JSON object, no prose.`,
                },
                {
                    role: "user",
                    content: this.buildVendorConfigPrompt(docsText, hints),
                },
            ],
        });

        const content = response.choices[0]?.message?.content ?? "";

        let parsed: unknown;
        try {
            parsed = JSON.parse(content);
        } catch {
            throw new Error(
                "inferVendorConfig: model did not return valid JSON",
            );
        }

        return validateVendorConfig(parsed);
    }

    /**
     * On-demand endpoint knowledge for ANY vendor, keyed by npm package.
     * Returns the cached config when present (no LLM call), derives one from
     * docs text when available, and returns null when neither exists. The
     * call site is still captured generically, just without a resolved
     * endpoint; the sandbox fills that from traffic.
     *
     * @param packageName - npm package to resolve, e.g. "@sendgrid/mail".
     * @param docsText - Raw vendor docs, or null to skip inference.
     * @param options - Cache store and identity hints for the model.
     * @returns A validated VendorConfig, or null when unresolvable.
     */
    async ensureVendorConfig(
        packageName: string,
        docsText: string | null,
        options: {
            store?: VendorConfigStore;
            hints?: VendorConfigHints;
        } = {},
    ): Promise<VendorConfig | null> {
        const store = options.store ?? defaultStore;
        const cached = store.get(packageName);
        if (cached) return cached;

        if (!docsText) return null;

        const config = await this.inferVendorConfig(docsText, {
            sdk: packageName,
            ...options.hints,
        });
        store.set(config);
        return config;
    }

    private buildVendorConfigPrompt(
        docsText: string,
        hints: VendorConfigHints,
    ): string {
        const hintLines: string[] = [];
        if (hints.name) hintLines.push(`name: ${hints.name}`);
        if (hints.sdk) hintLines.push(`sdk: ${hints.sdk}`);
        if (hints.clientNames?.length) {
            hintLines.push(`clientNames: ${hints.clientNames.join(", ")}`);
        }

        return `${
            hintLines.length > 0
                ? `Known fields (trust these over your inference):\n${hintLines.join("\n")}\n\n`
                : ""
        }## Vendor Documentation
${docsText}`;
    }

    private buildAnalysisPrompt(
        oldSnapshot: Record<string, unknown>,
        newSnapshot: Record<string, unknown>,
        diff: DiffSummary,
    ): string {
        return `
## Old API Snapshot
\`\`\`json
${JSON.stringify(oldSnapshot, null, 2)}
\`\`\`

## New API Snapshot
\`\`\`json
${JSON.stringify(newSnapshot, null, 2)}
\`\`\`

## Detected Changes
- Added fields: ${diff.addedFields.join(", ") || "none"}
- Removed fields: ${diff.removedFields.join(", ") || "none"}
- Type changes: ${diff.typeChanges.map((c: { field: string; oldType: string; newType: string }) => `${c.field}: ${c.oldType} → ${c.newType}`).join(", ") || "none"}
- Optionality changes: ${diff.optionalityChanges.map((c: { field: string; wasRequired: boolean; nowRequired: boolean }) => `${c.field}: ${c.wasRequired ? "required" : "optional"} → ${c.nowRequired ? "required" : "optional"}`).join(", ") || "none"}

## Breaking Changes
${diff.breakingChanges.join("\n") || "none"}

## Non-Breaking Changes
${diff.nonBreakingChanges.join("\n") || "none"}

Please analyze this API drift and provide your assessment.
`;
    }

    private buildFixPrompt(
        driftEvent: DriftEvent,
        callSiteContext: string,
    ): string {
        return `
## Drift Event
ID: ${driftEvent.id}
Detected: ${driftEvent.detectedAt}
Confidence: ${driftEvent.confidence}

## Diff Summary
${JSON.stringify(driftEvent.diffSummary, null, 2)}

## Call Site Context
\`\`\`typescript
${callSiteContext}
\`\`\`

## Current Status
${driftEvent.status}

Please generate a fix for this API drift issue.
`;
    }

    private parseAnalysisResponse(content: string): ChangeAnalysis {
        // Parse the AI response into structured data
        // This is a simplified parser - in production, you'd want more robust parsing
        const lines = content.split("\n");

        let summary = "";
        let impact: "breaking" | "non-breaking" | "unknown" = "unknown";
        let confidence: "high" | "medium" | "low" = "medium";
        let affectedCallSites: string[] = [];
        let reasoning = "";

        for (const line of lines) {
            if (line.toLowerCase().includes("summary:")) {
                summary = line.split(":")[1]?.trim() || "";
            } else if (line.toLowerCase().includes("impact:")) {
                const impactStr =
                    line.split(":")[1]?.trim().toLowerCase() || "";
                if (impactStr.includes("non-breaking")) impact = "non-breaking";
                else if (impactStr.includes("breaking")) impact = "breaking";
                else impact = "unknown";
            } else if (line.toLowerCase().includes("confidence:")) {
                const confStr = line.split(":")[1]?.trim().toLowerCase() || "";
                if (confStr.includes("high")) confidence = "high";
                else if (confStr.includes("low")) confidence = "low";
                else confidence = "medium";
            } else if (line.toLowerCase().includes("affected:")) {
                const sitesStr = line.split(":")[1]?.trim() || "";
                affectedCallSites = sitesStr
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);
            } else if (line.toLowerCase().includes("reasoning:")) {
                reasoning = line.split(":")[1]?.trim() || "";
            }
        }

        return {
            summary: summary || "API change detected",
            impact,
            confidence,
            affectedCallSites,
            reasoning: reasoning || "Analysis based on API snapshot comparison",
        };
    }

    private parseFixResponse(
        content: string,
        driftEventId: string,
    ): FixGeneration {
        // Parse the AI response into structured fix data
        // This is a simplified parser - in production, you'd want more robust parsing
        const lines = content.split("\n");

        let description = "";
        let diff = "";
        let explanation = "";
        const alternatives: Array<{
            description: string;
            diff: string;
            tradeoffs: string;
        }> = [];

        let currentSection = "";
        let currentAlternative: {
            description: string;
            diff: string;
            tradeoffs: string;
        } = { description: "", diff: "", tradeoffs: "" };

        for (const line of lines) {
            if (line.toLowerCase().includes("description:")) {
                description = line.split(":")[1]?.trim() || "";
                currentSection = "description";
            } else if (line.toLowerCase().includes("diff:")) {
                diff = line.split(":")[1]?.trim() || "";
                currentSection = "diff";
            } else if (line.toLowerCase().includes("explanation:")) {
                explanation = line.split(":")[1]?.trim() || "";
                currentSection = "explanation";
            } else if (line.toLowerCase().includes("alternative:")) {
                if (currentAlternative.description) {
                    alternatives.push({ ...currentAlternative });
                }
                currentAlternative = {
                    description: line.split(":")[1]?.trim() || "",
                    diff: "",
                    tradeoffs: "",
                };
                currentSection = "alternative";
            } else if (
                line.toLowerCase().includes("tradeoffs:") &&
                currentSection === "alternative"
            ) {
                currentAlternative.tradeoffs = line.split(":")[1]?.trim() || "";
            } else if (currentSection === "diff" && line.startsWith("```")) {
                // Skip code block markers
            } else if (currentSection === "diff") {
                diff += (diff ? "\n" : "") + line;
            }
        }

        if (currentAlternative.description) {
            alternatives.push(currentAlternative);
        }

        const fix: Fix = {
            id: `fix_${driftEventId}`,
            driftEventId,
            type: "custom",
            description: description || "Apply suggested fix",
            diff: diff || "",
            confidence: "medium",
            files: [],
            generatedAt: new Date(),
        };

        return {
            fix,
            explanation:
                explanation || "Fix generated based on API drift analysis",
            alternatives,
        };
    }
}
