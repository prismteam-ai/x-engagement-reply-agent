import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getStateBackend,
  isShowcaseWorthy,
  readLatestRun,
  readShowcaseRun,
  resetStateBackendCache,
  saveLatestRun,
  saveShowcaseRun,
  toShowcaseHeadline,
  type StateBackend,
} from "@/state/agent-state";
import {
  DEFAULT_RUN_STORE_PATH,
  DEFAULT_SHOWCASE_STORE_PATH,
  readShowcaseRunFromFile,
  saveShowcaseRunToFile,
} from "@/state/file-store";
import type { RunMonitorResult, WouldBeTask } from "@/pipeline/run-monitor";

/**
 * The CORE invariant this suite guards:
 * a dry-run hit must NEVER overwrite the durable SHOWCASE snapshot that the
 * public /status page renders. The showcase is only written by a REAL
 * (dryRun=false), QUALIFYING (>=1 matched task) run; a dry-run or an empty real
 * run keeps the previous showcase intact.
 */

function makeTask(statusId: string): WouldBeTask {
  return {
    statusId,
    sourceUri: `https://x.com/example/status/${statusId}`,
    author: "Example Author",
    handle: "exampleauthor",
    name: `Draft response: Example Author - ${statusId}`,
    notes: "notes",
    bestRawScore: 0.82,
    recommendations: [],
    subtasks: [],
    created: { parentGid: `GID-${statusId}`, subtaskGids: ["s1", "s2"] },
  };
}

function makeResult(opts: {
  dryRun: boolean;
  runKey: string;
  tasks?: WouldBeTask[];
}): RunMonitorResult {
  const tasks = opts.tasks ?? (opts.dryRun ? [] : [makeTask("111")]);
  return {
    organic: true,
    summary: {
      runKey: opts.runKey,
      startedAt: "2026-06-22T00:00:00.000Z",
      finishedAt: "2026-06-22T00:00:01.000Z",
      dryRun: opts.dryRun,
      counts: {
        authorsPolled: 1,
        postsFetched: 1,
        newPosts: 1,
        matched: tasks.length,
        tasksWouldCreate: opts.dryRun ? tasks.length : 0,
        tasksCreated: opts.dryRun ? 0 : tasks.length,
        skipped: 0,
        failures: 0,
        skipReasons: {},
      },
      posts: [],
    },
    tasks,
  };
}

describe("isShowcaseWorthy", () => {
  it("is true only for a real run with >=1 task", () => {
    expect(isShowcaseWorthy(makeResult({ dryRun: false, runKey: "r" }))).toBe(true);
  });
  it("is false for a dry-run (even with tasks)", () => {
    const dryWithTasks = makeResult({ dryRun: true, runKey: "d", tasks: [makeTask("1")] });
    expect(isShowcaseWorthy(dryWithTasks)).toBe(false);
  });
  it("is false for an empty real run (deduped — no new qualifying match)", () => {
    expect(isShowcaseWorthy(makeResult({ dryRun: false, runKey: "e", tasks: [] }))).toBe(false);
  });
});

