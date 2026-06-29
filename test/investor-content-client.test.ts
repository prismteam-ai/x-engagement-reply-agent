import { describe, expect, it } from "vitest";
import {
  DEFAULT_INVESTORS_MCP_URL,
  extractToolTextPayload,
  parseQueryInvestorContentPayload,
  resolveInvestorsMcpUrl,
} from "@/mcp/investor-content-client";

describe("resolveInvestorsMcpUrl", () => {
  it("defaults to the public no-token endpoint", () => {
    expect(resolveInvestorsMcpUrl({})).toBe(DEFAULT_INVESTORS_MCP_URL);
    expect(resolveInvestorsMcpUrl({ INVESTORS_MCP_URL: "  " })).toBe(DEFAULT_INVESTORS_MCP_URL);
  });

  it("honors INVESTORS_MCP_URL when set", () => {
    expect(resolveInvestorsMcpUrl({ INVESTORS_MCP_URL: "http://localhost:3000/mcp" })).toBe(
      "http://localhost:3000/mcp",
    );
  });
});

describe("extractToolTextPayload", () => {
  it("joins text content parts", () => {
    const text = extractToolTextPayload({
      content: [
        { type: "text", text: "{\"a\":" },
        { type: "text", text: "1}" },
      ],
    });
    expect(text).toBe('{"a":1}');
  });

  it("throws when there is no content array", () => {
    expect(() => extractToolTextPayload({})).toThrowError(/no content array/i);
  });

  it("throws when there is no text part", () => {
    expect(() => extractToolTextPayload({ content: [{ type: "image" }] })).toThrowError(
      /no text content/i,
    );
  });
});

describe("parseQueryInvestorContentPayload", () => {
  const payload = JSON.stringify({
    query: "tokenized real estate",
    topK: 5,
    matchCount: 2,
    matches: [
      {
        id: "m1",
        score: 0.82,
        key: "investors/soofisafavi/a1.json",
        metadata: { segmentType: "article_full", sourceUri: "https://meta/a1" },
        blob: {
          sourceUri: "https://x.com/i/article/a1",
          title: "Programmable Property",
          content: "Truth becomes programmable when property leaves silos.",
        },
      },
      {
        id: "m2",
        score: 0.41,
        metadata: {},
        blob: null,
      },
    ],
  });

  it("flattens matches with visible numeric scores", () => {
    const result = parseQueryInvestorContentPayload(payload);
    expect(result.query).toBe("tokenized real estate");
    expect(result.matchCount).toBe(2);
    expect(result.matches).toHaveLength(2);

    const first = result.matches[0]!;
    expect(first.score).toBeCloseTo(0.82);
    expect(first.title).toBe("Programmable Property");
    expect(first.sourceUri).toBe("https://x.com/i/article/a1");
    expect(first.content).toMatch(/programmable/i);
  });

  it("prefers blob fields but falls back to metadata for sourceUri/title", () => {
    const result = parseQueryInvestorContentPayload(
      JSON.stringify({
        matches: [
          { score: 0.5, metadata: { sourceUri: "https://meta/only", title: "Meta Title" }, blob: null },
        ],
      }),
    );
    expect(result.matches[0]?.sourceUri).toBe("https://meta/only");
    expect(result.matches[0]?.title).toBe("Meta Title");
  });

  it("defaults score to 0 for missing/invalid scores (still visible numeric)", () => {
    const result = parseQueryInvestorContentPayload(
      JSON.stringify({ matches: [{ blob: { sourceUri: "x" } }] }),
    );
    expect(result.matches[0]?.score).toBe(0);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseQueryInvestorContentPayload("not json")).toThrowError(/parse/i);
  });

  it("surfaces a server error payload", () => {
    expect(() =>
      parseQueryInvestorContentPayload(JSON.stringify({ error: "boom", query: "q" })),
    ).toThrowError(/returned an error: boom/i);
  });

  it("tolerates an empty matches list", () => {
    const result = parseQueryInvestorContentPayload(JSON.stringify({ query: "q", matches: [] }));
    expect(result.matches).toEqual([]);
    expect(result.matchCount).toBe(0);
  });
});
