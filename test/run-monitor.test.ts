import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  nextRotationOffset,
  runMonitor,
  selectBatch,
  type InputPost,
  type RunMonitorState,
} from "@/pipeline/run-monitor";
import { createStubReplyModel } from "@/agent/reply-generation";
import { loadPromptBundle } from "@/config/load-prompts";
import type { Settings } from "@/config/load-settings";
import { SETTINGS_DEFAULTS } from "@/config/load-settings";
import type { WatchAuthor } from "@/config/load-watchlist";
import type {
  InvestorContentMatch,
  QueryInvestorContentParams,
} from "@/mcp/investor-content-client";

const ROOT = resolve(__dirname, "..");
const prompts = loadPromptBundle(resolve(ROOT, "prompts"));

const fixture = JSON.parse(
  readFileSync(
    resolve(ROOT, "examples/reference/fixtures/synthetic-post-and-reply.json"),
    "utf8",
  ),
) as {
  targetPost: { sourceUri: string; statusId: string; header: string; text: string };
  matchedArticle: {
    title: string;
    sourceUri: string;
    rawScore: number;
    score: number;
    excerpt: string;
  };
};

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    pollIntervalMinutes: SETTINGS_DEFAULTS.pollIntervalMinutes,
    defaultBatchSize: SETTINGS_DEFAULTS.defaultBatchSize,
    defaultMaxPostsPerAuthor: SETTINGS_DEFAULTS.defaultMaxPostsPerAuthor,
    defaultTopK: SETTINGS_DEFAULTS.defaultTopK,
    asanaTaskSimilarityThreshold: SETTINGS_DEFAULTS.asanaTaskSimilarityThreshold,
    articleSimilarityThreshold: SETTINGS_DEFAULTS.articleSimilarityThreshold,
    bedrockModelId: SETTINGS_DEFAULTS.bedrockModelId,
    excludeAuthors: [...SETTINGS_DEFAULTS.excludeAuthors],
    paused: SETTINGS_DEFAULTS.paused,
    dryRun: SETTINGS_DEFAULTS.dryRun,
    ...overrides,
  };
}

const watchlist: WatchAuthor[] = [
  {
    author: "Example Author",
    handle: "exampleauthor",
    aliases: { handles: [], authors: [] },
    active: true,
  },
];

const post: InputPost = {
  statusId: fixture.targetPost.statusId,
  sourceUri: fixture.targetPost.sourceUri,
  header: fixture.targetPost.header,
  text: fixture.targetPost.text,
  author: "Example Author",
  handle: "exampleauthor",
  contentType: "post",
};

/** Mocked MCP client returning a single Soofi match above threshold. */
function aboveThresholdClient(): (
  params: QueryInvestorContentParams,
) => Promise<InvestorContentMatch[]> {
  return vi.fn(async () => [
    {
      id: "m1",
      score: fixture.matchedArticle.rawScore, // 0.82 >= 0.7
      title: fixture.matchedArticle.title,
      sourceUri: fixture.matchedArticle.sourceUri,
      content:
        'Truth becomes programmable when property records leave silos and become verifiable on-chain.',
    },
  ]);
}

/** Mocked MCP client returning a match BELOW the recommendation threshold. */
function belowThresholdClient(): (
  params: QueryInvestorContentParams,
) => Promise<InvestorContentMatch[]> {
  return vi.fn(async () => [
    {
      id: "m1",
      score: 0.4,
      title: fixture.matchedArticle.title,
      sourceUri: fixture.matchedArticle.sourceUri,
      content: "Some weakly related content.",
    },
  ]);
}

/** Mocked MCP client returning NO matches at all. */
function noMatchClient(): (
  params: QueryInvestorContentParams,
) => Promise<InvestorContentMatch[]> {
  return vi.fn(async () => []);
}

