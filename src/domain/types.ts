/**
 * Core domain types shared across the pipeline. Pure data shapes — no I/O.
 */

/** A post fetched from X that is a candidate for engagement. */
export interface PostCandidate {
  /** Canonical X URL of the post (dedupe key component). */
  sourceUri: string;
  /** X status / tweet id (dedupe key component). */
  statusId: string;
  /** Handle of the watched author this post came from (without leading @). */
  handle: string;
  /** Short header / first line used for task titles. */
  header: string;
  /** Full post text used as the RAG query and reply context. */
  text: string;
  /** ISO timestamp of the post, if known. */
  createdAt?: string;
  /**
   * When the watched author replied to or quoted another post, the referenced
   * original is enriched and attached here so it can be considered too.
   */
  referencedOriginal?: ReferencedPost;
  /** Long-form X article body when the post links/contains one. */
  articleBody?: string;
}

export interface ReferencedPost {
  sourceUri: string;
  statusId: string;
  /** "reply" or "quote" — how the watched post references the original. */
  relation: "reply" | "quote";
  authorHandle?: string;
  text: string;
}

/** A Soofi article matched against a post via the investors-mcp RAG tool. */
export interface ArticleMatch {
  title: string;
  sourceUri: string;
  /** Raw cosine similarity (0..1) — used for all threshold gating. */
  rawScore: number;
  /** Normalized 0..100 display score derived from rawScore. */
  score: number;
  /** Short excerpt drawn from the article body for task notes. */
  excerpt: string;
  /** Full article body used to ground reply drafts. */
  content: string;
}

/** One generated reply draft, one per reply prompt file per matched article. */
export interface ReplyDraft {
  /** 1-based index from the prompt filename prefix. */
  promptIndex: number;
  /** Human label, e.g. "Prompt 1". */
  promptLabel: string;
  /** The instruction text loaded from the prompt file. */
  promptText: string;
  /** The drafted reply, ready for human review. */
  suggestedResponse: string;
  /** Short rationale grounding the recommendation in the matched article. */
  whyRecommended: string;
}

/** Per-post outcome recorded in run state. */
export type PostOutcome = "ingested" | "skipped" | "tasked" | "failed";

export interface PostResult {
  post: PostCandidate;
  outcome: PostOutcome;
  reason?: string;
  bestRawScore?: number;
  matches?: ArticleMatch[];
  parentTaskId?: string;
  subtaskCount?: number;
}

/** Structured summary emitted at the end of a run. */
export interface RunSummary {
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  authorsPolled: number;
  postsFetched: number;
  newPostsProcessed: number;
  ingested: number;
  parentTasksCreated: number;
  subtasksCreated: number;
  skipped: number;
  failed: number;
  results: PostResult[];
}
