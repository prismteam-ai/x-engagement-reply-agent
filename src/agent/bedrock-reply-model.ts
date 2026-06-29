import type {
  ReplyModel,
  ReplyModelInput,
  ReplyModelOutput,
} from "@/agent/reply-generation";
import { MAX_REPLY_LENGTH } from "@/agent/reply-generation";
import {
  createBedrockReplyLanguageModel,
  loadConfiguredBedrockModelId,
  resolveBedrockConfig,
  type RuntimeEnv,
} from "@/agent/model";
import {
  createReplyToolLoopAgent,
  type ReplyToolLoopAgent,
} from "@/agent/tool-loop-agent";
import {
  isRetryableError,
  isThrottleError,
  runWithRetry,
} from "@/agent/retry";

export { isRetryableError, isThrottleError };

function normalizeWhitespace(value: string): string {
  return String(value ?? "").replace(/\r/g, "").replace(/\s+/g, " ").trim();
}

function createConcurrencyGate(limit: number): () => Promise<() => void> {
  let active = 0;
  const waiters: Array<() => void> = [];

  const release = (): void => {
    active -= 1;
    const next = waiters.shift();
    if (next) {
      active += 1;
      next();
    }
  };

  return () =>
    new Promise<() => void>((resolve) => {
      if (active < limit) {
        active += 1;
        resolve(release);
      } else {
        waiters.push(() => resolve(release));
      }
    });
}

function resolveMaxConcurrency(env: Record<string, string | undefined>): number {
  const raw = Number.parseInt((env.BEDROCK_MAX_CONCURRENCY ?? "").trim(), 10);
  return Number.isFinite(raw) && raw >= 1 ? raw : 1;
}

function resolveMaxRetries(env: Record<string, string | undefined>): number {
  const raw = Number.parseInt((env.BEDROCK_MAX_RETRIES ?? "").trim(), 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 4;
}

export const DEFAULT_BEDROCK_REQUEST_TIMEOUT_MS = 30_000;

export function resolveRequestTimeoutMs(env: Record<string, string | undefined>): number {
  const raw = Number.parseInt((env.BEDROCK_REQUEST_TIMEOUT_MS ?? "").trim(), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BEDROCK_REQUEST_TIMEOUT_MS;
}

export type GenerateWithRetryOptions = {
  maxRetries: number;
  timeoutMs: number;
};

export function generateWithRetry(
  generate: (signal: AbortSignal) => Promise<string>,
  options: GenerateWithRetryOptions,
): Promise<string> {
  return runWithRetry(generate, options);
}

function articleContext(input: ReplyModelInput): string {
  const parts = [
    ...input.supportingParagraphs,
    input.article.contextExcerpt,
    input.article.excerpt,
    input.article.title,
  ].map(normalizeWhitespace);
  return parts.filter(Boolean).join("\n\n").slice(0, 1800);
}

function buildSlotPrompt(input: ReplyModelInput): string {
  const context = articleContext(input);
  const questionRule = input.slot.endsWithQuestion
    ? "End the reply with a single thought-provoking question (a trailing '?')."
    : "Do NOT end the reply with a question; end with a statement.";

  return [
    "Global response constraints (these override any conflicting slot instruction):",
    input.constraints,
    "",
    `Reply style for this draft — "${input.slot.label}":`,
    input.slot.text,
    "",
    "Source post you are replying to:",
    normalizeWhitespace(input.post.text),
    "",
    `Matched Soofi article: ${normalizeWhitespace(input.article.title)}`,
    `Article source: ${input.article.sourceUri}`,
    "Article context (quote ONLY from this text — never invent quotes):",
    context || "(no extended context available; use the title verbatim if quoting)",
    "",
    "Requirements:",
    `- Maximum ${MAX_REPLY_LENGTH} characters, including the quoted phrase.`,
    "- Include one short phrase quoted VERBATIM from the article context above, wrapped in double quotes.",
    `- ${questionRule}`,
    "- Do not fabricate facts, figures, or quotes not present in the context.",
    "- Write in the first person as Soofi recommending a reply for human review.",
    "",
    "Respond with ONLY a compact JSON object, no markdown fences, of the shape:",
    '{"reply": "<the drafted reply>", "quote": "<the verbatim phrase you quoted>", "whyRecommended": "<one sentence on why this article fits the post>"}',
  ].join("\n");
}

function parseModelJson(
  raw: string,
): { reply?: string; quote?: string; whyRecommended?: string } {
  const text = String(raw ?? "").trim();
  if (!text) return {};

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() || text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  const jsonSlice = start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate;

  try {
    const parsed = JSON.parse(jsonSlice) as Record<string, unknown>;
    return {
      reply: typeof parsed.reply === "string" ? parsed.reply : undefined,
      quote: typeof parsed.quote === "string" ? parsed.quote : undefined,
      whyRecommended:
        typeof parsed.whyRecommended === "string" ? parsed.whyRecommended : undefined,
    };
  } catch {
    return { reply: text };
  }
}

export type CreateBedrockReplyModelOptions = {
  env?: RuntimeEnv;
  sessionId?: string;
  configModelId?: string;
};

export function createBedrockReplyModel(
  options: CreateBedrockReplyModelOptions = {},
): ReplyModel {
  const env = options.env ?? process.env;
  const configModelId = options.configModelId ?? loadConfiguredBedrockModelId();
  const { bedrockModelId } = resolveBedrockConfig(env, { configModelId });
  const model = createBedrockReplyLanguageModel(env, { configModelId });

  const acquire = createConcurrencyGate(resolveMaxConcurrency(env));
  const maxRetries = resolveMaxRetries(env);
  const timeoutMs = resolveRequestTimeoutMs(env);

  return async (input: ReplyModelInput): Promise<ReplyModelOutput> => {
    const sessionId = options.sessionId ?? input.article.sourceUri ?? input.post.statusId;
    const release = await acquire();

    const agent: ReplyToolLoopAgent = await createReplyToolLoopAgent({
      model,
      instructions: input.system,
      sessionId,
      bedrockModelId,
      maxOutputTokens: 1024,
      env,
    });

    try {
      const prompt = buildSlotPrompt(input);
      const raw = await generateWithRetry((signal) => agent.generateText(prompt, signal), {
        maxRetries,
        timeoutMs,
      });
      const parsed = parseModelJson(raw);

      const text = normalizeWhitespace(parsed.reply ?? raw);
      const output: ReplyModelOutput = { text };
      if (parsed.whyRecommended) {
        output.whyRecommended = normalizeWhitespace(parsed.whyRecommended);
      }
      return output;
    } finally {
      release();
      await agent.flush().catch(() => {
      });
    }
  };
}
