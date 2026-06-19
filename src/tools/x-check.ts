#!/usr/bin/env node
import "dotenv/config";
import { LiveXClient } from "../x/live-driver.js";

/**
 * Connectivity + access-tier check for the live X driver. Resolves a handle and
 * fetches a few recent posts, reporting clearly whether the token's API tier
 * actually permits reading user timelines (Basic+).
 *
 * Usage: pnpm run x:check -- <handle>   (defaults to "balajis")
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const handle = (args[0] ?? "balajis").replace(/^@/, "");
  const token = process.env.X_BEARER_TOKEN;

  if (!token) {
    console.error("✗ X_BEARER_TOKEN is not set in .env. Add your app's Bearer Token and retry.");
    process.exitCode = 1;
    return;
  }

  console.log(`Checking live X read access by polling @${handle} ...`);
  try {
    const client = new LiveXClient({ bearerToken: token });
    const posts = await client.fetchAuthorPosts({ handle, maxResults: 5 });
    console.log(`\n✓ Read access OK — fetched ${posts.length} recent post(s) for @${handle}.`);
    const first = posts[0];
    if (first) {
      console.log(`  Latest: [${first.statusId}] ${first.text.slice(0, 120)}`);
      if (first.referencedOriginal) {
        console.log(`  (references a ${first.referencedOriginal.relation})`);
      }
    }
    console.log("\nYou're ready for a live run: set X_DRIVER=live (or use --live) and run `pnpm run run`.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n✗ Live read failed: ${msg}`);
    if (msg.includes("403")) {
      console.error(
        "  HTTP 403 usually means your X API tier does not include timeline reads.\n" +
          "  Reading another user's posts requires the paid Basic tier or higher.\n" +
          "  Free tier is write-only and cannot poll timelines.",
      );
    } else if (msg.includes("401")) {
      console.error("  HTTP 401 means the Bearer Token is missing/invalid. Re-copy it from the X developer portal.");
    } else if (msg.includes("429")) {
      console.error("  HTTP 429 means you hit the rate limit. Wait and retry.");
    }
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
