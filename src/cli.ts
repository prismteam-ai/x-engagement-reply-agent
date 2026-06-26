#!/usr/bin/env node
import "dotenv/config";
import { loadConfig } from "./config/index.js";
import { buildDeps } from "./pipeline/build.js";
import { runMonitor } from "./pipeline/monitor.js";
import { createLogger } from "./observability/logger.js";

/**
 * CLI entrypoint.
 *   run                        run one polling pass (X_DRIVER env selects source)
 *   run --watch                run on a schedule every settings.pollIntervalMinutes
 *   run --dry-run              run without MCP-write/Asana side effects
 *   run --author=<handle>      restrict to a single author (isolation)
 *   run --live                 force the live X driver
 *   validate-config            parse + validate config and prompts, then exit
 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  const flags = parseFlags(rest);
  const log = createLogger("cli");

  switch (command) {
    case "validate-config": {
      const config = loadConfig();
      log.info("config valid", {
        authors: config.watchlist.authors.length,
        activeAuthors: config.watchlist.authors.filter((a) => a.active).length,
        replyPrompts: config.prompts.replies.length,
        replyFiles: config.prompts.replies.map((r) => r.file),
        modelId: config.settings.modelId,
      });
      return;
    }
    case "run": {
      const dryRun = Boolean(flags["dry-run"]);
      const xDriver = flags.live ? ("live" as const) : undefined;
      const onlyHandle = typeof flags.author === "string" ? flags.author : undefined;

      // One-shot run.
      if (!flags.watch) {
        const deps = buildDeps({ dryRun, xDriver });
        const summary = await runMonitor(deps, { onlyHandle });
        process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
        return;
      }

      // Scheduled mode: poll every settings.pollIntervalMinutes. Config and prompts
      // are reloaded each cycle, so edits (tone, new prompt files) take effect on the
      // next run without a restart. Ctrl-C to stop.
      const scheduler = createLogger("scheduler");
      for (;;) {
        const deps = buildDeps({ dryRun, xDriver });
        const intervalMin = deps.config.settings.pollIntervalMinutes;
        const summary = await runMonitor(deps, { onlyHandle });
        scheduler.info("cycle complete", {
          newPostsProcessed: summary.newPostsProcessed,
          parentTasksCreated: summary.parentTasksCreated,
          subtasksCreated: summary.subtasksCreated,
          skipped: summary.skipped,
          failed: summary.failed,
          nextRunInMinutes: intervalMin,
        });
        await sleep(intervalMin * 60_000);
      }
    }
    default:
      log.error("unknown command", { command });
      process.stdout.write(
        "Usage: x-engagement-reply-agent <run|validate-config> [--watch] [--dry-run] [--author=<handle>] [--live]\n",
      );
      process.exitCode = 1;
  }
}

function parseFlags(args: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const [key, value] = arg.slice(2).split("=");
    flags[key!] = value ?? true;
  }
  return flags;
}

main().catch((err) => {
  createLogger("cli").error("fatal", { error: err instanceof Error ? err.stack : String(err) });
  process.exitCode = 1;
});