describe("runMonitor (dry-run on the fixture)", () => {
  it("produces matches + drafts + would-be Asana tasks without any writes", async () => {
    const queryClient = aboveThresholdClient();
    const createAsanaTask = vi.fn(async () => ({ created: true, reason: "created" }));
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const { summary, tasks } = await runMonitor({
      posts: [post],
      settings: makeSettings(),
      watchlist,
      prompts,
      dryRun: true,
      deps: { model: createStubReplyModel(), queryClient, createAsanaTask, now: () => new Date("2026-06-22T00:00:00.000Z") },
    });

    // ZERO Asana / network-write side effects.
    expect(createAsanaTask).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();

    // dry-run summary marks the would-be task.
    expect(summary.dryRun).toBe(true);
    expect(summary.counts.tasksWouldCreate).toBe(1);
    expect(summary.counts.tasksCreated).toBe(0);
    expect(summary.counts.matched).toBe(1);
    expect(summary.posts).toHaveLength(1);
    expect(summary.posts[0]!.outcome).toBe("tasked");
    expect(summary.posts[0]!.reason).toBe("dry-run");
    expect(summary.posts[0]!.bestRawScore).toBeCloseTo(0.82, 4);

    // would-be parent task + per-slot subtasks.
    expect(tasks).toHaveLength(1);
    const task = tasks[0]!;
    expect(task.recommendations).toHaveLength(1);
    expect(task.subtasks.length).toBe(prompts.replies.length);
    // drafts are grounded with a quoted phrase + obey the question rule per slot.
    for (const sub of task.subtasks) {
      expect(sub.draftText).toMatch(/"[^"]+"/);
    }
    // parent notes carry visible scores.
    expect(task.notes).toContain("raw=0.8200");
    expect(task.notes).toContain("score=");
  });

  it("skips below-threshold posts with the reference skip reason", async () => {
    const queryClient = belowThresholdClient();
    const { summary, tasks } = await runMonitor({
      posts: [post],
      settings: makeSettings({ asanaTaskSimilarityThreshold: 0.7 }),
      watchlist,
      prompts,
      dryRun: true,
      deps: { model: createStubReplyModel(), queryClient },
    });
    expect(tasks).toHaveLength(0);
    expect(summary.counts.tasksWouldCreate).toBe(0);
    expect(summary.posts[0]!.outcome).toBe("skipped");
    expect(summary.posts[0]!.reason).toBe("below-similarity-threshold:0.4000<0.7000");
    expect(summary.counts.skipReasons["below-similarity-threshold"]).toBe(1);
  });

  it("excludes the corpus author's own posts from tasking", async () => {
    const queryClient = aboveThresholdClient();
    const { summary, tasks } = await runMonitor({
      posts: [{ ...post, author: "Soofi Safavi", handle: "ssafavi" }],
      settings: makeSettings({ excludeAuthors: ["ssafavi"] }),
      watchlist,
      prompts,
      dryRun: true,
      deps: { model: createStubReplyModel(), queryClient },
    });
    expect(tasks).toHaveLength(0);
    expect(summary.posts[0]!.outcome).toBe("skipped");
    expect(summary.posts[0]!.reason).toBe("excluded-soofi-author");
  });

  it("short-circuits when paused", async () => {
    const queryClient = aboveThresholdClient();
    const { summary, tasks } = await runMonitor({
      posts: [post],
      settings: makeSettings({ paused: true }),
      watchlist,
      prompts,
      dryRun: true,
      deps: { model: createStubReplyModel(), queryClient },
    });
    expect(summary.skipReason).toBe("paused");
    expect(queryClient).not.toHaveBeenCalled();
    expect(tasks).toHaveLength(0);
  });

  it("short-circuits on an empty watchlist", async () => {
    const { summary } = await runMonitor({
      posts: [post],
      settings: makeSettings(),
      watchlist: [],
      prompts,
      dryRun: true,
      deps: { model: createStubReplyModel(), queryClient: aboveThresholdClient() },
    });
    expect(summary.skipReason).toBe("watchlist-empty");
  });

  it("uses the fetchPosts seam when provided", async () => {
    const queryClient = aboveThresholdClient();
    const fetchPosts = vi.fn(async () => [post]);
    const { summary } = await runMonitor({
      posts: [],
      settings: makeSettings(),
      watchlist,
      prompts,
      dryRun: true,
      deps: { model: createStubReplyModel(), queryClient, fetchPosts },
    });
    expect(fetchPosts).toHaveBeenCalledOnce();
    expect(summary.counts.postsFetched).toBe(1);
  });

  it("defaults dryRun to true (no Asana adapter invoked)", async () => {
    const queryClient = aboveThresholdClient();
    const createAsanaTask = vi.fn(async () => ({ created: true, reason: "created" }));
    const { summary } = await runMonitor({
      posts: [post],
      settings: makeSettings(),
      watchlist,
      prompts,
      deps: { model: createStubReplyModel(), queryClient, createAsanaTask },
    });
    expect(summary.dryRun).toBe(true);
    expect(createAsanaTask).not.toHaveBeenCalled();
  });
});

