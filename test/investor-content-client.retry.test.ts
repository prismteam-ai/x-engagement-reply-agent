import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const callTool = vi.fn();
const connect = vi.fn(async () => {});
const close = vi.fn(async () => {});

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect,
    callTool: (...args: unknown[]) => callTool(...args),
    close,
  })),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation(() => ({
    close: vi.fn(async () => {}),
  })),
}));

import { queryInvestorContent } from "@/mcp/investor-content-client";

function textResult(matches: unknown[]): { content: { type: "text"; text: string }[] } {
  return {
    content: [{ type: "text", text: JSON.stringify({ query: "q", matchCount: matches.length, matches }) }],
  };
}

const okMatches = [{ id: "m1", score: 0.9, blob: { sourceUri: "https://x/a", title: "T", content: "body" } }];

const baseOptions = { url: "https://mcp.test/mcp", env: {} as Record<string, string | undefined> };

beforeEach(() => {
  callTool.mockReset();
  connect.mockClear();
  close.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("queryInvestorContent retry", () => {
  it("retries a transient 5xx then succeeds", async () => {
    callTool
      .mockRejectedValueOnce(Object.assign(new Error("Bad Gateway"), { status: 502 }))
      .mockResolvedValueOnce(textResult(okMatches));

    vi.useFakeTimers();
    const promise = queryInvestorContent({ query: "tokenized property" }, baseOptions);
    await vi.runAllTimersAsync();
    const matches = await promise;

    expect(matches).toHaveLength(1);
    expect(matches[0]!.sourceUri).toBe("https://x/a");
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("retries a request timeout then succeeds", async () => {
    callTool
      .mockImplementationOnce(
        (_params: unknown, _schema: unknown, options: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
      )
      .mockResolvedValueOnce(textResult(okMatches));

    vi.useFakeTimers();
    const promise = queryInvestorContent(
      { query: "q" },
      { ...baseOptions, env: { INVESTORS_MCP_REQUEST_TIMEOUT_MS: "50" } },
    );
    await vi.runAllTimersAsync();
    const matches = await promise;

    expect(matches).toHaveLength(1);
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it("throws immediately on a clear non-transient error (no retry)", async () => {
    callTool.mockRejectedValue(Object.assign(new Error("Bad Request"), { status: 400 }));

    await expect(queryInvestorContent({ query: "q" }, baseOptions)).rejects.toThrow(/Bad Request/);
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("throws (fail-loud) after the retry budget is exhausted — never empty-success", async () => {
    callTool.mockRejectedValue(Object.assign(new Error("Service Unavailable"), { status: 503 }));

    vi.useFakeTimers();
    const promise = queryInvestorContent(
      { query: "q" },
      { ...baseOptions, env: { INVESTORS_MCP_MAX_RETRIES: "2" } },
    );
    const assertion = expect(promise).rejects.toThrow(/Service Unavailable/);
    await vi.runAllTimersAsync();
    await assertion;
    expect(callTool).toHaveBeenCalledTimes(3);
  });

  it("does not retry a server error payload (non-transient tool error)", async () => {
    callTool.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ error: "invalid filter", query: "q" }) }],
    });

    await expect(queryInvestorContent({ query: "q" }, baseOptions)).rejects.toThrow(/invalid filter/);
    expect(callTool).toHaveBeenCalledTimes(1);
  });
});
