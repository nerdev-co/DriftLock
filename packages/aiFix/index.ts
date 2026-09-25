import type { FixWork, ShapeDiffResult } from "@driftlock/diff";

export type AIProvider = "openai" | "anthropic" | "gemini" | "cloudflare";

export interface AIFixConfig {
    provider: AIProvider;
    apiKey: string;
    accountId?: string;
    model?: string;
    maxTokens?: number;
}

const SYSTEM_PROMPT =
    "You are an expert at fixing code when API schemas change. Migrate semantics, not just names. Understand what the old field meant, what the new field means, and how the behavior must change to stay correct. Preserve functionality.";

export interface FixContext {
    diff: ShapeDiffResult;
    works: FixWork[];
    sourceCode: string;
    filePath: string;
    eventType?: string;
}

export interface AIFixResult {
    fixedCode: string;
    explanation: string;
    confidence: number;
}

function buildPrompt(ctx: FixContext): string {
    const diffSummary = [
        ctx.diff.addedFields.length
            ? `Added fields: ${ctx.diff.addedFields.join(", ")}`
            : null,
        ctx.diff.removedFields.length
            ? `Removed fields: ${ctx.diff.removedFields.join(", ")}`
            : null,
        ctx.diff.typeChanges.length
            ? `Type changes: ${ctx.diff.typeChanges.map((c) => `${c.field}: ${c.oldType} → ${c.newType}`).join(", ")}`
            : null,
    ]
        .filter(Boolean)
        .join("\n");

    const worksSummary = ctx.works
        .map((w) => `- ${w.kind}: ${w.description}`)
        .join("\n");

    const hint = (() => {
        if (ctx.diff.removedFields.length === 1 && ctx.diff.addedFields.length === 1) {
            const r = ctx.diff.removedFields[0];
            const a = ctx.diff.addedFields[0];
            const parent = (p: string) => p.split(".").slice(0, -1).join(".");
            if (parent(r) === parent(a)) return `Heuristic hint: likely rename ${r} → ${a} (same parent, verify semantics before applying)`;
        }
        return null;
    })();

    return `You are a code migration assistant. An API schema changed and you need to fix the user's code.

 ## Schema Change
 ${diffSummary}
 ${hint ? `\n${hint}` : ""}

 ## Suggested Fixes
 ${worksSummary || "(no deterministic fixes available)"}

## Current Source Code (\`${ctx.filePath}\`)
\`\`\`typescript
${ctx.sourceCode}
\`\`\`

 ## Task
 Fix the source code to handle the schema change. Rules:
 1. Preserve all existing functionality — migrate semantics, not just names
 2. Only change what's necessary; if a field was renamed, update all code that relied on the old meaning to use the new field
 3. Add null checks where fields became nullable, type coercions where types changed
 4. If a field was removed with no replacement, do not invent a new name — explain the impact instead of guessing
 5. Keep the code style consistent and do not add explanatory comments
 6. Preserve original formatting and final newline

Return ONLY the fixed code inside a \`\`\`typescript block. After the code block, add a brief explanation of what you changed and a confidence score (0-100) for the fix.`;
}

function parseResponse(response: string): {
    code: string;
    explanation: string;
    confidence: number;
} {
    const codeMatch = response.match(/```typescript\n([\s\S]*?)```/);
    let code = codeMatch ? codeMatch[1] : "";
    // Preserve formatting: don't trim content, just ensure final newline
    if (code && !code.endsWith("\n")) code += "\n";

    const confMatch = response.match(/confidence[:\s]*(\d+)/i);
    const explanationMatch = response.match(/```\s*\n([\s\S]*?)$/);
    const explanation = explanationMatch ? explanationMatch[1].trim() : "AI-generated fix";
    if (!confMatch) {
        // Missing confidence is not invented — treat as 0 so caller rejects it
        return { code, explanation, confidence: 0 };
    }
    const confidence = parseInt(confMatch[1], 10);

    return { code, explanation, confidence };
}

async function callOpenAI(
    prompt: string,
    config: AIFixConfig,
): Promise<string> {
    const model = config.model || "gpt-4o";
    const maxTokens = config.maxTokens || 4096;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
            model,
            messages: [
                {
                    role: "system",
                    content: SYSTEM_PROMPT,
                },
                { role: "user", content: prompt },
            ],
            max_tokens: maxTokens,
            temperature: 0.2,
        }),
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`OpenAI API error: ${response.status} ${err}`);
    }

    const data = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
    };
    return data.choices[0]?.message?.content ?? "";
}

async function callAnthropic(
    prompt: string,
    config: AIFixConfig,
): Promise<string> {
    const model = config.model || "claude-sonnet-4-20250514";
    const maxTokens = config.maxTokens || 4096;

    const response = await fetch(
        "https://api.anthropic.com/v1/messages",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": config.apiKey,
                "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
                model,
                max_tokens: maxTokens,
                messages: [
                    {
                        role: "user",
                        content: prompt,
                    },
                ],
                temperature: 0.2,
            }),
        },
    );

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Anthropic API error: ${response.status} ${err}`);
    }

    const data = (await response.json()) as {
        content: Array<{ type: string; text: string }>;
    };
    return data.content[0]?.text ?? "";
}