describe("runMonitor parent-task gate (spec-correct: tasked ONLY on a qualifying match)", () => {
  it("a QUALIFYING post produces a parent task + one subtask per (article x prompt slot)", async () => {
    const queryClient = aboveThresholdClient();
    const { summary, tasks } = await runMonitor({
      posts: [post],
      settings: makeSettings(), // default asanaTaskSimilarityThreshold now 0.7
      watchlist,
      prompts,
      dryRun: true,
      deps: { model: createStubReplyModel(), queryClient },
    });

    // Exactly one parent task, carrying its matched article(s).
    expect(tasks).toHaveLength(1);
    const task = tasks[0]!;
    expect(task.recommendations.length).toBeGreaterThanOrEqual(1);
    // One subtask per (matched article x prompt slot).
    expect(task.subtasks.length).toBe(task.recommendations.length * prompts.replies.length);
    expect(summary.counts.tasksWouldCreate).toBe(1);
    expect(summary.counts.matched).toBe(1);
    expect(summary.posts[0]!.outcome).toBe("tasked");
  });

  it("a post with a match BELOW the threshold produces NO parent task (skipped)", async () => {
    const queryClient = belowThresholdClient(); // 0.4 < 0.7
    const createAsanaTask = vi.fn(async () => ({ created: true, reason: "created" }));
    const { summary, tasks } = await runMonitor({
      posts: [post],
      settings: makeSettings(), // default threshold 0.7
      watchlist,
      prompts,
      dryRun: false,
      deps: { model: createStubReplyModel(), queryClient, createAsanaTask },
    });

    expect(tasks).toHaveLength(0);
    // The live Asana adapter is NEVER invoked for a non-qualifying post.
    expect(createAsanaTask).not.toHaveBeenCalled();
    expect(summary.counts.tasksWouldCreate).toBe(0);
    expect(summary.counts.tasksCreated).toBe(0);
    expect(summary.posts[0]!.outcome).toBe("skipped");
    expect(summary.posts[0]!.reason).toBe("below-similarity-threshold:0.4000<0.7000");
    expect(summary.counts.skipReasons["below-similarity-threshold"]).toBe(1);
  });

  it("a post with ZERO matches produces NO parent task (skipped, best raw none)", async () => {
    const queryClient = noMatchClient();
    const createAsanaTask = vi.fn(async () => ({ created: true, reason: "created" }));
    const { summary, tasks } = await runMonitor({
      posts: [post],
      settings: makeSettings(),
      watchlist,
      prompts,
      dryRun: false,
      deps: { model: createStubReplyModel(), queryClient, createAsanaTask },
    });

    expect(tasks).toHaveLength(0);
    expect(createAsanaTask).not.toHaveBeenCalled();
    expect(summary.posts[0]!.outcome).toBe("skipped");
    expect(summary.posts[0]!.reason).toBe("below-similarity-threshold:none<0.7000");
    expect(summary.posts[0]!.bestRawScore).toBeNull();
  });

  it("does NOT create unconditionally even if asanaTaskSimilarityThreshold is mis-set to 0", async () => {
    // Regression guard for the shipped bug: threshold 0 must NOT mean "always
    // create". With threshold 0 the gate falls back to the article threshold (0.7),
    // so a below-0.7 match is still skipped.
    const queryClient = belowThresholdClient(); // 0.4
    const { summary, tasks } = await runMonitor({
      posts: [post],
      settings: makeSettings({ asanaTaskSimilarityThreshold: 0 }),
      watchlist,
      prompts,
      dryRun: true,
      deps: { model: createStubReplyModel(), queryClient },
    });
    expect(tasks).toHaveLength(0);
    expect(summary.posts[0]!.outcome).toBe("skipped");
    // Effective threshold falls back to the article threshold (0.7).
    expect(summary.posts[0]!.reason).toBe("below-similarity-threshold:0.4000<0.7000");
  });
});

