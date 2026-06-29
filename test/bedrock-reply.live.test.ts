import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runMonitor, type InputPost } from "@/pipeline/run-monitor";
import { loadPromptBundle } from "@/config/load-prompts";
import { SETTINGS_DEFAULTS, type Settings } from "@/config/load-settings";
import type { WatchAuthor } from "@/config/load-watchlist";
import { resolveInvestorsMcpUrl } from "@/mcp/investor-content-client";
import { createBedrockReplyModel } from "@/agent/bedrock-reply-model";
import { isBedrockConfigured } from "@/agent/model";

/**
 * LIVE e2e: real MCP article match + REAL Bedrock (Opus 4.6) reply drafting,
 * dry-run (NO Asana writes). Mirrors the existing *.live.test.ts skip pattern —
 * it loads .env.local, and ctx.skip()s cleanly when the bearer token / model id
 * are absent or the MCP is unreachable, so the suite stays green offline /
 * without creds.
 *
 * Force-skip with SKIP_LIVE_BEDROCK=1 (or SKIP_LIVE_MCP=1 for the MCP probe).
 * The bearer token is NEVER printed.
 */
const LIVE_TIMEOUT_MS = 600_000;
const ROOT = resolve(__dirname, "..");

const SAMPLE_POST =
  "On-chain property records and tokenized real-world assets could make ownership and liens verifiable, turning real estate title into programmable financial infrastructure.";

/** Load .env.local into process.env (only keys not already set). Best-effort. */
function loadEnvLocal(): void {
  const path = resolve(ROOT, ".env.local");
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

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
    // Lower the recommendation threshold so a relevant live match is drafted,
    // but keep it high enough to limit the slot×article fan-out (Bedrock 429s).
    articleSimilarityThreshold: 0.3,
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

describe.skipIf(!RUN_LIVE)("runMonitor LIVE (real MCP + real Bedrock Opus draft, dry-run)", () => {
  it(
    "produces real (non-stub) grounded drafts, each with a quoted phrase, no Asana writes",
    async (ctx) => {
      loadEnvLocal();
      if (process.env.SKIP_LIVE_BEDROCK === "1" || !isBedrockConfigured()) {
        ctx.skip();
        return;
      }
      const url = resolveInvestorsMcpUrl();
      if (!(await isMcpReachable(url))) {
        ctx.skip();
        return;
      }

      const prompts = loadPromptBundle(resolve(ROOT, "prompts"));
      const model = createBedrockReplyModel();

      const { summary, tasks } = await runMonitor({
        posts: [post],
        settings: makeSettings(),
        watchlist,
        prompts,
        dryRun: true,
        deps: { model },
      });

      // Dry-run: zero writes.
      expect(summary.dryRun).toBe(true);
      expect(summary.counts.tasksCreated).toBe(0);

      // We expect at least one task with drafts for this on-topic post.
      const drafts = tasks.flatMap((t) => t.subtasks.map((s) => s.draftText));
      expect(drafts.length).toBeGreaterThan(0);

      if (process.env.PRINT_LIVE_DRAFTS === "1") {
        for (const t of tasks) {
          for (const s of t.subtasks) {
            // eslint-disable-next-line no-console
            console.log(`\n[DRAFT ${s.promptLabel} | ${s.draftText.length} chars]\n${s.draftText}`);
          }
        }
      }

      // Real (non-stub) drafts are those that are NOT the per-slot failure
      // placeholder. (Per-slot Bedrock failures — e.g. transient HTTP 429 on a
      // shared on-demand account — degrade gracefully to a placeholder; the kit
      // pattern is per-slot fault tolerance, so we require real drafts to exist,
      // not that EVERY slot succeeds on every run.)
      const realDrafts = drafts.filter((d) => !/^LLM generation failed/.test(d));
      expect(realDrafts.length).toBeGreaterThan(0);

      for (const draft of realDrafts) {
        // Real (non-stub) output: the stub always emits the fixed phrase
        // "I keep coming back to one idea here." — assert real drafts differ.
        expect(draft).not.toContain("I keep coming back to one idea here.");
        // Grounded: contains a double-quoted verbatim phrase.
        expect(draft).toMatch(/"[^"]+"/);
        // Length cap honored.
        expect(draft.length).toBeLessThanOrEqual(280);
      }

      // At least one real drafted reply ends in a question (the default rule).
      expect(realDrafts.some((d) => d.trim().endsWith("?"))).toBe(true);
    },
    LIVE_TIMEOUT_MS,
  );
});
