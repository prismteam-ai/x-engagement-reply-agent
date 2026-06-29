/**
 * Refresh the /status snapshot (.data/latest-run.json) via the real run flow.
 *
 * Runs `runFromConfig` in dry-run mode (NO Asana writes) and persists the result
 * with `saveLatestRun`, exactly as the /api/monitor-x route does. When the
 * Bedrock env (AWS_BEARER_TOKEN_BEDROCK + BEDROCK_MODEL_ID) is present,
 * runFromConfig auto-wires the REAL Bedrock reply model, so the snapshot shows
 * real Opus-drafted replies; otherwise it falls back to the deterministic stub.
 *
 * Run:  pnpm tsx scripts/refresh-status.ts
 *
 * Loads .env.local first (only keys not already set). The bearer token is never
 * printed. Lower BEDROCK_MAX_CONCURRENCY=1 if you hit Bedrock on-demand 429s.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runFromConfig } from "@/pipeline/run-from-config";
import { saveLatestRun } from "@/pipeline/run-store";
import { isBedrockConfigured } from "@/agent/model";

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
  const usingBedrock = isBedrockConfigured();
  console.log(
    `=== refresh /status snapshot (dry-run, model=${usingBedrock ? "BEDROCK" : "stub"}) ===`,
  );

  const result = await runFromConfig({ dryRun: true });
  const stored = await saveLatestRun(result);

  const drafts = result.tasks.flatMap((t) => t.subtasks.map((s) => s.draftText));
  const realDrafts = drafts.filter((d) => !/^LLM generation failed/.test(d));
  console.log(
    `Saved ${stored.savedAt}: ${result.tasks.length} task(s), ${drafts.length} draft(s) (${realDrafts.length} real).`,
  );
  for (const draft of realDrafts.slice(0, 1)) {
    console.log(`\nExample drafted reply:\n${draft}`);
  }
}

main().catch((error) => {
  console.error("refresh-status failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