describe("runMonitor (non-dry-run, live Asana adapter)", () => {
  it("invokes the adapter, counts tasksCreated, and captures the created GIDs", async () => {
    const queryClient = aboveThresholdClient();
    const createAsanaTask = vi.fn(async () => ({
      created: true,
      reason: "created",
      parentGid: "PARENT_99",
      parentUrl: "https://app.asana.com/0/x/PARENT_99",
      subtaskGids: ["S0", "S1"],
    }));

    const { summary, tasks } = await runMonitor({
      posts: [post],
      settings: makeSettings(),
      watchlist,
      prompts,
      dryRun: false,
      deps: { model: createStubReplyModel(), queryClient, createAsanaTask },
    });

    expect(createAsanaTask).toHaveBeenCalledOnce();
    expect(summary.dryRun).toBe(false);
    expect(summary.counts.tasksCreated).toBe(1);
    expect(summary.counts.tasksWouldCreate).toBe(0);
    expect(summary.posts[0]!.outcome).toBe("tasked");
    expect(summary.posts[0]!.reason).toBe("created");
    expect(tasks[0]!.created?.parentGid).toBe("PARENT_99");
    expect(tasks[0]!.created?.subtaskGids).toEqual(["S0", "S1"]);
  });

  it("records a created:false adapter result as skipped (honest counts)", async () => {
    const queryClient = aboveThresholdClient();
    const createAsanaTask = vi.fn(async () => ({ created: false, reason: "already-tasked" }));

    const { summary, tasks } = await runMonitor({
      posts: [post],
      settings: makeSettings(),
      watchlist,
      prompts,
      dryRun: false,
      deps: { model: createStubReplyModel(), queryClient, createAsanaTask },
    });

    expect(createAsanaTask).toHaveBeenCalledOnce();
    expect(summary.counts.tasksCreated).toBe(0);
    expect(summary.counts.skipped).toBe(1);
    expect(summary.posts[0]!.outcome).toBe("skipped");
    expect(summary.posts[0]!.reason).toBe("already-tasked");
    // The task is still returned (with no `created` block) for visibility.
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.created).toBeUndefined();
  });
});

/** A spyable in-memory implementation of the persistent state seam. */
function makeStateSpy(priorTasked: string[] = []): RunMonitorState & {
  marked: string[];
  cursors: Map<string, string>;
} {
  const marked: string[] = [];
  const cursors = new Map<string, string>();
  return {
    marked,
    cursors,
    getAlreadyTasked: vi.fn(async (keys: string[]) =>
      new Set(keys.filter((k) => priorTasked.includes(k))),
    ),
    markTasked: vi.fn(async (keys: string[]) => {
      marked.push(...keys);
    }),
    setPollingCursor: vi.fn(async (handle: string, statusId: string) => {
      cursors.set(handle, statusId);
    }),
  };
}

