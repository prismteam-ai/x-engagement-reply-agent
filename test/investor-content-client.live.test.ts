import { describe, expect, it } from "vitest";
import {
  queryInvestorContent,
  resolveInvestorsMcpUrl,
} from "@/mcp/investor-content-client";
import { getTopSoofiArticleSimilarities } from "@/matching/article-similarity";

/**
 * LIVE integration test against the real PUBLIC investors-mcp endpoint.
 *
 * No token / no auth header is used — the hosted read path is public. If the MCP
 * is unreachable from this sandbox (offline CI, network egress blocked), the
 * tests call `ctx.skip()` with a clear reason instead of failing the suite. The
 * mocked unit tests in article-similarity.test.ts / investor-content-client.test.ts
 * always run and provide deterministic coverage.
 *
 * Set SKIP_LIVE_MCP=1 to force-skip (e.g. fully offline runs).
 */

const LIVE_TIMEOUT_MS = 30_000;

const SAMPLE_FINANCE_POST =
  "On-chain property records and tokenized real-world assets could make ownership and liens verifiable, turning real estate title into programmable financial infrastructure.";

async function isMcpReachable(url: string, timeoutMs = 8_000): Promise<boolean> {
  if (process.env.SKIP_LIVE_MCP === "1") return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "reachability-probe", version: "1.0.0" },
        },
      }),
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const RUN_LIVE = process.env.RUN_LIVE === "1";

describe.skipIf(!RUN_LIVE)("investors-mcp LIVE (public, no token)", () => {
  it(
    "queryInvestorContent returns matches with VISIBLE numeric scores",
    async (ctx) => {
      const url = resolveInvestorsMcpUrl();
      if (!(await isMcpReachable(url))) {
        ctx.skip();
        return;
      }

      const matches = await queryInvestorContent({
        query: "Ethereum scalability and rollups",
        topK: 3,
      });

      expect(Array.isArray(matches)).toBe(true);
      expect(matches.length).toBeGreaterThan(0);
      for (const m of matches) {
        expect(typeof m.score).toBe("number");
        expect(Number.isFinite(m.score)).toBe(true);
      }
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "getTopSoofiArticleSimilarities returns score-visible Soofi matches for a relevant post",
    async (ctx) => {
      const url = resolveInvestorsMcpUrl();
      if (!(await isMcpReachable(url))) {
        ctx.skip();
        return;
      }

      const matches = await getTopSoofiArticleSimilarities(SAMPLE_FINANCE_POST, { topK: 6 });

      // The hosted corpus may or may not contain Soofi content for this exact
      // query; we assert the call SUCCEEDS and any returned rows are well-formed
      // with visible scores (we do not hard-require non-empty Soofi matches to
      // avoid coupling the suite to corpus contents).
      expect(Array.isArray(matches)).toBe(true);
      expect(matches.length).toBeLessThanOrEqual(3);
      for (const m of matches) {
        expect(typeof m.rawScore).toBe("number");
        expect(typeof m.score).toBe("number");
        expect(m.score).toBeGreaterThanOrEqual(1);
        expect(m.score).toBeLessThanOrEqual(100);
        expect(m.sourceUri.length).toBeGreaterThan(0);
      }
    },
    LIVE_TIMEOUT_MS,
  );
});
