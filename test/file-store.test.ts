import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  saveLatestRunToFile,
  readLatestRunFromFile,
  readCursorFromFile,
  writeCursorToFile,
  readTaskedFromFile,
  writeTaskedToFile,
} from "@/state/file-store";
import type { RunMonitorResult } from "@/pipeline/run-monitor";

/**
 * Unit tests for the file-backed state fallback (used when DYNAMODB_TABLE is
 * absent — local dev + tests). All paths are inside a throwaway temp dir so the
 * repo's .data/ is never touched.
 */

const fakeResult: RunMonitorResult = {
  organic: true,
  summary: {
    runKey: "run-file",
    startedAt: "2026-06-22T00:00:00.000Z",
    finishedAt: "2026-06-22T00:00:01.000Z",
    dryRun: true,
    counts: {
      authorsPolled: 0,
      postsFetched: 0,
      newPosts: 0,
      matched: 0,
      tasksWouldCreate: 0,
      tasksCreated: 0,
      skipped: 0,
      failures: 0,
      skipReasons: {},
    },
    posts: [],
  },
  tasks: [],
};

describe("file-store fallback", () => {
  let dir: string;
  let runPath: string;
  let statePath: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), "xatu-file-store-"));
    runPath = resolve(dir, "latest-run.json");
    statePath = resolve(dir, "agent-state.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("readLatestRunFromFile returns null when no snapshot exists", () => {
    expect(readLatestRunFromFile(runPath)).toBeNull();
  });

  it("saveLatestRunToFile then read round-trips with savedAt", () => {
    const stored = saveLatestRunToFile(fakeResult, "2026-06-22T01:00:00.000Z", runPath);
    expect(stored.savedAt).toBe("2026-06-22T01:00:00.000Z");
    const read = readLatestRunFromFile(runPath);
    expect(read?.summary.runKey).toBe("run-file");
    expect(read?.savedAt).toBe("2026-06-22T01:00:00.000Z");
  });

  it("cursors persist per handle and missing handles read null", () => {
    expect(readCursorFromFile("balajis", statePath)).toBeNull();
    writeCursorToFile("balajis", "111", statePath);
    writeCursorToFile("naval", "222", statePath);
    expect(readCursorFromFile("balajis", statePath)).toBe("111");
    expect(readCursorFromFile("naval", statePath)).toBe("222");
    // overwrite advances
    writeCursorToFile("balajis", "999", statePath);
    expect(readCursorFromFile("balajis", statePath)).toBe("999");
  });

  it("dedupe set: writeTasked then readTasked reflects membership", () => {
    writeTaskedToFile(["a|1", "b|2"], statePath);
    writeTaskedToFile(["c|3"], statePath); // appends, keeps prior
    const present = readTaskedFromFile(["a|1", "c|3", "d|4"], statePath);
    expect(present.has("a|1")).toBe(true);
    expect(present.has("c|3")).toBe(true);
    expect(present.has("d|4")).toBe(false);
  });

  it("cursors and dedupe share one file without clobbering each other", () => {
    writeCursorToFile("h", "1", statePath);
    writeTaskedToFile(["k|1"], statePath);
    expect(readCursorFromFile("h", statePath)).toBe("1");
    expect(readTaskedFromFile(["k|1"], statePath).has("k|1")).toBe(true);
  });
});
