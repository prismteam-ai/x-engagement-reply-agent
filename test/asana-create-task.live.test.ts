import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createAsanaTaskAdapter } from "@/asana/create-task";
import { resolveAsanaConfig, isAsanaConfigured } from "@/asana/asana-client";
import type { WouldBeTask } from "@/pipeline/run-monitor";

/**
 * LIVE write test: creates a REAL parent task + subtask in the configured Asana
 * TEST project. This is DESTRUCTIVE (it writes), so it is double-gated:
 *   - creds must be present (ASANA_PAT + ASANA_PROJECT_GID + ASANA_WORKSPACE_GID),
 *   - AND RUN_LIVE_ASANA_WRITE=1 must be set explicitly.
 * Otherwise it ctx.skip()s, exactly like the other *.live.test.ts gating, so the
 * normal suite never writes to Asana.
 *
 * The PAT is NEVER printed.
 */
const ROOT = resolve(__dirname, "..");
const LIVE_TIMEOUT_MS = 60_000;

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

const RUN_LIVE = process.env.RUN_LIVE === "1";

describe.skipIf(!RUN_LIVE)("createAsanaTaskAdapter LIVE (writes a real task)", () => {
  it(
    "creates a real parent + subtask in the Asana test project",
    async (ctx) => {
      loadEnvLocal();
      if (process.env.RUN_LIVE_ASANA_WRITE !== "1" || !isAsanaConfigured()) {
        ctx.skip();
        return;
      }

      const config = resolveAsanaConfig();
      const adapter = createAsanaTaskAdapter({
        config,
        asanaTaskSimilarityThreshold: 0,
      });

      const stamp = new Date().toISOString();
      const task: WouldBeTask = {
        statusId: `live-${Date.now()}`,
        sourceUri: `https://x.com/test/status/${Date.now()}`,
        author: "Live Test",
        handle: "livetest",
        name: `[live-test] X engagement adapter ${stamp}`,
        notes: `Live adapter test created at ${stamp}. raw=0.99 | score=99`,
        bestRawScore: 0.99,
        recommendations: [],
        subtasks: [
          {
            promptIndex: 0,
            promptLabel: "Live Test Reply",
            draftText: 'A grounded reply quoting "verifiable on-chain".',
            notes:
              'Draft response:\nA grounded reply quoting "verifiable on-chain".\n\nOpen in X:\nhttps://twitter.com/intent/tweet?in_reply_to=1&text=hi',
          },
        ],
      };

      const result = await adapter(task);
      expect(result.created).toBe(true);
      expect(result.parentGid).toBeTruthy();
      expect(result.subtaskGids?.length).toBeGreaterThanOrEqual(1);

      if (process.env.PRINT_LIVE_ASANA === "1") {
        // eslint-disable-next-line no-console
        console.log(`Created Asana parent ${result.parentGid} (${result.parentUrl}); subtasks=${result.subtaskGids?.length}`);
      }
    },
    LIVE_TIMEOUT_MS,
  );
});