describe("runMonitor persistent state seam (cursors + cross-run dedupe)", () => {
  it("skips a post already tasked in a PRIOR run (cross-run dedupe)", async () => {
    const queryClient = aboveThresholdClient();
    const dedupeKey = `${post.sourceUri.toLowerCase()}|${post.statusId}`;
    const state = makeStateSpy([dedupeKey]);

    const { summary, tasks } = await runMonitor({
      posts: [post],
      settings: makeSettings(),
      watchlist,
      prompts,
      dryRun: false,
      deps: { model: createStubReplyModel(), queryClient, state, createAsanaTask: vi.fn(async () => ({ created: true, reason: "created" })) },
    });

    expect(state.getAlreadyTasked).toHaveBeenCalledOnce();
    expect(tasks).toHaveLength(0);
    expect(summary.posts[0]!.outcome).toBe("skipped");
    expect(summary.posts[0]!.reason).toBe("already-tasked");
  });

  it("persists the polling cursor to the max status id seen per handle", async () => {
    const queryClient = aboveThresholdClient();
    const state = makeStateSpy();
    const older: InputPost = { ...post, statusId: "100", sourceUri: "https://x.com/exampleauthor/status/100" };
    const newer: InputPost = { ...post, statusId: "300", sourceUri: "https://x.com/exampleauthor/status/300" };

    await runMonitor({
      posts: [older, newer],
      settings: makeSettings(),
      watchlist,
      prompts,
      dryRun: true,
      deps: { model: createStubReplyModel(), queryClient, state },
    });

    // Highest snowflake id wins regardless of input order.
    expect(state.cursors.get("exampleauthor")).toBe("300");
    expect(state.setPollingCursor).toHaveBeenCalled();
  });

  it("marks tasked ONLY when a real Asana task is created (not in dry-run)", async () => {
    const queryClient = aboveThresholdClient();

    // dry-run: nothing created → nothing marked.
    const dryState = makeStateSpy();
    await runMonitor({
      posts: [post],
      settings: makeSettings(),
      watchlist,
      prompts,
      dryRun: true,
      deps: { model: createStubReplyModel(), queryClient, state: dryState },
    });
    expect(dryState.marked).toEqual([]);
    expect(dryState.markTasked).not.toHaveBeenCalled();

    // live + created → marked with the dedupe key.
    const liveState = makeStateSpy();
    await runMonitor({
      posts: [post],
      settings: makeSettings(),
      watchlist,
      prompts,
      dryRun: false,
      deps: { model: createStubReplyModel(),
        queryClient,
        state: liveState,
        createAsanaTask: vi.fn(async () => ({ created: true, reason: "created", parentGid: "P1" })),
      },
    });
    expect(liveState.marked).toEqual([`${post.sourceUri.toLowerCase()}|${post.statusId}`]);
  });

  it("does NOT mark tasked when the live adapter reports created:false", async () => {
    const queryClient = aboveThresholdClient();
    const state = makeStateSpy();
    await runMonitor({
      posts: [post],
      settings: makeSettings(),
      watchlist,
      prompts,
      dryRun: false,
      deps: { model: createStubReplyModel(),
        queryClient,
        state,
        createAsanaTask: vi.fn(async () => ({ created: false, reason: "already-tasked" })),
      },
    });
    expect(state.marked).toEqual([]);
  });

  it("a state-flush failure is swallowed (run still returns its result)", async () => {
    const queryClient = aboveThresholdClient();
    const state = makeStateSpy();
    state.setPollingCursor = vi.fn(async () => {
      throw new Error("ddb down");
    });
    const { summary } = await runMonitor({
      posts: [post],
      settings: makeSettings(),
      watchlist,
      prompts,
      dryRun: true,
      deps: { model: createStubReplyModel(), queryClient, state },
    });
    // The run completed despite the cursor write failing.
    expect(summary.counts.tasksWouldCreate).toBe(1);
  });

  it("does NOT advance the cursor when the live Asana create fails", async () => {
    const queryClient = aboveThresholdClient();
    const state = makeStateSpy();
    await runMonitor({
      posts: [post],
      settings: makeSettings(),
      watchlist,
      prompts,
      dryRun: false,
      deps: {
        model: createStubReplyModel(),
        queryClient,
        state,
        createAsanaTask: vi.fn(async () => ({ created: false, reason: "asana-error" })),
      },
    });
    expect(state.cursors.has("exampleauthor")).toBe(false);
    expect(state.setPollingCursor).not.toHaveBeenCalled();
  });

  it("does NOT advance a cursor for referenced-original (non-watchlist) posts", async () => {
    const queryClient = aboveThresholdClient();
    const state = makeStateSpy();
    const watchedReply: InputPost = {
      ...post,
      statusId: "500",
      sourceUri: "https://x.com/exampleauthor/status/500",
      interaction: {
        type: "reply",
        parentStatusId: "9001",
        referencedStatusIds: ["9001"],
        detectionMethod: "x_api_metadata",
      },
    };
    const referencedOriginal: InputPost = {
      statusId: "9001",
      sourceUri: "https://x.com/outsider/status/9001",
      text: "On-chain property records could make ownership verifiable.",
      author: "Outside Author",
      handle: "outsider",
      contentType: "post",
    };

    await runMonitor({
      posts: [watchedReply],
      settings: makeSettings(),
      watchlist,
      prompts,
      dryRun: true,
      deps: {
        model: createStubReplyModel(),
        queryClient,
        state,
        fetchReferenced: vi.fn(async () => [referencedOriginal]),
      },
    });

    expect(state.cursors.get("exampleauthor")).toBe("500");
    expect(state.cursors.has("outsider")).toBe(false);
  });
});

