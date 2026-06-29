/**
 * ONE-OFF discovery harness (not part of the shipped runtime).
 *
 * For each candidate X handle: fetch recent tweets via the live X API, run each
 * tweet through the REAL no-token MCP (getTopSoofiArticleSimilarities), and
 * report the best raw score per tweet + per author. Used to curate
 * config/watchlist.yaml with authors whose RECENT real posts actually clear the
 * similarity gate against Soofi's RWA / property-tokenization corpus.
 *
 * Run:  pnpm tsx scripts/discover-authors.ts handle1 handle2 ...
 * No secrets are printed.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createXPoller } from "@/x/fetch-posts";
import { getTopSoofiArticleSimilarities } from "@/matching/article-similarity";
import type { WatchAuthor } from "@/config/load-watchlist";

function loadEnvLocal(): void {
  const path = resolve(process.cwd(), ".env.local");
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

async function main(): Promise<void> {
  loadEnvLocal();
  const handles = process.argv.slice(2);
  if (handles.length === 0) {
    console.error("usage: pnpm tsx scripts/discover-authors.ts <handle> [<handle> ...]");
    process.exit(1);
  }

  const watchlist: WatchAuthor[] = handles.map((h) => ({
    author: h,
    handle: h.replace(/^@/, ""),
    aliases: { handles: [], authors: [] },
    active: true,
  }));

  const poller = createXPoller({ maxResultsPerAuthor: 10 });
  const fetched = await poller({
    watchlist,
    // minimal settings
    settings: { defaultMaxPostsPerAuthor: 10 } as never,
    posts: [],
  });
  // The poller returns { posts, organic }; back-compat-normalize the bare array.
  const posts = Array.isArray(fetched) ? fetched : fetched.posts;

  console.log(`Fetched ${posts.length} tweets across ${handles.length} handle(s).\n`);

  const perAuthorBest = new Map<string, { best: number; tweet: string; statusId: string; title: string }>();

  for (const post of posts) {
    let matches: Awaited<ReturnType<typeof getTopSoofiArticleSimilarities>> = [];
    try {
      matches = await getTopSoofiArticleSimilarities(post.text, { topK: 6 });
    } catch (err) {
      console.log(`  [MCP error] ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const best = matches[0]?.rawScore ?? 0;
    const handle = post.handle ?? "(unknown)";
    const prev = perAuthorBest.get(handle);
    if (!prev || best > prev.best) {
      perAuthorBest.set(handle, {
        best,
        tweet: post.text.replace(/\s+/g, " ").slice(0, 160),
        statusId: post.statusId,
        title: matches[0]?.title ?? "",
      });
    }
    const flag = best >= 0.7 ? "✅" : best >= 0.68 ? "🟡" : "  ";
    console.log(
      `${flag} ${handle} ${post.statusId} best=${best.toFixed(4)} :: ${post.text.replace(/\s+/g, " ").slice(0, 110)}`,
    );
  }

  console.log("\n=== Per-author best ===");
  const sorted = Array.from(perAuthorBest.entries()).sort((a, b) => b[1].best - a[1].best);
  for (const [handle, info] of sorted) {
    console.log(
      `${info.best >= 0.68 ? "QUALIFIES" : "below    "} @${handle} best=${info.best.toFixed(4)} status=${info.statusId}`,
    );
    console.log(`    article: ${info.title}`);
    console.log(`    tweet:   ${info.tweet}`);
  }
}

main().catch((error) => {
  console.error("discover-authors failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