describe("showcase vs latest snapshot separation (file backend)", () => {
  let dir: string;

  beforeEach(() => {
    resetStateBackendCache();
    dir = mkdtempSync(resolve(tmpdir(), "xatu-showcase-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("file showcase store round-trips on its OWN path, distinct from latest-run", () => {
    expect(DEFAULT_SHOWCASE_STORE_PATH).not.toBe(DEFAULT_RUN_STORE_PATH);
    const path = resolve(dir, "showcase-run.json");
    expect(readShowcaseRunFromFile(path)).toBeNull();
    const real = makeResult({ dryRun: false, runKey: "real-1" });
    saveShowcaseRunToFile(real, "2026-06-22T01:00:00.000Z", path);
    const read = readShowcaseRunFromFile(path);
    expect(read?.summary.runKey).toBe("real-1");
    expect(read?.tasks[0]?.created?.parentGid).toBe("GID-111");
  });
});

type MemoryBackend = StateBackend & {
  latest: RunMonitorResult | null;
  showcase: RunMonitorResult | null;
  showcaseWrites: number;
};

/** In-memory backend that records every save so we can assert which key was hit. */
function makeMemoryBackend(): MemoryBackend {
  const backend: MemoryBackend = {
    kind: "file",
    latest: null,
    showcase: null,
    showcaseWrites: 0,
    async saveLatestRun(result, savedAt) {
      backend.latest = result;
      return { ...result, savedAt };
    },
    async readLatestRun() {
      return backend.latest ? { ...backend.latest, savedAt: "x" } : null;
    },
    async saveShowcaseRun(result, savedAt) {
      backend.showcase = result;
      backend.showcaseWrites += 1;
      return { ...result, savedAt };
    },
    async readShowcaseRun() {
      return backend.showcase ? { ...backend.showcase, savedAt: "x" } : null;
    },
    async readCursor() {
      return null;
    },
    async writeCursor() {},
    async readTasked() {
      return new Set();
    },
    async markTasked() {},
    async readRotationOffset() {
      return null;
    },
    async writeRotationOffset() {},
  };
  return backend;
}

describe("saveShowcaseRun guard (the dry-run-cannot-overwrite invariant)", () => {
  it("a real qualifying run writes the showcase", async () => {
    const backend = makeMemoryBackend();
    const real = makeResult({ dryRun: false, runKey: "real-1" });
    const stored = await saveShowcaseRun(real, backend);
    expect(stored?.summary.runKey).toBe("real-1");
    expect(backend.showcaseWrites).toBe(1);
  });

  it("a DRY-RUN does NOT overwrite the showcase — keeps the prior real run", async () => {
    const backend = makeMemoryBackend();
    // Bake a real showcase first.
    await saveShowcaseRun(makeResult({ dryRun: false, runKey: "real-1" }), backend);
    expect(backend.showcaseWrites).toBe(1);

    // A dry-run hit (even one that produced would-be tasks) must NOT touch it.
    const dry = makeResult({ dryRun: true, runKey: "dry-2", tasks: [makeTask("999")] });
    const afterDry = await saveShowcaseRun(dry, backend);

    expect(backend.showcaseWrites).toBe(1); // no new write
    expect(afterDry?.summary.runKey).toBe("real-1"); // still the real run
    expect(backend.showcase?.summary.runKey).toBe("real-1");
  });

  it("an EMPTY real run (deduped) keeps the prior showcase instead of degrading", async () => {
    const backend = makeMemoryBackend();
    await saveShowcaseRun(makeResult({ dryRun: false, runKey: "real-1" }), backend);

    const emptyReal = makeResult({ dryRun: false, runKey: "real-2-empty", tasks: [] });
    const after = await saveShowcaseRun(emptyReal, backend);

    expect(backend.showcaseWrites).toBe(1);
    expect(after?.summary.runKey).toBe("real-1");
  });

  it("returns null when nothing is showcase-worthy and no prior showcase exists", async () => {
    const backend = makeMemoryBackend();
    const dry = makeResult({ dryRun: true, runKey: "dry-1" });
    expect(await saveShowcaseRun(dry, backend)).toBeNull();
    expect(backend.showcaseWrites).toBe(0);
  });

  it("latest-run and showcase are written independently", async () => {
    const backend = makeMemoryBackend();
    const real = makeResult({ dryRun: false, runKey: "real-1" });
    await saveLatestRun(real, backend);
    await saveShowcaseRun(real, backend);

    const dry = makeResult({ dryRun: true, runKey: "dry-2" });
    await saveLatestRun(dry, backend); // latest advances...
    await saveShowcaseRun(dry, backend); // ...showcase does NOT.

    expect((await readLatestRun(backend))?.summary.runKey).toBe("dry-2");
    expect((await readShowcaseRun(backend))?.summary.runKey).toBe("real-1");
  });
});

describe("getStateBackend exposes showcase methods on every backend kind", () => {
  beforeEach(() => resetStateBackendCache());
  it("file backend has showcase save/read", () => {
    const backend = getStateBackend({ env: {} });
    expect(backend.kind).toBe("file");
    expect(typeof backend.saveShowcaseRun).toBe("function");
    expect(typeof backend.readShowcaseRun).toBe("function");
  });
});

/**
 * The showcase/latest snapshot must be reduced to its single BEST task before
 * persistence — a full organic poll can match many tweets (each with many
 * drafted-reply subtasks), and serialized whole that payload exceeds the
 * persistent store's per-item size limit (DynamoDB caps an item at 400 KB) and
 * the write throws, leaving /status stuck on a stale showcase. The headline
 * reduction keeps /status to one clean organic match while every Asana task it
 * created stays real.
 */
function makeScoredTask(statusId: string, rawScore: number, subtaskCount: number): WouldBeTask {
  return {
    statusId,
    sourceUri: `https://x.com/centrifuge/status/${statusId}`,
    author: "Centrifuge",
    handle: "centrifuge",
    name: `Draft response: Centrifuge - ${statusId}`,
    notes: "notes",
    bestRawScore: rawScore,
    recommendations: [],
    subtasks: Array.from({ length: subtaskCount }, (_, i) => ({
      promptIndex: i,
      promptLabel: `slot ${i}`,
      draftText: "x".repeat(2000),
      notes: "n",
    })),
    created: { parentGid: `GID-${statusId}`, subtaskGids: Array(subtaskCount).fill("s") },
  };
}

describe("toShowcaseHeadline (single-best reduction)", () => {
  it("reduces a multi-task run to its single highest-scoring task", () => {
    const result = makeResult({
      dryRun: false,
      runKey: "multi",
      tasks: [
        makeScoredTask("100", 0.71, 18),
        makeScoredTask("200", 0.755, 18), // highest raw score → headline
        makeScoredTask("300", 0.73, 18),
      ],
    });
    const headline = toShowcaseHeadline(result);
    expect(headline.tasks).toHaveLength(1);
    expect(headline.tasks[0]?.statusId).toBe("200");
    expect(headline.tasks[0]?.bestRawScore).toBe(0.755);
  });

  it("rewrites counts to be self-consistent with the one shown task (real run)", () => {
    const result = makeResult({
      dryRun: false,
      runKey: "multi",
      tasks: [makeScoredTask("100", 0.71, 18), makeScoredTask("200", 0.75, 18)],
    });
    const headline = toShowcaseHeadline(result);
    expect(headline.summary.counts.matched).toBe(1);
    expect(headline.summary.counts.tasksCreated).toBe(1);
    expect(headline.summary.counts.tasksWouldCreate).toBe(0);
  });

  it("ties broken by richest content (more subtasks) at equal score", () => {
    const result = makeResult({
      dryRun: false,
      runKey: "tie",
      tasks: [makeScoredTask("100", 0.72, 6), makeScoredTask("200", 0.72, 18)],
    });
    expect(toShowcaseHeadline(result).tasks[0]?.statusId).toBe("200");
  });

  it("is a no-op for an empty run and keeps the single task for a single-task run", () => {
    const single = makeResult({ dryRun: false, runKey: "s", tasks: [makeScoredTask("1", 0.7, 6)] });
    expect(toShowcaseHeadline(single).tasks).toHaveLength(1);
    expect(toShowcaseHeadline(single).tasks[0]?.statusId).toBe("1");
    const empty = makeResult({ dryRun: false, runKey: "e", tasks: [] });
    expect(toShowcaseHeadline(empty).tasks).toHaveLength(0);
  });

  it("recomputes ALL counts consistently for a single-task run with mixed input counts", () => {
    const result = makeResult({ dryRun: false, runKey: "single", tasks: [makeScoredTask("1", 0.7, 6)] });
    result.summary.counts = {
      ...result.summary.counts,
      postsFetched: 11,
      newPosts: 11,
      matched: 1,
      skipped: 10,
      failures: 1,
      skipReasons: { "below-similarity-threshold": 10 },
    };
    const headline = toShowcaseHeadline(result);
    expect(headline.summary.counts.postsFetched).toBe(1);
    expect(headline.summary.counts.newPosts).toBe(1);
    expect(headline.summary.counts.matched).toBe(1);
    expect(headline.summary.counts.skipped).toBe(0);
    expect(headline.summary.counts.failures).toBe(0);
    expect(headline.summary.counts.skipReasons).toEqual({});
    expect(headline.summary.counts.tasksCreated).toBe(1);
  });

  it("bounds the headline task's subtasks to keep the persisted item small", () => {
    const result = makeResult({ dryRun: false, runKey: "big", tasks: [makeScoredTask("1", 0.7, 18)] });
    const headline = toShowcaseHeadline(result);
    expect(headline.tasks[0]!.subtasks.length).toBeLessThanOrEqual(8);
  });

  it("saveShowcaseRun persists ONLY the headline task from a multi-task run", async () => {
    const backend = makeMemoryBackend();
    const result = makeResult({
      dryRun: false,
      runKey: "multi",
      tasks: [makeScoredTask("100", 0.71, 18), makeScoredTask("200", 0.755, 18)],
    });
    await saveShowcaseRun(result, backend);
    expect(backend.showcase?.tasks).toHaveLength(1);
    expect(backend.showcase?.tasks[0]?.statusId).toBe("200");
  });

  it("saveLatestRun also persists only the headline task (size-bounded fallback)", async () => {
    const backend = makeMemoryBackend();
    const result = makeResult({
      dryRun: false,
      runKey: "multi",
      tasks: [makeScoredTask("100", 0.71, 18), makeScoredTask("200", 0.75, 18)],
    });
    await saveLatestRun(result, backend);
    expect(backend.latest?.tasks).toHaveLength(1);
    expect(backend.latest?.tasks[0]?.statusId).toBe("200");
  });
});