function makeAuthors(handles: string[]): WatchAuthor[] {
  return handles.map((handle) => ({
    author: handle,
    handle,
    aliases: { handles: [], authors: [] },
    active: true,
  }));
}

describe("selectBatch / nextRotationOffset (pure rotation helpers)", () => {
  const authors = makeAuthors(["a", "b", "c", "d", "e"]);

  it("returns a contiguous slice of batchSize starting at the offset", () => {
    expect(selectBatch(authors, 2, 0).map((a) => a.handle)).toEqual(["a", "b"]);
    expect(selectBatch(authors, 2, 2).map((a) => a.handle)).toEqual(["c", "d"]);
  });

  it("wraps around the end of the watchlist", () => {
    expect(selectBatch(authors, 3, 4).map((a) => a.handle)).toEqual(["e", "a", "b"]);
  });

  it("clamps batchSize to the watchlist length (never duplicates)", () => {
    expect(selectBatch(authors, 99, 0).map((a) => a.handle)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("returns an empty slice for an empty watchlist", () => {
    expect(selectBatch([], 5, 0)).toEqual([]);
  });

  it("advances the offset by batchSize, wrapping modulo the watchlist length", () => {
    expect(nextRotationOffset(5, 2, 0)).toBe(2);
    expect(nextRotationOffset(5, 2, 2)).toBe(4);
    expect(nextRotationOffset(5, 2, 4)).toBe(1); // 4 + 2 = 6 → wraps to 1
    expect(nextRotationOffset(5, 99, 0)).toBe(0); // full-watchlist batch returns to start
  });
});

/** State spy that ALSO persists a rotation offset (engages run-monitor rotation). */
function makeRotatingStateSpy(initialOffset = 0): RunMonitorState & {
  cursors: Map<string, string>;
  offset: number;
  reads: number;
  writes: number;
} {
  const cursors = new Map<string, string>();
  const spy = {
    cursors,
    offset: initialOffset,
    reads: 0,
    writes: 0,
    getAlreadyTasked: vi.fn(async () => new Set<string>()),
    markTasked: vi.fn(async () => {}),
    setPollingCursor: vi.fn(async (handle: string, statusId: string) => {
      cursors.set(handle, statusId);
    }),
    getRotationOffset: vi.fn(async () => {
      spy.reads += 1;
      return spy.offset;
    }),
    setRotationOffset: vi.fn(async (next: number) => {
      spy.writes += 1;
      spy.offset = next;
    }),
  };
  return spy;
}

describe("runMonitor watchlist batch rotation", () => {
  const fiveAuthors = makeAuthors(["a", "b", "c", "d", "e"]);

  it("polls only a batchSize slice and advances the persisted offset", async () => {
    const state = makeRotatingStateSpy(0);
    const seen: string[] = [];
    const fetchPosts = vi.fn(async ({ watchlist }: { watchlist: WatchAuthor[] }) => {
      seen.push(...watchlist.map((w) => w.handle));
      return [] as InputPost[];
    });

    const { summary } = await runMonitor({
      posts: [],
      settings: makeSettings({ defaultBatchSize: 2 }),
      watchlist: fiveAuthors,
      prompts,
      dryRun: true,
      deps: { model: createStubReplyModel(), queryClient: aboveThresholdClient(), state, fetchPosts },
    });

    expect(seen).toEqual(["a", "b"]);
    expect(summary.counts.authorsPolled).toBe(2);
    expect(state.offset).toBe(2);
    expect(state.setRotationOffset).toHaveBeenCalledWith(2);
  });

  it("consecutive runs advance through the watchlist (genuine rotation)", async () => {
    const state = makeRotatingStateSpy(0);
    const batches: string[][] = [];
    const fetchPosts = vi.fn(async ({ watchlist }: { watchlist: WatchAuthor[] }) => {
      batches.push(watchlist.map((w) => w.handle));
      return [] as InputPost[];
    });

    for (let i = 0; i < 3; i += 1) {
      await runMonitor({
        posts: [],
        settings: makeSettings({ defaultBatchSize: 2 }),
        watchlist: fiveAuthors,
        prompts,
        dryRun: true,
        deps: { model: createStubReplyModel(), queryClient: aboveThresholdClient(), state, fetchPosts },
      });
    }

    expect(batches).toEqual([["a", "b"], ["c", "d"], ["e", "a"]]);
  });

  it("still batches from offset 0 (never advancing) when the offset seam is absent", async () => {
    const seen: string[][] = [];
    const fetchPosts = vi.fn(async ({ watchlist }: { watchlist: WatchAuthor[] }) => {
      seen.push(watchlist.map((w) => w.handle));
      return [] as InputPost[];
    });

    for (let i = 0; i < 2; i += 1) {
      await runMonitor({
        posts: [],
        settings: makeSettings({ defaultBatchSize: 2 }),
        watchlist: fiveAuthors,
        prompts,
        dryRun: true,
        deps: { model: createStubReplyModel(), queryClient: aboveThresholdClient(), fetchPosts },
      });
    }

    // No persisted offset → every run polls the SAME leading slice (no rotation).
    expect(seen).toEqual([["a", "b"], ["a", "b"]]);
  });

  it("polls the whole watchlist when batchSize covers every active author", async () => {
    const seen: string[] = [];
    const fetchPosts = vi.fn(async ({ watchlist }: { watchlist: WatchAuthor[] }) => {
      seen.push(...watchlist.map((w) => w.handle));
      return [] as InputPost[];
    });

    const { summary } = await runMonitor({
      posts: [],
      settings: makeSettings({ defaultBatchSize: 5 }),
      watchlist: fiveAuthors,
      prompts,
      dryRun: true,
      deps: { model: createStubReplyModel(), queryClient: aboveThresholdClient(), fetchPosts },
    });

    expect(seen).toEqual(["a", "b", "c", "d", "e"]);
    expect(summary.counts.authorsPolled).toBe(5);
  });
});

describe("runMonitor multi-author showcase (poll >=3 authors, newest post per author)", () => {
  it("polls every active author and tasks each qualifying post", async () => {
    const authors = makeAuthors(["centrifuge", "realtplatform", "plumenetwork"]);
    const newestPerAuthor: InputPost[] = authors.map((a, i) => ({
      statusId: `100${i}`,
      sourceUri: `https://x.com/${a.handle}/status/100${i}`,
      text: "Tokenized real-world assets and on-chain property records.",
      author: a.author,
      handle: a.handle,
      contentType: "post",
    }));

    const { summary, tasks } = await runMonitor({
      posts: newestPerAuthor,
      settings: makeSettings({ defaultBatchSize: 3 }),
      watchlist: authors,
      prompts,
      dryRun: true,
      deps: { model: createStubReplyModel(), queryClient: aboveThresholdClient() },
    });

    expect(summary.counts.authorsPolled).toBe(3);
    expect(summary.counts.postsFetched).toBe(3);
    expect(tasks).toHaveLength(3);
    expect(new Set(tasks.map((t) => t.handle))).toEqual(
      new Set(["centrifuge", "realtplatform", "plumenetwork"]),
    );
  });
});
