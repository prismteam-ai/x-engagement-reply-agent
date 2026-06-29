/**
 * One-off cleanup: delete a list of Asana parent tasks by GID.
 *
 * Used to remove leftover parent tasks created by an earlier full-watchlist bake
 * (the single-author showcase bake creates exactly one task; everything else from
 * the wide batch is junk). Deleting a parent in Asana cascades to its subtasks.
 *
 * GIDs are taken from argv, or fall back to the known leftover batch below. An
 * already-gone task (404) is treated as success — the goal is "absent", not
 * "deleted by us". The PAT is read from env and NEVER printed.
 *
 * Run:  pnpm tsx scripts/delete-asana-tasks.ts [gid ...]
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createAsanaRestClient, resolveAsanaConfig } from "@/asana/asana-client";

/** Leftover parent GIDs from the prior full-batch bake (default target set). */
const DEFAULT_JUNK_GIDS = [
  "1216095422818334",
  "1216095538174529",
  "1216095499158659",
  "1216095741425166",
  "1216095539404348",
  "1216095539587474",
  "1216109805731403",
  "1216095742565486",
  "1216095975707062",
  "1216095849081221",
  "1216095976476235",
];

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

/** A 404 (already gone) counts as success for an idempotent cleanup. */
function isAlreadyGone(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b404\b|not[\s_-]?found|does not exist/i.test(message);
}

async function main(): Promise<void> {
  loadEnvLocal();
  const config = resolveAsanaConfig(); // throws clearly if creds are absent
  const client = createAsanaRestClient({ accessToken: config.accessToken });

  const gids = process.argv.slice(2);
  const targets = gids.length > 0 ? gids : DEFAULT_JUNK_GIDS;

  let deleted = 0;
  let alreadyGone = 0;
  let failed = 0;
  for (const gid of targets) {
    try {
      await client.tasks.delete(gid);
      deleted += 1;
      console.log(`deleted ${gid}`);
    } catch (error) {
      if (isAlreadyGone(error)) {
        alreadyGone += 1;
        console.log(`already gone ${gid}`);
        continue;
      }
      failed += 1;
      console.error(`FAILED ${gid}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(
    `\nCleanup done: deleted=${deleted} alreadyGone=${alreadyGone} failed=${failed} (of ${targets.length}).`,
  );
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error("delete-asana-tasks failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
