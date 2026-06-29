import {
  queryInvestorContent,
  type EnvLike,
  type InvestorContentMatch,
  type QueryInvestorContentParams,
} from "@/mcp/investor-content-client";

export const SOOFI_ARTICLE_AUTHOR = "Soofi Safavi" as const;
export const SOOFI_ARTICLE_CONTENT_TYPE = "article" as const;
export const SOOFI_ARTICLE_SEGMENT_TYPE = "article_full" as const;

export const TOP_ARTICLE_MATCH_LIMIT = 3;

export const DEFAULT_ARTICLE_SIMILARITY_THRESHOLD = 0.7;
export const DEFAULT_ASANA_TASK_SIMILARITY_THRESHOLD = 0;

export type SoofiArticleSimilarity = {
  rawScore: number;
  score: number;
  title: string;
  sourceUri: string;
  excerpt: string;
  contextExcerpt: string;
};

export type GetTopSoofiArticleSimilaritiesOptions = {
  topK: number;
  url?: string;
  env?: EnvLike;
  queryClient?: (
    params: QueryInvestorContentParams,
    options?: { url?: string; env?: EnvLike },
  ) => Promise<InvestorContentMatch[]>;
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\r/g, "").replace(/\s+/g, " ").trim();
}

function clampRelevanceScore(value: unknown, fallback: number): number {
  const parsed = Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.round(parsed);
  if (rounded < 1) return 1;
  if (rounded > 100) return 100;
  return rounded;
}

function truncateToHeader(text: string, maxLength = 80): string {
  const cleaned = normalizeWhitespace(text);
  if (cleaned.length <= maxLength) return cleaned;
  const truncated = cleaned.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(" ");
  const safe = lastSpace > 40 ? truncated.slice(0, lastSpace) : truncated;
  return `${safe.trim()}…`;
}

export function normalizeVectorScoreTo100(rawScore: number): number {
  if (!Number.isFinite(rawScore)) return 1;
  if (rawScore >= 0 && rawScore <= 1) {
    return clampRelevanceScore(Math.round(1 + rawScore * 99), 1);
  }
  if (rawScore >= -1 && rawScore <= 1) {
    return clampRelevanceScore(Math.round(1 + ((rawScore + 1) / 2) * 99), 1);
  }
  if (rawScore > 1 && rawScore <= 100) {
    return clampRelevanceScore(Math.round(rawScore), 1);
  }
  if (rawScore > 100) return 100;
  return 1;
}

export function clampArticleSimilarityThreshold(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_ARTICLE_SIMILARITY_THRESHOLD;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function clampAsanaTaskSimilarityThreshold(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_ASANA_TASK_SIMILARITY_THRESHOLD;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function mapMatchToSimilarity(
  match: InvestorContentMatch,
): SoofiArticleSimilarity | null {
  const sourceUri = normalizeWhitespace(String(match.sourceUri || ""));
  if (!sourceUri) return null;

  const titleFromMatch = normalizeWhitespace(String(match.title || ""));
  const content = normalizeWhitespace(String(match.content || ""));
  const title = titleFromMatch || truncateToHeader(content || sourceUri);
  const excerpt = content ? truncateToHeader(content, 320) : "";
  const contextExcerpt = content ? truncateToHeader(content, 1600) : excerpt;
  const rawScore = Number.isFinite(Number(match.score)) ? Number(match.score) : 0;
  const score = normalizeVectorScoreTo100(rawScore);

  return { rawScore, score, title, sourceUri, excerpt, contextExcerpt };
}

export function dedupeAndRankMatches(
  matches: InvestorContentMatch[],
  limit = TOP_ARTICLE_MATCH_LIMIT,
): SoofiArticleSimilarity[] {
  const bySource = new Map<string, SoofiArticleSimilarity>();
  for (const match of matches) {
    const mapped = mapMatchToSimilarity(match);
    if (!mapped) continue;
    const key = mapped.sourceUri.toLowerCase();
    const existing = bySource.get(key);
    if (!existing || mapped.rawScore > existing.rawScore) {
      bySource.set(key, mapped);
    }
  }

  return Array.from(bySource.values())
    .sort((left, right) => right.rawScore - left.rawScore)
    .slice(0, limit);
}

export async function getTopSoofiArticleSimilarities(
  postText: string,
  opts: GetTopSoofiArticleSimilaritiesOptions,
): Promise<SoofiArticleSimilarity[]> {
  const client = opts.queryClient ?? queryInvestorContent;
  const matches = await client(
    {
      query: postText,
      author: SOOFI_ARTICLE_AUTHOR,
      contentType: SOOFI_ARTICLE_CONTENT_TYPE,
      segmentType: SOOFI_ARTICLE_SEGMENT_TYPE,
      topK: opts.topK,
    },
    { url: opts.url, env: opts.env },
  );
  return dedupeAndRankMatches(matches);
}

export function articlesMeetSimilarityThreshold(
  articles: SoofiArticleSimilarity[],
  articleSimilarityThreshold: number,
): boolean {
  const threshold = clampArticleSimilarityThreshold(articleSimilarityThreshold);
  return articles.some((row) => row.rawScore >= threshold);
}

export function filterArticlesAboveThreshold(
  articles: SoofiArticleSimilarity[],
  articleSimilarityThreshold: number,
): SoofiArticleSimilarity[] {
  const threshold = clampArticleSimilarityThreshold(articleSimilarityThreshold);
  return articles.filter((row) => row.rawScore >= threshold);
}

export function meetsAsanaTaskThreshold(
  bestCandidateRawScore: number | null | undefined,
  asanaTaskSimilarityThreshold: number,
): boolean {
  const threshold = clampAsanaTaskSimilarityThreshold(asanaTaskSimilarityThreshold);
  if (threshold <= 0) return true;
  if (bestCandidateRawScore === null || bestCandidateRawScore === undefined) {
    return false;
  }
  return bestCandidateRawScore >= threshold;
}

export function effectiveAsanaTaskThreshold(
  asanaTaskSimilarityThreshold: number,
  articleSimilarityThreshold: number,
): number {
  const task = clampAsanaTaskSimilarityThreshold(asanaTaskSimilarityThreshold);
  if (task > 0) return task;
  return clampArticleSimilarityThreshold(articleSimilarityThreshold);
}

export function qualifyingTaskArticles(
  articles: SoofiArticleSimilarity[],
  asanaTaskSimilarityThreshold: number,
  articleSimilarityThreshold: number,
): SoofiArticleSimilarity[] {
  const threshold = effectiveAsanaTaskThreshold(
    asanaTaskSimilarityThreshold,
    articleSimilarityThreshold,
  );
  return articles.filter((row) => row.rawScore >= threshold);
}

export function bestRawScore(
  articles: SoofiArticleSimilarity[],
): number | null {
  if (articles.length === 0) return null;
  return Math.max(...articles.map((row) => row.rawScore));
}
