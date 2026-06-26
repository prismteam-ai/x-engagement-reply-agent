import { describe, it, expect, vi } from "vitest";
import { McpClient, parseJsonRpc } from "../src/mcp/client.js";

describe("parseJsonRpc", () => {
  it("parses plain JSON", () => {
    expect(parseJsonRpc('{"result":{"x":1}}')).toEqual({ result: { x: 1 } });
  });
  it("parses SSE data frame", () => {
    const sse = 'event: message\ndata: {"result":{"ok":true},"jsonrpc":"2.0","id":1}\n';
    expect(parseJsonRpc(sse)).toMatchObject({ result: { ok: true } });
  });
  it("throws on no data frame", () => {
    expect(() => parseJsonRpc("event: ping\n")).toThrow();
  });
});

function sseResponse(toolText: string): Response {
  const body = `event: message\ndata: ${JSON.stringify({
    result: { content: [{ type: "text", text: toolText }] },
    jsonrpc: "2.0",
    id: 1,
  })}\n`;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("McpClient.queryInvestorContent", () => {
  it("maps matches to ArticleMatch and clamps topK to 20", async () => {
    const toolText = JSON.stringify({
      matchCount: 1,
      matches: [
        {
          score: 0.7523,
          metadata: { title: "Soofi Article", sourceUri: "https://x.com/ssafavi/status/1" },
          blob: { content: "Truth becomes programmable when records leave silos." },
        },
      ],
    });
    let capturedBody: string | undefined;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return sseResponse(toolText);
    }) as unknown as typeof fetch;
    const client = new McpClient({ fetchImpl });

    const matches = await client.queryInvestorContent({ query: "q", topK: 40 });

    expect(matches).toHaveLength(1);
    expect(matches[0]!.rawScore).toBeCloseTo(0.7523);
    expect(matches[0]!.score).toBe(75);
    expect(matches[0]!.content).toContain("programmable");

    const sentBody = JSON.parse(capturedBody!);
    expect(sentBody.params.arguments.topK).toBe(20);
  });

  it("throws on JSON-RPC error", async () => {
    const errBody = `data: ${JSON.stringify({ error: { code: -32000, message: "boom" }, jsonrpc: "2.0", id: 1 })}\n`;
    const fetchImpl = vi.fn(async () => new Response(errBody, { status: 200 }));
    const client = new McpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.queryInvestorContent({ query: "q" })).rejects.toThrow("boom");
  });
});
