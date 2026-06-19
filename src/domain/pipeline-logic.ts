import type { ArticleMatch, PostCandidate } from "./types.js";
import type { AsanaConfig, Settings } from "../config/schema.js";

/**
 * Pure pipeline logic — no I/O, fully unit-testable. These mirror the gating and
 * ordering decisions made by the investors-mcp monitor-x route.
 */

/** Stable dedupe key for a post (source URI + status id). */
export function dedupeKey(post: Pick<PostCandidate, "sourceUri" | "statusId">): string {
  return `${post.sourceUri}::${post.statusId}`;
}

/**
 * Return posts strictly newer than the per-handle cursor (last-seen status id).
 * X status ids are monotonically increasing snowflake ids compared numerically
 * via BigInt to stay correct beyond Number.MAX_SAFE_INTEGER.
 */
export function detectNewPosts(
  posts: PostCandidate[],
  lastSeenStatusId: string | undefined,
): PostCandidate[] {
  if (!lastSeenStatusId) return [...posts];
  let cursor: bigint;
  try {
    cursor = BigInt(lastSeenStatusId);
  } catch {
    return [...posts];
  }
  return posts.filter((p) => {
    try {
      return BigInt(p.statusId) > cursor;
    } catch {
      return true;
    }
  });
}

/** Highest status id in a batch, for advancing the cursor. Undefined if empty. */
export function maxStatusId(posts: PostCandidate[]): string | undefined {
  let max: bigint | undefined;
  let maxStr: string | undefined;
  for (const p of posts) {
    let v: bigint;
    try {
      v = BigInt(p.statusId);
    } catch {
      continue;
    }
    if (max === undefined || v > max) {
      max = v;
      maxStr = p.statusId;
    }
  }
  return maxStr;
}

/**
 * Compute how far the per-handle cursor may advance after a run. The cursor moves
 * to the newest fetched post, EXCEPT it never passes a failed post — so failed
 * posts (and anything newer) are re-fetched next run and retried, while already
 * succeeded/skipped posts are filtered by the processed/tasked dedupe sets.
 */
export function safeCursor(
  fetched: Array<{ statusId: string }>,
  failedStatusIds: string[],
): string | undefined {
  const toBig = (s: string): bigint | undefined => {
    try {
      return BigInt(s);
    } catch {
      return undefined;
    }
  };

  const failed = failedStatusIds.map(toBig).filter((v): v is bigint => v !== undefined);
  const ceiling = failed.length ? failed.reduce((m, v) => (v < m ? v : m)) : undefined;

  let best: bigint | undefined;
  let bestStr: string | undefined;
  for (const p of fetched) {
    const v = toBig(p.statusId);
    if (v === undefined) continue;
    if (ceiling !== undefined && v >= ceiling) continue; // never advance past a failure
    if (best === undefined || v > best) {
      best = v;
      bestStr = p.statusId;
    }
  }
  return bestStr;
}

/**
 * Select a batch from the watchlist using cursor rotation: start at `offset`,
 * take `batchSize`, wrapping around. Returns the batch and the next offset.
 */
export function selectBatch<T>(
  items: T[],
  offset: number,
  batchSize: number,
): { batch: T[]; nextOffset: number } {
  if (items.length === 0) return { batch: [], nextOffset: 0 };
  const size = Math.min(batchSize, items.length);
  const start = ((offset % items.length) + items.length) % items.length;
  const batch: T[] = [];
  for (let i = 0; i < size; i++) {
    batch.push(items[(start + i) % items.length]!);
  }
  return { batch, nextOffset: (start + size) % items.length };
}

/** Normalize a raw cosine score (0..1) to a 0..100 display score. */
export function toDisplayScore(rawScore: number): number {
  return Math.round(Math.max(0, Math.min(1, rawScore)) * 100);
}

/** Best (highest) raw score across matches, or 0 when none. */
export function bestRawScore(matches: ArticleMatch[]): number {
  return matches.reduce((m, a) => Math.max(m, a.rawScore), 0);
}

/** Whether the best match clears the parent-task gate. */
export function meetsParentThreshold(matches: ArticleMatch[], settings: Settings): boolean {
  return bestRawScore(matches) >= settings.asanaTaskSimilarityThreshold;
}

/** Matches that clear the per-article recommendation/subtask gate, best first. */
export function qualifyingArticles(matches: ArticleMatch[], settings: Settings): ArticleMatch[] {
  return matches
    .filter((m) => m.rawScore >= settings.articleSimilarityThreshold)
    .sort((a, b) => b.rawScore - a.rawScore);
}

/** Top-K matches by raw score, descending. */
export function rankMatches(matches: ArticleMatch[], topK: number): ArticleMatch[] {
  return [...matches].sort((a, b) => b.rawScore - a.rawScore).slice(0, topK);
}

export interface AssigneeDecision {
  assignee?: string;
  /** When true, threshold rules applied → parent due date should be today. */
  dueToday: boolean;
}

/**
 * Resolve the parent task assignee. When best-match raw similarity meets the
 * configured threshold, route to the threshold assignee and mark due-today.
 */
export function resolveAssignee(matches: ArticleMatch[], asana: AsanaConfig): AssigneeDecision {
  const best = bestRawScore(matches);
  if (asana.thresholdAssignee && best >= asana.thresholdAssigneeRawScore) {
    return { assignee: asana.thresholdAssignee, dueToday: true };
  }
  return { assignee: asana.defaultAssignee, dueToday: false };
}

/**
 * Build an X "compose intent" link that pre-fills a reply to a given status.
 * Used in Asana subtasks so an operator can post the approved draft in one click.
 */
export function composeIntentLink(replyText: string, inReplyToStatusId?: string): string {
  const params = new URLSearchParams({ text: replyText });
  if (inReplyToStatusId) params.set("in_reply_to", inReplyToStatusId);
  return `https://x.com/intent/post?${params.toString()}`;
}

/**
 * Hard-trim a reply to at most `max` chars at a word boundary. Last-resort
 * backstop when the model won't respect the limit even after a regeneration.
 */
export function trimToLimit(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const slice = t.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return cut.trimEnd();
}

/** Truncate text to an excerpt suitable for task notes. */
export function makeExcerpt(content: string, maxLen = 280): string {
  const clean = content.replace(/\s+/g, " ").trim();
  return clean.length <= maxLen ? clean : `${clean.slice(0, maxLen - 1).trimEnd()}…`;
}
