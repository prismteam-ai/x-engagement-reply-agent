import { describe, it, expect } from "vitest";
import {
  bestRawScore,
  composeIntentLink,
  dedupeKey,
  detectNewPosts,
  makeExcerpt,
  maxStatusId,
  meetsParentThreshold,
  safeCursor,
  qualifyingArticles,
  rankMatches,
  resolveAssignee,
  selectBatch,
  toDisplayScore,
  trimToLimit,
} from "../src/domain/pipeline-logic.js";
import type { ArticleMatch, PostCandidate } from "../src/domain/types.js";
import { settingsSchema } from "../src/config/schema.js";

const post = (statusId: string): PostCandidate => ({
  sourceUri: `https://x.com/a/status/${statusId}`,
  statusId,
  handle: "a",
  header: "h",
  text: "t",
});

const match = (rawScore: number): ArticleMatch => ({
  title: "T",
  sourceUri: "u",
  rawScore,
  score: toDisplayScore(rawScore),
  excerpt: "e",
  content: "c",
});

describe("dedupeKey", () => {
  it("combines sourceUri and statusId", () => {
    expect(dedupeKey(post("12"))).toBe("https://x.com/a/status/12::12");
  });
});

describe("detectNewPosts", () => {
  it("returns all when no cursor", () => {
    expect(detectNewPosts([post("2"), post("3")], undefined)).toHaveLength(2);
  });
  it("returns only posts newer than cursor (bigint-safe)", () => {
    const posts = [post("1990000000000000001"), post("1990000000000000003")];
    const fresh = detectNewPosts(posts, "1990000000000000001");
    expect(fresh.map((p) => p.statusId)).toEqual(["1990000000000000003"]);
  });
});

describe("maxStatusId", () => {
  it("finds the numerically largest id", () => {
    expect(maxStatusId([post("9"), post("100"), post("30")])).toBe("100");
  });
  it("returns undefined for empty", () => {
    expect(maxStatusId([])).toBeUndefined();
  });
});

describe("safeCursor", () => {
  const fetched = [post("10"), post("20"), post("30")];
  it("advances to newest when nothing failed", () => {
    expect(safeCursor(fetched, [])).toBe("30");
  });
  it("never advances past a failed post", () => {
    // post 20 failed → cursor may only reach 10, so 20 and 30 retry next run
    expect(safeCursor(fetched, ["20"])).toBe("10");
  });
  it("uses the oldest failure as the ceiling", () => {
    expect(safeCursor(fetched, ["30", "20"])).toBe("10");
  });
  it("returns undefined when the oldest post itself failed", () => {
    expect(safeCursor(fetched, ["10"])).toBeUndefined();
  });
});

describe("selectBatch (cursor rotation)", () => {
  const items = ["a", "b", "c", "d", "e"];
  it("takes a batch from offset", () => {
    expect(selectBatch(items, 0, 2)).toEqual({ batch: ["a", "b"], nextOffset: 2 });
  });
  it("wraps around", () => {
    expect(selectBatch(items, 4, 3)).toEqual({ batch: ["e", "a", "b"], nextOffset: 2 });
  });
  it("caps batch at list size", () => {
    expect(selectBatch(items, 0, 99).batch).toHaveLength(5);
  });
});

describe("thresholds", () => {
  const settings = settingsSchema.parse({ asanaTaskSimilarityThreshold: 0.5, articleSimilarityThreshold: 0.7 });
  it("bestRawScore picks the max", () => {
    expect(bestRawScore([match(0.4), match(0.8)])).toBe(0.8);
  });
  it("parent threshold gates on best match", () => {
    expect(meetsParentThreshold([match(0.6)], settings)).toBe(true);
    expect(meetsParentThreshold([match(0.4)], settings)).toBe(false);
  });
  it("qualifyingArticles filters + sorts desc", () => {
    const q = qualifyingArticles([match(0.71), match(0.6), match(0.9)], settings);
    expect(q.map((m) => m.rawScore)).toEqual([0.9, 0.71]);
  });
  it("rankMatches sorts desc and slices topK", () => {
    expect(rankMatches([match(0.1), match(0.9), match(0.5)], 2).map((m) => m.rawScore)).toEqual([0.9, 0.5]);
  });
});

describe("toDisplayScore", () => {
  it("scales 0..1 to 0..100", () => {
    expect(toDisplayScore(0.7523)).toBe(75);
    expect(toDisplayScore(1.5)).toBe(100);
    expect(toDisplayScore(-1)).toBe(0);
  });
});

describe("resolveAssignee", () => {
  const asana = {
    defaultAssignee: "default",
    thresholdAssignee: "lead",
    thresholdAssigneeRawScore: 0.8,
  } as Parameters<typeof resolveAssignee>[1];
  it("routes to threshold assignee + dueToday when best >= threshold", () => {
    expect(resolveAssignee([match(0.85)], asana)).toEqual({ assignee: "lead", dueToday: true });
  });
  it("routes to default below threshold", () => {
    expect(resolveAssignee([match(0.5)], asana)).toEqual({ assignee: "default", dueToday: false });
  });
});

describe("composeIntentLink", () => {
  it("encodes text and in_reply_to", () => {
    const link = composeIntentLink("hello world", "123");
    expect(link).toContain("https://x.com/intent/post?");
    expect(link).toContain("text=hello+world");
    expect(link).toContain("in_reply_to=123");
  });
});

describe("trimToLimit", () => {
  it("leaves text within the limit unchanged", () => {
    expect(trimToLimit("short reply", 280)).toBe("short reply");
  });
  it("trims to at most max chars", () => {
    const long = "word ".repeat(100).trim();
    const out = trimToLimit(long, 50);
    expect(out.length).toBeLessThanOrEqual(50);
  });
  it("prefers a word boundary", () => {
    expect(trimToLimit("alpha beta gamma delta", 14)).toBe("alpha beta");
  });
});

describe("makeExcerpt", () => {
  it("collapses whitespace and truncates", () => {
    expect(makeExcerpt("a   b\n\nc")).toBe("a b c");
    expect(makeExcerpt("x".repeat(500)).endsWith("…")).toBe(true);
  });
});