async function callGemini(
    prompt: string,
    config: AIFixConfig,
): Promise<string> {
    const model = config.model || "gemini-2.5-flash";
    const maxTokens = config.maxTokens || 4096;
    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": config.apiKey,
            },
            body: JSON.stringify({
                systemInstruction: {
                    parts: [{ text: SYSTEM_PROMPT }],
                },
                contents: [
                    {
                        role: "user",
                        parts: [{ text: prompt }],
                    },
                ],
                generationConfig: {
                    maxOutputTokens: maxTokens,
                    temperature: 0.2,
                },
            }),
        },
    );

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Gemini API error: ${response.status} ${err}`);
    }

    const data = (await response.json()) as {
        candidates?: Array<{
            content?: { parts?: Array<{ text?: string }> };
        }>;
    };
    return data.candidates?.[0]?.content?.parts
        ?.map((part) => part.text ?? "")
        .join("") ?? "";
}

async function callCloudflare(
    prompt: string,
    config: AIFixConfig,
): Promise<string> {
    const accountId = config.accountId?.trim();
    if (!accountId) {
        throw new Error("Cloudflare account ID is required");
    }

    const model = config.model || "@cf/google/gemma-4-26b-a4b-it";
    if (!/^@cf\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(model)) {
        throw new Error("Cloudflare model must be a Workers AI model such as @cf/google/gemma-4-26b-a4b-it");
    }

    const maxTokens = config.maxTokens || 4096;
    const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify({
                messages: [
                    { role: "system", content: SYSTEM_PROMPT },
                    { role: "user", content: prompt },
                ],
                max_tokens: maxTokens,
                temperature: 0.2,
            }),
        },
    );

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Cloudflare Workers AI error: ${response.status} ${err}`);
    }

    const data = (await response.json()) as {
        result?: {
            response?: string;
            choices?: Array<{ message?: { content?: string } }>;
        };
    };
    return data.result?.response ??
        data.result?.choices?.[0]?.message?.content ??
        "";
}

export async function generateAIFix(
    ctx: FixContext,
    config: AIFixConfig,
): Promise<AIFixResult> {
    const prompt = buildPrompt(ctx);

    let raw: string;
    switch (config.provider) {
        case "openai":
            raw = await callOpenAI(prompt, config);
            break;
        case "anthropic":
            raw = await callAnthropic(prompt, config);
            break;
        case "gemini":
            raw = await callGemini(prompt, config);
            break;
        case "cloudflare":
            raw = await callCloudflare(prompt, config);
            break;
        default:
            throw new Error(`Unsupported AI provider: ${String(config.provider)}`);
    }

    const parsed = parseResponse(raw);

    if (!parsed.code) {
        throw new Error("AI returned no code in response");
    }

    return {
        fixedCode: parsed.code,
        explanation: parsed.explanation,
        confidence: parsed.confidence,
    };
}

export function generateAIFixSync(
    ctx: FixContext,
    mockResponse: string,
): AIFixResult {
    const parsed = parseResponse(mockResponse);
    if (!parsed.code) {
        throw new Error("AI returned no code in response");
    }
    return {
        fixedCode: parsed.code,
        explanation: parsed.explanation,
        confidence: parsed.confidence,
    };
}
