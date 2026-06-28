import type { ArticleMatcher, MatchedArticle } from "./ports.js";
import { McpClient, type QueryInvestorContentArgs, type RawMatch } from "./mcp/client.js";
import { coerceRecord } from "./mcp/parse.js";

const CONTEXT_EXCERPT_MAX = 1600;
const PASSAGE_MAX = 360;
const MAX_ARTICLES = 3;
const MAX_PASSAGES = 3;

/** The Soofi author filter, matching the corpus's resolved keys. */
const SOOFI_AUTHOR = "Soofi Safavi";

/**
 * Article matcher backed by the hosted investors-mcp `queryInvestorContent`
 * tool. Replicates the reference `getTopSoofiArticleSimilarities`: query Soofi
 * `article_full` segments, dedupe by `sourceUri` keeping the highest score, and
 * return the top 3 — then enrich with paragraph-level supporting passages.
 *
 * Score handling: the MCP `score` is treated as the **raw** cosine similarity
 * in [0,1] (used directly for threshold gating). A display score in [1,100] is
 * derived as `round(((raw + 1) / 2) * 100)`, matching the reference fixture
 * (raw 0.82 -> 91). This is documented in docs/decisions.md (ADR-0003).
 */
export class McpArticleMatcher implements ArticleMatcher {
  constructor(private readonly client: McpClient = new McpClient()) {}

  async getTopSoofiArticleSimilarities(postText: string, topK: number): Promise<MatchedArticle[]> {
    const query = postText.trim();
    if (!query) return [];

    const baseArgs: QueryInvestorContentArgs = {
      query,
      author: SOOFI_AUTHOR,
      contentType: "article",
      topK,
    };

    const full = await this.client.queryInvestorContent({ ...baseArgs, segmentType: "article_full" });
    const articles = dedupeTopArticles(full.matches);
    if (articles.length === 0) return [];

    // Enrich with paragraph-level passages (one extra call), grouped by sourceUri.
    const passagesByUri = await this.fetchPassages(query, topK);
    for (const a of articles) {
      const passages = passagesByUri.get(a.sourceUri) ?? [];
      if (passages.length > 0) a.supportingParagraphs = passages.slice(0, MAX_PASSAGES);
    }
    return articles;
  }

  private async fetchPassages(query: string, topK: number): Promise<Map<string, string[]>> {
    const byUri = new Map<string, string[]>();
    try {
      const para = await this.client.queryInvestorContent({
        query,
        author: SOOFI_AUTHOR,
        contentType: "article",
        segmentType: "article_paragraph",
        topK: Math.min(20, Math.max(topK, 10)),
      });
      for (const m of para.matches) {
        const f = extractMatchFields(m);
        if (!f.sourceUri || !f.content) continue;
        const list = byUri.get(f.sourceUri) ?? [];
        list.push(truncate(f.content, PASSAGE_MAX));
        byUri.set(f.sourceUri, list);
      }
    } catch {
      // Passages are best-effort enrichment; the article excerpt is the fallback.
    }
    return byUri;
  }
}

/** Dedupe matches by sourceUri (keep highest rawScore) and return the top N as MatchedArticle. */
export function dedupeTopArticles(matches: RawMatch[]): MatchedArticle[] {
  const best = new Map<string, MatchedArticle>();
  for (const m of matches) {
    const f = extractMatchFields(m);
    if (!f.sourceUri) continue;
    const existing = best.get(f.sourceUri);
    if (existing && existing.rawScore >= f.rawScore) continue;
    best.set(f.sourceUri, {
      sourceUri: f.sourceUri,
      title: f.title || "Untitled Soofi article",
      rawScore: f.rawScore,
      score100: toScore100(f.rawScore),
      contextExcerpt: truncate(f.content, CONTEXT_EXCERPT_MAX),
      supportingParagraphs: [],
    });
  }
  return [...best.values()].sort((a, b) => b.rawScore - a.rawScore).slice(0, MAX_ARTICLES);
}

/** Extract the fields we need from a raw match, parsing the Python-literal blob/metadata. */
export function extractMatchFields(m: RawMatch): {
  sourceUri: string;
  title: string;
  content: string;
  rawScore: number;
} {
  const blob = coerceRecord(m.blob);
  const meta = coerceRecord(m.metadata);
  const sourceUri = String(blob.sourceUri ?? meta.sourceUri ?? "");
  const title = String(blob.title ?? meta.title ?? "");
  const content = String(blob.content ?? "");
  const rawScore = Number(m.score);
  return { sourceUri, title, content, rawScore: Number.isFinite(rawScore) ? rawScore : 0 };
}

/** Display score in [1,100] from a raw cosine in [-1,1]. */
export function toScore100(raw: number): number {
  return Math.max(1, Math.min(100, Math.round(((raw + 1) / 2) * 100)));
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}
