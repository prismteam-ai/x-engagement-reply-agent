import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runMonitor, type InputPost } from "@/pipeline/run-monitor";
import { createStubReplyModel } from "@/agent/reply-generation";
import { loadPromptBundle } from "@/config/load-prompts";
import { SETTINGS_DEFAULTS, type Settings } from "@/config/load-settings";
import type { WatchAuthor } from "@/config/load-watchlist";
import { resolveInvestorsMcpUrl } from "@/mcp/investor-content-client";

/**
 * LIVE integration test: the cred-free pipeline against the real PUBLIC
 * investors-mcp endpoint (no token). The reply model is still the deterministic
 * STUB and dryRun=true, so the only network egress is the MCP read.
 *
 * If the MCP is unreachable (offline CI / blocked egress) this test calls
 * ctx.skip() with a clear reason instead of failing. Set SKIP_LIVE_MCP=1 to
 * force-skip. The mocked run-monitor.test.ts always runs.
 */
const LIVE_TIMEOUT_MS = 30_000;
const ROOT = resolve(__dirname, "..");

const SAMPLE_POST =
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

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    pollIntervalMinutes: SETTINGS_DEFAULTS.pollIntervalMinutes,
    defaultBatchSize: SETTINGS_DEFAULTS.defaultBatchSize,
    defaultMaxPostsPerAuthor: SETTINGS_DEFAULTS.defaultMaxPostsPerAuthor,
    defaultTopK: SETTINGS_DEFAULTS.defaultTopK,
    asanaTaskSimilarityThreshold: SETTINGS_DEFAULTS.asanaTaskSimilarityThreshold,
    articleSimilarityThreshold: SETTINGS_DEFAULTS.articleSimilarityThreshold,
    bedrockModelId: SETTINGS_DEFAULTS.bedrockModelId,
    excludeAuthors: [...SETTINGS_DEFAULTS.excludeAuthors],
    paused: SETTINGS_DEFAULTS.paused,
    dryRun: SETTINGS_DEFAULTS.dryRun,
    ...overrides,
  };
}

const watchlist: WatchAuthor[] = [
  { author: "Balaji Srinivasan", handle: "balajis", aliases: { handles: [], authors: [] }, active: true },
];

const post: InputPost = {
  statusId: "1999999999999999999",
  sourceUri: "https://x.com/balajis/status/1999999999999999999",
  header: "Tokenized real-world assets",
  text: SAMPLE_POST,
  author: "Balaji Srinivasan",
  handle: "balajis",
  contentType: "post",
};

const RUN_LIVE = process.env.RUN_LIVE === "1";

describe.skipIf(!RUN_LIVE)("runMonitor LIVE (real no-token MCP, stub model, dry-run)", () => {
  it(
    "runs end to end with VISIBLE scores and creates zero writes",
    async (ctx) => {
      const url = resolveInvestorsMcpUrl();
      if (!(await isMcpReachable(url))) {
        ctx.skip();
        return;
      }
      const prompts = loadPromptBundle(resolve(ROOT, "prompts"));
      const { summary, tasks } = await runMonitor({
        posts: [post],
        settings: makeSettings(),
        watchlist,
        prompts,
        dryRun: true,
        deps: { model: createStubReplyModel() },
      });

      expect(summary.dryRun).toBe(true);
      expect(summary.counts.tasksCreated).toBe(0);
      expect(summary.posts).toHaveLength(1);
      // Any produced task carries visible numeric scores and per-slot drafts.
      for (const task of tasks) {
        expect(task.notes).toContain("raw=");
        expect(task.notes).toContain("score=");
        for (const rec of task.recommendations) {
          expect(rec.rawScore).toBeGreaterThanOrEqual(0);
          expect(rec.score).toBeGreaterThanOrEqual(1);
          expect(rec.score).toBeLessThanOrEqual(100);
        }
      }
    },
    LIVE_TIMEOUT_MS,
  );
});
