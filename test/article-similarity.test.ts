import { describe, expect, it, vi } from "vitest";
import {
  articlesMeetSimilarityThreshold,
  bestRawScore,
  clampArticleSimilarityThreshold,
  clampAsanaTaskSimilarityThreshold,
  dedupeAndRankMatches,
  effectiveAsanaTaskThreshold,
  filterArticlesAboveThreshold,
  getTopSoofiArticleSimilarities,
  mapMatchToSimilarity,
  meetsAsanaTaskThreshold,
  normalizeVectorScoreTo100,
  qualifyingTaskArticles,
  SOOFI_ARTICLE_AUTHOR,
  SOOFI_ARTICLE_CONTENT_TYPE,
  SOOFI_ARTICLE_SEGMENT_TYPE,
} from "@/matching/article-similarity";
import type { InvestorContentMatch } from "@/mcp/investor-content-client";

function match(overrides: Partial<InvestorContentMatch> = {}): InvestorContentMatch {
  return {
    id: "id-1",
    score: 0.8,
    sourceUri: "https://x.com/i/article/aaa",
    title: "Programmable Property",
    content: "When property records leave silos, truth becomes programmable. ".repeat(20),
    ...overrides,
  };
}

describe("normalizeVectorScoreTo100", () => {
  it("maps a 0..1 cosine into 1..100", () => {
    expect(normalizeVectorScoreTo100(0)).toBe(1);
    expect(normalizeVectorScoreTo100(1)).toBe(100);
    expect(normalizeVectorScoreTo100(0.82)).toBe(82); // round(1 + 0.82*99) = round(82.18)
  });

  it("maps an already-1..100 raw score through rounding", () => {
    expect(normalizeVectorScoreTo100(91)).toBe(91);
    expect(normalizeVectorScoreTo100(150)).toBe(100);
  });

  it("falls back to 1 for non-finite input", () => {
    expect(normalizeVectorScoreTo100(Number.NaN)).toBe(1);
  });
});

describe("mapMatchToSimilarity", () => {
  it("keeps numeric scores visible (rawScore + score)", () => {
    const mapped = mapMatchToSimilarity(match({ score: 0.82 }));
    expect(mapped).not.toBeNull();
    expect(mapped?.rawScore).toBeCloseTo(0.82);
    expect(mapped?.score).toBe(82);
    expect(mapped?.title).toBe("Programmable Property");
    expect(mapped?.sourceUri).toBe("https://x.com/i/article/aaa");
  });

  it("produces a short excerpt and a longer contextExcerpt", () => {
    const mapped = mapMatchToSimilarity(match());
    expect(mapped?.excerpt.length).toBeLessThanOrEqual(321); // 320 + ellipsis
    expect((mapped?.contextExcerpt.length ?? 0)).toBeGreaterThanOrEqual(
      mapped?.excerpt.length ?? 0,
    );
  });

  it("derives a title from content when none is provided", () => {
    const mapped = mapMatchToSimilarity(
      match({ title: undefined, content: "Tokenized real-world assets unlock new credit markets." }),
    );
    expect(mapped?.title).toMatch(/Tokenized real-world assets/);
  });

  it("returns null when there is no usable source URI", () => {
    expect(mapMatchToSimilarity(match({ sourceUri: undefined }))).toBeNull();
    expect(mapMatchToSimilarity(match({ sourceUri: "   " }))).toBeNull();
  });
});

describe("dedupeAndRankMatches", () => {
  it("dedupes by source URI keeping the highest raw score, sorted desc, top 3", () => {
    const ranked = dedupeAndRankMatches([
      match({ sourceUri: "https://x.com/i/article/aaa", score: 0.5 }),
      match({ sourceUri: "https://x.com/i/article/AAA", score: 0.9 }), // same source, higher
      match({ sourceUri: "https://x.com/i/article/bbb", score: 0.7 }),
      match({ sourceUri: "https://x.com/i/article/ccc", score: 0.3 }),
      match({ sourceUri: "https://x.com/i/article/ddd", score: 0.2 }),
    ]);
    expect(ranked).toHaveLength(3);
    expect(ranked[0]?.sourceUri).toBe("https://x.com/i/article/AAA");
    expect(ranked[0]?.rawScore).toBeCloseTo(0.9);
    expect(ranked.map((row) => row.rawScore)).toEqual([0.9, 0.7, 0.3]);
  });

  it("skips matches with no source URI", () => {
    const ranked = dedupeAndRankMatches([match({ sourceUri: undefined }), match()]);
    expect(ranked).toHaveLength(1);
  });
});

