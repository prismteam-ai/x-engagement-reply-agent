import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { resolvePositiveIntEnv, runWithRetry } from "@/agent/retry";

export const DEFAULT_INVESTORS_MCP_URL = "https://investors-mcp.vercel.app/mcp";

export type EnvLike = Record<string, string | undefined>;

export function resolveInvestorsMcpUrl(env: EnvLike = process.env): string {
  const fromEnv = (env.INVESTORS_MCP_URL || "").trim();
  return fromEnv || DEFAULT_INVESTORS_MCP_URL;
}

export type InvestorContentType = "post" | "article";

export type InvestorSegmentType = "post_full" | "article_full" | "article_paragraph";

export const INVESTORS_MCP_MAX_TOPK = 20;

export type QueryInvestorContentParams = {
  query: string;
  author?: string;
  contentType?: InvestorContentType;
  segmentType?: InvestorSegmentType;
  topK?: number;
};

export type InvestorContentMatch = {
  id?: string;
  score: number;
  key?: string;
  title?: string;
  sourceUri?: string;
  content?: string;
  metadata?: Record<string, unknown>;
  blob?: Record<string, unknown> | null;
};

export type QueryInvestorContentResult = {
  query: string;
  topK: number;
  matchCount: number;
  matches: InvestorContentMatch[];
};

const CLIENT_INFO = {
  name: "x-engagement-reply-agent",
  version: "0.1.0",
} as const;

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function extractToolTextPayload(result: unknown): string {
  const content = (result as { content?: unknown })?.content;
  if (!Array.isArray(content)) {
    throw new Error("MCP tool result had no content array");
  }
  const textParts: string[] = [];
  for (const part of content) {
    if (
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      textParts.push((part as { text: string }).text);
    }
  }
  if (textParts.length === 0) {
    throw new Error("MCP tool result had no text content");
  }
  return textParts.join("");
}

export function parseQueryInvestorContentPayload(
  text: string,
): QueryInvestorContentResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Failed to parse queryInvestorContent payload as JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("queryInvestorContent payload was not an object");
  }

  const payload = parsed as Record<string, unknown>;
  if (typeof payload.error === "string") {
    throw new Error(`queryInvestorContent returned an error: ${payload.error}`);
  }

  const rawMatches = Array.isArray(payload.matches) ? payload.matches : [];
  const matches: InvestorContentMatch[] = rawMatches.map((row) => {
    const record = (row && typeof row === "object" ? row : {}) as Record<string, unknown>;
    const blob =
      record.blob && typeof record.blob === "object"
        ? (record.blob as Record<string, unknown>)
        : null;
    const metadata =
      record.metadata && typeof record.metadata === "object"
        ? (record.metadata as Record<string, unknown>)
        : undefined;

    const title = asString(blob?.title) ?? asString(metadata?.title);
    const sourceUri = asString(blob?.sourceUri) ?? asString(metadata?.sourceUri);
    const content = asString(blob?.content);

    return {
      id: asString(record.id),
      score: toNumber(record.score),
      key: asString(record.key),
      title,
      sourceUri,
      content,
      metadata,
      blob,
    };
  });

  return {
    query: asString(payload.query) ?? "",
    topK: toNumber(payload.topK),
    matchCount: Number.isFinite(Number(payload.matchCount))
      ? Number(payload.matchCount)
      : matches.length,
    matches,
  };
}

export const DEFAULT_INVESTORS_MCP_MAX_RETRIES = 3;
export const DEFAULT_INVESTORS_MCP_REQUEST_TIMEOUT_MS = 15_000;

export function resolveInvestorsMcpMaxRetries(env: EnvLike = process.env): number {
  return resolvePositiveIntEnv(env, "INVESTORS_MCP_MAX_RETRIES", DEFAULT_INVESTORS_MCP_MAX_RETRIES, {
    minimum: 0,
  });
}

export function resolveInvestorsMcpTimeoutMs(env: EnvLike = process.env): number {
  return resolvePositiveIntEnv(
    env,
    "INVESTORS_MCP_REQUEST_TIMEOUT_MS",
    DEFAULT_INVESTORS_MCP_REQUEST_TIMEOUT_MS,
  );
}

function isNonTransientToolError(error: unknown): boolean {
  const status =
    (error as { statusCode?: number } | null)?.statusCode ??
    (error as { status?: number } | null)?.status;
  if (typeof status === "number" && status >= 400 && status <= 499 && status !== 429) {
    return true;
  }
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("queryinvestorcontent returned an error") ||
    message.includes("had no content array") ||
    message.includes("had no text content") ||
    message.includes("failed to parse queryinvestorcontent payload") ||
    message.includes("payload was not an object")
  );
}

export async function queryInvestorContent(
  params: QueryInvestorContentParams,
  options: { url?: string; env?: EnvLike } = {},
): Promise<InvestorContentMatch[]> {
  const url = options.url ?? resolveInvestorsMcpUrl(options.env);

  const envMax = Number.parseInt(
    String((options.env ?? process.env).INVESTORS_MCP_MAX_TOPK ?? "").trim(),
    10,
  );
  const maxTopK = Number.isFinite(envMax) && envMax >= 1 ? envMax : INVESTORS_MCP_MAX_TOPK;
  const wireTopK =
    typeof params.topK === "number" && params.topK > 0
      ? Math.min(params.topK, maxTopK)
      : undefined;

  const env = options.env ?? process.env;
  const maxRetries = resolveInvestorsMcpMaxRetries(env);
  const timeoutMs = resolveInvestorsMcpTimeoutMs(env);

  const attempt = async (signal: AbortSignal): Promise<InvestorContentMatch[]> => {
    const transport = new StreamableHTTPClientTransport(new URL(url));
    const client = new Client({ ...CLIENT_INFO });
    try {
      await client.connect(transport, { signal });
      const result = await client.callTool(
        {
          name: "queryInvestorContent",
          arguments: {
            query: params.query,
            ...(params.author ? { author: params.author } : {}),
            ...(params.contentType ? { contentType: params.contentType } : {}),
            ...(params.segmentType ? { segmentType: params.segmentType } : {}),
            ...(wireTopK ? { topK: wireTopK } : {}),
          },
        },
        undefined,
        { signal },
      );
      const text = extractToolTextPayload(result);
      return parseQueryInvestorContentPayload(text).matches;
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  };

  return runWithRetry(attempt, {
    maxRetries,
    timeoutMs,
    isRetryable: (error) => !isNonTransientToolError(error),
  });
}
