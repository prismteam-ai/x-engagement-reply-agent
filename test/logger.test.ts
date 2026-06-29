import { describe, expect, it } from "vitest";
import {
  bucketSkipReason,
  createRunSummaryBuilder,
  type PostOutcomeRecord,
} from "@/observability/logger";

function rec(overrides: Partial<PostOutcomeRecord>): PostOutcomeRecord {
  return {
    sourceUri: overrides.sourceUri ?? "https://x.com/a/status/1",
    statusId: overrides.statusId ?? "1",
    author: overrides.author ?? "Author",
    handle: overrides.handle ?? "author",
    outcome: overrides.outcome ?? "skipped",
    ...(overrides.reason !== undefined ? { reason: overrides.reason } : {}),
    ...(overrides.bestRawScore !== undefined ? { bestRawScore: overrides.bestRawScore } : {}),
    ...(overrides.matchedArticleCount !== undefined
      ? { matchedArticleCount: overrides.matchedArticleCount }
      : {}),
    ...(overrides.draftCount !== undefined ? { draftCount: overrides.draftCount } : {}),
  };
}

describe("bucketSkipReason", () => {
  it("collapses granular reasons to a stable bucket", () => {
    expect(bucketSkipReason("below-similarity-threshold:0.51<0.7000")).toBe(
      "below-similarity-threshold",
    );
    expect(bucketSkipReason("post-processing-failed: timeout")).toBe(
      "post-processing-failed",
    );
    expect(bucketSkipReason("dry-run")).toBe("dry-run");
    expect(bucketSkipReason(undefined)).toBe("unspecified");
  });
});

describe("createRunSummaryBuilder", () => {
  it("produces a serializable run summary with the documented shape", () => {
    const builder = createRunSummaryBuilder({
      runKey: "run-1",
      startedAt: "2026-06-22T00:00:00.000Z",
      dryRun: true,
    });
    builder.recordAuthorsPolled(3);
    builder.recordPostsFetched(5);
    builder.recordNewPosts(2);
    const summary = builder.build({ finishedAt: "2026-06-22T00:00:01.000Z" });

    expect(summary).toMatchObject({
      runKey: "run-1",
      startedAt: "2026-06-22T00:00:00.000Z",
      finishedAt: "2026-06-22T00:00:01.000Z",
      dryRun: true,
    });
    expect(summary.counts).toMatchObject({
      authorsPolled: 3,
      postsFetched: 5,
      newPosts: 2,
    });
    expect(Array.isArray(summary.posts)).toBe(true);
    // round-trips through JSON
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
  });

  it("aggregates per-post outcomes into counts (dry-run -> tasksWouldCreate)", () => {
    const builder = createRunSummaryBuilder({
      runKey: "run-2",
      startedAt: "2026-06-22T00:00:00.000Z",
      dryRun: true,
    });
    builder.recordPost(rec({ outcome: "tasked", matchedArticleCount: 2, draftCount: 6 }));
    builder.recordPost(
      rec({ outcome: "skipped", reason: "below-similarity-threshold:0.51<0.7000" }),
    );
    builder.recordPost(rec({ outcome: "skipped", reason: "below-similarity-threshold:0.40<0.7000" }));
    builder.recordPost(rec({ outcome: "failed", reason: "post-processing-failed: x" }));
    const summary = builder.build({ finishedAt: "2026-06-22T00:00:02.000Z" });

    expect(summary.counts.tasksWouldCreate).toBe(1);
    expect(summary.counts.tasksCreated).toBe(0);
    expect(summary.counts.matched).toBe(1);
    expect(summary.counts.skipped).toBe(2);
    expect(summary.counts.failures).toBe(1);
    expect(summary.counts.skipReasons["below-similarity-threshold"]).toBe(2);
    expect(summary.posts).toHaveLength(4);
  });

  it("counts created tasks under tasksCreated when not a dry-run", () => {
    const builder = createRunSummaryBuilder({
      runKey: "run-3",
      startedAt: "2026-06-22T00:00:00.000Z",
      dryRun: false,
    });
    builder.recordPost(rec({ outcome: "tasked", matchedArticleCount: 1 }));
    const summary = builder.build({ finishedAt: "2026-06-22T00:00:01.000Z" });
    expect(summary.counts.tasksCreated).toBe(1);
    expect(summary.counts.tasksWouldCreate).toBe(0);
  });

  it("records a top-level skip reason for short-circuited runs", () => {
    const builder = createRunSummaryBuilder({
      runKey: "run-4",
      startedAt: "2026-06-22T00:00:00.000Z",
      dryRun: true,
    });
    builder.setSkipReason("paused");
    const summary = builder.build({ finishedAt: "2026-06-22T00:00:00.000Z" });
    expect(summary.skipReason).toBe("paused");
  });
});