describe("threshold clamps", () => {
  it("clamps the article similarity threshold to [0,1]", () => {
    expect(clampArticleSimilarityThreshold(-0.5)).toBe(0);
    expect(clampArticleSimilarityThreshold(1.5)).toBe(1);
    expect(clampArticleSimilarityThreshold(0.7)).toBe(0.7);
    expect(clampArticleSimilarityThreshold(Number.NaN)).toBe(0.7);
  });

  it("clamps the asana task similarity threshold to [0,1]", () => {
    expect(clampAsanaTaskSimilarityThreshold(-1)).toBe(0);
    expect(clampAsanaTaskSimilarityThreshold(2)).toBe(1);
    expect(clampAsanaTaskSimilarityThreshold(Number.NaN)).toBe(0);
  });
});

describe("threshold gating", () => {
  const articles = [
    mapMatchToSimilarity(match({ sourceUri: "a", score: 0.9 }))!,
    mapMatchToSimilarity(match({ sourceUri: "b", score: 0.6 }))!,
  ];

  it("articlesMeetSimilarityThreshold honors the recommendation threshold", () => {
    expect(articlesMeetSimilarityThreshold(articles, 0.7)).toBe(true);
    expect(articlesMeetSimilarityThreshold(articles, 0.95)).toBe(false);
  });

  it("filterArticlesAboveThreshold keeps only clearing candidates", () => {
    expect(filterArticlesAboveThreshold(articles, 0.7).map((r) => r.rawScore)).toEqual([0.9]);
    expect(filterArticlesAboveThreshold(articles, 0.5)).toHaveLength(2);
  });

  it("bestRawScore returns the max or null", () => {
    expect(bestRawScore(articles)).toBeCloseTo(0.9);
    expect(bestRawScore([])).toBeNull();
  });

  it("meetsAsanaTaskThreshold always passes when threshold is 0", () => {
    expect(meetsAsanaTaskThreshold(null, 0)).toBe(true);
    expect(meetsAsanaTaskThreshold(0.01, 0)).toBe(true);
  });

  it("meetsAsanaTaskThreshold gates on best raw score when threshold > 0", () => {
    expect(meetsAsanaTaskThreshold(0.6, 0.5)).toBe(true);
    expect(meetsAsanaTaskThreshold(0.4, 0.5)).toBe(false);
    expect(meetsAsanaTaskThreshold(null, 0.5)).toBe(false);
  });
});

describe("parent-task CREATE gate (effectiveAsanaTaskThreshold + qualifyingTaskArticles)", () => {
  const articles = [
    mapMatchToSimilarity(match({ sourceUri: "a", score: 0.9 }))!,
    mapMatchToSimilarity(match({ sourceUri: "b", score: 0.4 }))!,
  ];

  it("uses the task threshold directly when it is > 0", () => {
    expect(effectiveAsanaTaskThreshold(0.8, 0.7)).toBeCloseTo(0.8);
  });

  it("falls back to the article threshold when the task threshold is 0 (never 'always create')", () => {
    expect(effectiveAsanaTaskThreshold(0, 0.7)).toBeCloseTo(0.7);
    expect(effectiveAsanaTaskThreshold(Number.NaN, 0.7)).toBeCloseTo(0.7);
  });

  it("qualifies only articles at/above the effective threshold", () => {
    // task threshold 0.7 → only the 0.9 article qualifies.
    expect(qualifyingTaskArticles(articles, 0.7, 0.7).map((r) => r.rawScore)).toEqual([0.9]);
  });

  it("returns EMPTY (=> skip, no parent) when nothing clears the threshold", () => {
    expect(qualifyingTaskArticles([], 0.7, 0.7)).toHaveLength(0);
    const weak = [mapMatchToSimilarity(match({ sourceUri: "c", score: 0.4 }))!];
    expect(qualifyingTaskArticles(weak, 0.7, 0.7)).toHaveLength(0);
  });

  it("a mis-set 0 task threshold still gates via the article-threshold fallback", () => {
    // threshold 0 must NOT mean 'always create'.
    expect(qualifyingTaskArticles(articles, 0, 0.7).map((r) => r.rawScore)).toEqual([0.9]);
  });
});

describe("getTopSoofiArticleSimilarities (mocked client)", () => {
  it("calls the client with the FIXED Soofi filters and settings topK", async () => {
    const queryClient = vi.fn().mockResolvedValue([
      match({ sourceUri: "https://x.com/i/article/x1", score: 0.81 }),
      match({ sourceUri: "https://x.com/i/article/x2", score: 0.42 }),
    ]);

    const result = await getTopSoofiArticleSimilarities("sample post about tokenized real estate", {
      topK: 6,
      queryClient,
    });

    expect(queryClient).toHaveBeenCalledTimes(1);
    const [params] = queryClient.mock.calls[0]!;
    expect(params).toMatchObject({
      query: "sample post about tokenized real estate",
      author: SOOFI_ARTICLE_AUTHOR,
      contentType: SOOFI_ARTICLE_CONTENT_TYPE,
      segmentType: SOOFI_ARTICLE_SEGMENT_TYPE,
      topK: 6,
    });

    expect(result).toHaveLength(2);
    expect(result[0]?.rawScore).toBeCloseTo(0.81);
    expect(result[0]?.score).toBe(81);
  });
});
