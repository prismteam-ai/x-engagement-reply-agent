/**
 * LIVE end-to-end showcase bake (NON-dry-run).
 *
 * Wires the full pipeline with real creds:
 *   poll (X live, ALL active watchlist authors)  →  MCP article match (real)
 *     →  Opus drafts (real Bedrock)  →  create REAL parent + subtasks in the
 *        configured Asana TEST project for each qualifying post.
 *
 * SCOPE — multi-author, newest post per author:
 *   The bake polls EVERY active watchlist author from the live X API and takes
 *   each author's single most-recent tweet. Those genuinely-polled posts are
 *   passed to the pipeline verbatim, so the run is flagged organic. Only posts
 *   above the similarity threshold create Asana tasks (typically few), so the
 *   persisted snapshot stays well under the state store's per-item size limit;
 *   the saveShowcaseRun headline reduction further bounds it to one best task
 *   while keeping the run-summary counts (authorsPolled across the full active
 *   set, postsFetched, matched, tasksCreated) complete.
 *
 * If the live poll returns nothing for every author (free-tier quota), the bake
 * aborts loudly rather than baking a synthetic fixture as a "real" match.
 *
 * Loads .env.local (only keys not already set). Forces BEDROCK_MAX_CONCURRENCY=1
 * (unless already set) so the per-slot Bedrock fan-out is serialized and drafts
 * come out ALL-REAL (no transient 429 placeholders). The bearer token / PAT are
 * NEVER printed.
 *
 * Run:  pnpm tsx scripts/live-e2e.ts   (or: pnpm live:e2e)
 *
 * After a successful run it refreshes BOTH the informational latest-run snapshot
 * and the durable SHOWCASE snapshot the public /status page renders.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runFromConfig } from "@/pipeline/run-from-config";
import { saveLatestRun, saveShowcaseRun } from "@/pipeline/run-store";
import { loadSettings } from "@/config/load-settings";
import { loadActiveWatchlist, type WatchAuthor } from "@/config/load-watchlist";
import { isBedrockConfigured } from "@/agent/model";
import { isAsanaConfigured } from "@/asana/asana-client";
import { createXPoller, isXPollerConfigured } from "@/x/fetch-posts";
import type { InputPost } from "@/pipeline/run-monitor";

/** Process only the most-recent polled tweet per author so the bake stays bounded. */
const MAX_POSTS_PER_AUTHOR = 1;

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

/** Most-recent first by snowflake status id (longer id wins, then lexicographic). */
function newestFirst(a: InputPost, b: InputPost): number {
  const ai = String(a.statusId ?? "");
  const bi = String(b.statusId ?? "");
  if (ai.length !== bi.length) return bi.length - ai.length;
  return ai < bi ? 1 : ai > bi ? -1 : 0;
}

/**
 * Poll one active author from the LIVE X API and return its most-recent tweet
 * (or null when the poll yielded nothing live — e.g. free-tier quota). The X API's
 * per-author minimum is 5, so we request the floor and trim to one here.
 */
async function pollNewestPost(author: WatchAuthor): Promise<InputPost | null> {
  const settings = loadSettings(resolve(process.cwd(), "config/settings.yaml"));
  const poll = createXPoller({ maxResultsPerAuthor: 5 });
  const fetched = await poll({ watchlist: [author], settings, posts: [] });
  const posts = Array.isArray(fetched) ? fetched : fetched.posts;
  const organic = Array.isArray(fetched) ? true : fetched.organic;
  if (!organic || posts.length === 0) return null;
  const newest = [...posts].sort(newestFirst).slice(0, MAX_POSTS_PER_AUTHOR);
  return newest[0] ?? null;
}

