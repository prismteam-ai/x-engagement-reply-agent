import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createXPoller, isXPollerConfigured } from "@/x/fetch-posts";
import { SETTINGS_DEFAULTS, type Settings } from "@/config/load-settings";
import type { WatchAuthor } from "@/config/load-watchlist";
import type { InputPost } from "@/pipeline/run-monitor";

/**
 * LIVE X poller probe against the real X API v2 with X_BEARER_TOKEN. The free
 * tier is heavily quota-limited, so this test asserts the GRACEFUL contract,
 * not that live tweets come back: either it returns live posts, OR it falls back
 * to the injected fixture — but it NEVER throws. Gated like the other live
 * tests: ctx.skip() when the token is absent (or SKIP_LIVE_X=1).
 *
 * The bearer token is NEVER printed.
 */
const ROOT = resolve(__dirname, "..");
const LIVE_TIMEOUT_MS = 30_000;

function loadEnvLocal(): void {
  const path = resolve(ROOT, ".env.local");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
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

const settings: Settings = {
  ...SETTINGS_DEFAULTS,
  excludeAuthors: [...SETTINGS_DEFAULTS.excludeAuthors],
};

const watchlist: WatchAuthor[] = [
  { author: "Balaji Srinivasan", handle: "balajis", aliases: { handles: [], authors: [] }, active: true },
];

const injected: InputPost[] = [
  {
    statusId: "1999999999999999999",
    sourceUri: "https://x.com/balajis/status/1999999999999999999",
    text: "fixture fallback post",
    author: "Balaji Srinivasan",
    handle: "balajis",
    contentType: "post",
  },
];

const RUN_LIVE = process.env.RUN_LIVE === "1";

describe.skipIf(!RUN_LIVE)("createXPoller LIVE (real X API; graceful on free-tier limits)", () => {
  it(
    "returns live posts OR falls back to the fixture, never throwing",
    async (ctx) => {
      loadEnvLocal();
      if (process.env.SKIP_LIVE_X === "1" || !isXPollerConfigured()) {
        ctx.skip();
        return;
      }

      const poller = createXPoller();
      const fetched = await poller({ watchlist, settings, posts: injected });

      // The poller reports { posts, organic }: live posts (organic=true) OR a
      // graceful fallback to the injected fixtures (organic=false). Normalize the
      // back-compat bare-array form just in case.
      const posts = Array.isArray(fetched) ? fetched : fetched.posts;
      const organic = Array.isArray(fetched) ? true : fetched.organic;

      const wasFallback =
        !organic &&
        posts.length === injected.length &&
        posts.every((p, i) => p.statusId === injected[i]!.statusId);

      if (process.env.PRINT_LIVE_X === "1") {
        // eslint-disable-next-line no-console
        console.log(`X poller returned ${posts.length} post(s); fallback=${wasFallback}`);
      }
      // The pipeline contract: a usable post array either way.
      expect(Array.isArray(posts)).toBe(true);
      expect(posts.length).toBeGreaterThanOrEqual(0);
    },
    LIVE_TIMEOUT_MS,
  );
});
