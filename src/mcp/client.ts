import { z } from "zod";
import type { ArticleMatch } from "../domain/types.js";
import { makeExcerpt, toDisplayScore } from "../domain/pipeline-logic.js";
import { createLogger, type Logger } from "../observability/logger.js";

/**
 * Read-only client for the hosted investors-mcp server. Article matching MUST go
 * through this MCP `queryInvestorContent` tool — never direct vector/blob creds.
 *
 * Transport: streamable HTTP MCP (JSON-RPC over POST). The server is stateless
 * (no Mcp-Session-Id), so each request is initialize-free at the protocol level;
 * we send tools/call directly and parse the SSE `data:` frame.
 */

const DEFAULT_MCP_URL = "https://investors-mcp.vercel.app/mcp";
/** Server hard-caps topK at 20; clamp to avoid input-validation rejection. */
const MAX_TOP_K = 20;

/** Minimal interface the pipeline depends on, so MCP can be mocked in tests. */
export interface InvestorContentQuerier {
  queryInvestorContent(args: QueryInvestorContentArgs): Promise<ArticleMatch[]>;
}

export interface QueryInvestorContentArgs {
  query: string;
  author?: string;
  company?: string;
  contentType?: "post" | "article";
  segmentType?: "post_full" | "article_full" | "article_paragraph";
  topK?: number;
}

const matchSchema = z.object({
  score: z.number(),
  metadata: z
    .object({
      title: z.string().optional(),
      sourceUri: z.string().optional(),
      date: z.string().optional(),
    })
    .passthrough(),
  blob: z
    .object({
      content: z.string().optional(),
      title: z.string().optional(),
      sourceUri: z.string().optional(),
    })
    .passthrough()
    .optional(),
});

const resultSchema = z.object({
  matchCount: z.number().optional(),
  matches: z.array(matchSchema).default([]),
});

export interface McpClientOptions {
  url?: string;
  readToken?: string;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class McpClient implements InvestorContentQuerier {
  private readonly url: string;
  private readonly readToken?: string;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private nextId = 1;

  constructor(opts: McpClientOptions = {}) {
    this.url = opts.url ?? process.env.MCP_URL ?? DEFAULT_MCP_URL;
    this.readToken = opts.readToken ?? process.env.MCP_READ_TOKEN;
    this.logger = opts.logger ?? createLogger("mcp-client");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /** Call queryInvestorContent and map results to ArticleMatch[] (best first). */
  async queryInvestorContent(args: QueryInvestorContentArgs): Promise<ArticleMatch[]> {
    const topK = Math.min(args.topK ?? 6, MAX_TOP_K);
    const result = await this.call("queryInvestorContent", { ...args, topK });
    const parsed = resultSchema.parse(result);

    return parsed.matches
      .map((m): ArticleMatch => {
        const title = m.metadata.title ?? m.blob?.title ?? "(untitled)";
        const sourceUri = m.metadata.sourceUri ?? m.blob?.sourceUri ?? "";
        const content = m.blob?.content ?? "";
        return {
          title,
          sourceUri,
          rawScore: m.score,
          score: toDisplayScore(m.score),
          excerpt: makeExcerpt(content),
          content,
        };
      })
      .sort((a, b) => b.rawScore - a.rawScore);
  }

  /** Low-level JSON-RPC tools/call over streamable HTTP, returning the parsed tool result. */
  private async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    });

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.readToken) headers.Authorization = `Bearer ${this.readToken}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let raw: string;
    try {
      const res = await this.fetchImpl(this.url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`MCP HTTP ${res.status}: ${await res.text()}`);
      }
      raw = await res.text();
    } finally {
      clearTimeout(timer);
    }

    const envelope = parseJsonRpc(raw);
    if (envelope.error) {
      throw new Error(`MCP error ${envelope.error.code}: ${envelope.error.message}`);
    }
    const toolResult = envelope.result as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    if (toolResult?.isError) {
      throw new Error(`MCP tool ${name} returned isError`);
    }
    const textBlock = toolResult?.content?.find((c) => c.type === "text" && c.text);
    if (!textBlock?.text) {
      throw new Error(`MCP tool ${name} returned no text content`);
    }
    try {
      return JSON.parse(textBlock.text);
    } catch {
      throw new Error(`MCP tool ${name} returned non-JSON text content`);
    }
  }
}

interface JsonRpcEnvelope {
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Parse a JSON-RPC response that may arrive either as plain JSON or as an SSE
 * stream (`event: message\ndata: {...}`). Returns the last data frame.
 */
export function parseJsonRpc(raw: string): JsonRpcEnvelope {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed) as JsonRpcEnvelope;
  }
  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .filter((l) => l && l !== "[DONE]");
  if (dataLines.length === 0) {
    throw new Error("MCP response contained no JSON-RPC data frame");
  }
  return JSON.parse(dataLines[dataLines.length - 1]!) as JsonRpcEnvelope;
}