async function main(): Promise<void> {
  loadEnvLocal();

  // Serialize Bedrock slot calls so drafts are all-real (avoid on-demand 429s).
  if (!process.env.BEDROCK_MAX_CONCURRENCY) process.env.BEDROCK_MAX_CONCURRENCY = "1";

  const bedrock = isBedrockConfigured();
  const asana = isAsanaConfigured();
  const xPoller = isXPollerConfigured();

  const activeWatchlist = loadActiveWatchlist(resolve(process.cwd(), "config/watchlist.yaml"));

  console.log("=== LIVE e2e (NON-dry-run) ===");
  console.log(
    `activeAuthors=${activeWatchlist.length}  maxPostsPerAuthor=${MAX_POSTS_PER_AUTHOR}  ` +
      `model=${bedrock ? "BEDROCK(Opus)" : "stub"}  asana=${asana ? "LIVE" : "OFF"}  ` +
      `xPoller=${xPoller ? "LIVE" : "OFF"}  BEDROCK_MAX_CONCURRENCY=${process.env.BEDROCK_MAX_CONCURRENCY}`,
  );
  if (!asana) {
    console.error("Asana is not configured (ASANA_PAT/ASANA_PROJECT_GID/ASANA_WORKSPACE_GID). Aborting LIVE run.");
    process.exit(1);
  }
  if (!xPoller) {
    console.error("X poller is not configured (X_BEARER_TOKEN). Aborting — a showcase bake must poll real tweets.");
    process.exit(1);
  }
  if (activeWatchlist.length === 0) {
    console.error("Active watchlist is empty. Aborting — a multi-author showcase needs >=1 active author.");
    process.exit(1);
  }

  // ORGANIC + BOUNDED: poll EVERY active author live and take ONLY each one's
  // newest tweet. The pipeline then matches/drafts/tasks the genuinely-polled posts.
  const polled: InputPost[] = [];
  for (const author of activeWatchlist) {
    const handle = author.handle.replace(/^@/, "");
    const newest = await pollNewestPost(author);
    if (!newest) {
      console.log(`@${handle}: no live tweet (X free-tier quota likely) — skipped.`);
      continue;
    }
    console.log(
      `@${handle}: status=${newest.statusId} :: ${newest.text.replace(/\s+/g, " ").slice(0, 100)}`,
    );
    polled.push(newest);
  }

  if (polled.length === 0) {
    console.error(
      "Live poll of every active author returned no tweet (X free-tier quota likely). " +
        "Aborting rather than baking a synthetic fixture as a real match.",
    );
    process.exit(1);
  }

  // Pin the batch to the full active set so the showcase summary reports
  // authorsPolled across every active author, not a rotated sub-slice.
  const baseSettings = loadSettings(resolve(process.cwd(), "config/settings.yaml"));
  const settings = { ...baseSettings, defaultBatchSize: activeWatchlist.length };

  const result = await runFromConfig({
    dryRun: false,
    // skipState so an explicit re-bake re-tasks the qualifying polled tweets even
    // if a prior run already marked them tasked in the cross-run dedupe set.
    skipState: true,
    settings,
    // Inject the polled posts so the pipeline processes exactly these tweets.
    // run-monitor treats a bare posts array as organic (it is — we polled it live).
    posts: polled,
  });

  const drafts = result.tasks.flatMap((t) => t.subtasks.map((s) => s.draftText));
  const realDrafts = drafts.filter((d) => !/^LLM generation failed/.test(d));

  console.log(
    `\nRun ${result.summary.runKey}: ${result.tasks.length} task(s), ` +
      `${drafts.length} draft(s) (${realDrafts.length} real, ${drafts.length - realDrafts.length} placeholder).`,
  );
  console.log(
    `Counts: authorsPolled=${result.summary.counts.authorsPolled} ` +
      `postsFetched=${result.summary.counts.postsFetched} matched=${result.summary.counts.matched} ` +
      `tasksCreated=${result.summary.counts.tasksCreated}`,
  );

  for (const task of result.tasks) {
    if (task.created?.parentGid) {
      console.log(
        `\nCREATED Asana parent: gid=${task.created.parentGid}` +
          `${task.created.parentUrl ? ` url=${task.created.parentUrl}` : ""}` +
          ` subtasks=${task.created.subtaskGids?.length ?? 0}`,
      );
    } else {
      console.log(`\nTask for status ${task.statusId}: NOT created (best=${task.bestRawScore}).`);
    }
  }

  if (realDrafts[0]) {
    console.log(`\nExample real drafted reply:\n${realDrafts[0]}`);
  }

  // Refresh BOTH snapshots: the informational latest-run, and (when this real run
  // qualified with >=1 matched task) the durable SHOWCASE snapshot the public
  // /status page renders. saveShowcaseRun is a no-op for an empty run, so /status
  // keeps the previous real run rather than degrading.
  const stored = await saveLatestRun(result);
  const showcase = await saveShowcaseRun(result);
  console.log(`\nRefreshed /status latest-run snapshot at ${stored.savedAt}.`);
  if (showcase) {
    console.log(
      `Showcase snapshot ${showcase === stored ? "updated" : `(savedAt ${showcase.savedAt})`}: ` +
        `${showcase.tasks.length} real matched task(s), authorsPolled=${showcase.summary.counts.authorsPolled}.`,
    );
  } else {
    console.log("No qualifying task this run — showcase snapshot left unchanged.");
  }
}

main().catch((error) => {
  console.error("live-e2e failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
