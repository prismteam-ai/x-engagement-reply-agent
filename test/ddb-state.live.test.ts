import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDynamoDbStateStore,
  isDynamoDbConfigured,
} from "@/state/ddb-client";
import { getStateBackend } from "@/state/agent-state";

/**
 * LIVE integration test against the REAL DynamoDB table (xatu-agent-state).
 *
 * This is double-gated, exactly like the other *.live.test.ts files:
 *   - the env must be DynamoDB-configured (DYNAMODB_TABLE + IAM creds), AND
 *   - RUN_LIVE_DDB=1 must be set explicitly.
 * Otherwise it ctx.skip()s, so the normal suite NEVER hits AWS.
 *
 * It writes + reads a uniquely-keyed cursor and dedupe entry so it is safe to run
 * repeatedly and never collides with real agent state. Secrets are never printed.
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

const RUN_LIVE = process.env.RUN_LIVE === "1";

describe.skipIf(!RUN_LIVE)("DynamoDB state LIVE (real table)", () => {
  it(
    "round-trips a cursor + dedupe entry against the real table",
    async (ctx) => {
      loadEnvLocal();
      if (process.env.RUN_LIVE_DDB !== "1" || !isDynamoDbConfigured()) {
        ctx.skip();
        return;
      }

      const store = createDynamoDbStateStore();
      const backend = getStateBackend({ store });
      const stamp = Date.now();
      const handle = `__live_test_${stamp}`;
      const statusId = String(2_000_000_000_000_000_000n + BigInt(stamp));
      const dedupeKey = `https://x.com/${handle}/status/${statusId}|${statusId}`;

      // Cursor round-trip.
      await backend.writeCursor(handle, statusId);
      expect(await backend.readCursor(handle)).toBe(statusId);

      // Dedupe round-trip.
      const before = await backend.readTasked([dedupeKey]);
      expect(before.has(dedupeKey)).toBe(false);
      await backend.markTasked([dedupeKey]);
      const after = await backend.readTasked([dedupeKey]);
      expect(after.has(dedupeKey)).toBe(true);

      if (process.env.PRINT_LIVE_DDB === "1") {
        // eslint-disable-next-line no-console
        console.log(`Live DDB round-trip ok (handle=${handle}).`);
      }
    },
    LIVE_TIMEOUT_MS,
  );
});
