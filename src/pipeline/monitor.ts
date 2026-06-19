import type { AgentConfig } from "../config/index.js";
import type { WatchedAuthor } from "../config/schema.js";
import type { XClient } from "../x/client.js";
import type { InvestorContentQuerier } from "../mcp/client.js";
import type { ReplyGenerator } from "../llm/reply-generator.js";
import type { AsanaClient } from "../asana/client.js";
import type { StateStore } from "../state/store.js";
import type { Logger } from "../observability/logger.js";
import { createLogger } from "../observability/logger.js";
import type { ArticleMatch, PostCandidate, PostResult, ReplyDraft, RunSummary } from "../domain/types.js";
import {
  bestRawScore,
  dedupeKey,
  detectNewPosts,
  meetsParentThreshold,
  qualifyingArticles,
  rankMatches,
  resolveAssignee,
  safeCursor,
  selectBatch,
} from "../domain/pipeline-logic.js";

/**
 * Orchestrates one polling run end-to-end. Mirrors investors-mcp `handleMonitor`:
 * batch selection + cursor rotation → new-post detection → referenced enrichment
 * → RAG match → threshold gates → reply drafts → Asana tasks → state persistence.
 */
export interface MonitorDeps {
  config: AgentConfig;
  x: XClient;
  mcp: InvestorContentQuerier;
  replies: ReplyGenerator;
  asana: AsanaClient;
  state: StateStore;
  logger?: Logger;
  dryRun: boolean;
  now?: () => Date;
}

export interface MonitorOptions {
  /** Restrict the run to a single author handle (isolation / single-author demo). */
  onlyHandle?: string;
}

export async function runMonitor(deps: MonitorDeps, options: MonitorOptions = {}): Promise<RunSummary> {
  const log = deps.logger ?? createLogger("monitor");
  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const { settings, watchlist } = deps.config;

  let active = watchlist.authors.filter((a) => a.active);
  if (options.onlyHandle) {
    const h = options.onlyHandle.toLowerCase().replace(/^@/, "");
    active = active.filter((a) => a.handle.toLowerCase() === h);
  }

  const offset = options.onlyHandle ? 0 : await deps.state.getBatchOffset();
  const { batch, nextOffset } = options.onlyHandle
    ? { batch: active, nextOffset: 0 }
    : selectBatch(active, offset, settings.defaultBatchSize);

  log.info("run started", {
    dryRun: deps.dryRun,
    authorsInBatch: batch.length,
    onlyHandle: options.onlyHandle,
  });

  const results: PostResult[] = [];
  let postsFetched = 0;

  for (const author of batch) {
    try {
      const fetched = await deps.x.fetchAuthorPosts({
        handle: author.handle,
        sinceStatusId: await deps.state.getCursor(author.handle),
        maxResults: settings.defaultMaxPostsPerAuthor,
      });
      postsFetched += fetched.length;

      const fresh = detectNewPosts(fetched, await deps.state.getCursor(author.handle));
      log.info("author polled", { handle: author.handle, fetched: fetched.length, fresh: fresh.length });

      const authorResults: PostResult[] = [];
      for (const post of fresh) {
        const result = await processPost(deps, log, author, post);
        authorResults.push(result);
        results.push(result);
      }

      // Advance the cursor up to (but not past) any failed post, so failures retry.
      if (!deps.dryRun) {
        const failedIds = authorResults
          .filter((r) => r.outcome === "failed")
          .map((r) => r.post.statusId);
        const newCursor = safeCursor(fetched, failedIds);
        if (newCursor) await deps.state.setCursor(author.handle, newCursor);
      }
    } catch (err) {
      log.error("author failed", { handle: author.handle, error: String(err) });
    }
  }

  if (!deps.dryRun && !options.onlyHandle) {
    await deps.state.setBatchOffset(nextOffset);
  }

  const summary = summarize(results, {
    startedAt,
    finishedAt: now().toISOString(),
    dryRun: deps.dryRun,
    authorsPolled: batch.length,
    postsFetched,
  });

  if (!deps.dryRun) {
    await deps.state.appendRunSummary(summary);
  }
  log.info("run summary", { ...summary, results: undefined });
  return summary;
}

async function processPost(
  deps: MonitorDeps,
  log: Logger,
  author: WatchedAuthor,
  post: PostCandidate,
): Promise<PostResult> {
  const { settings } = deps.config;
  const key = dedupeKey(post);

  if (await deps.state.isProcessed(key)) {
    return { post, outcome: "skipped", reason: "already-processed" };
  }
  if (author.excludeFromTasking) {
    if (!deps.dryRun) await deps.state.markProcessed(key);
    return { post, outcome: "skipped", reason: "excluded-author" };
  }
  if (await deps.state.isTasked(key)) {
    return { post, outcome: "skipped", reason: "already-tasked" };
  }

  try {
    // Use referenced-original text too when present, to catch relevant threads.
    const query = post.referencedOriginal
      ? `${post.text}\n\n${post.referencedOriginal.text}`
      : post.text;

    const allMatches = await deps.mcp.queryInvestorContent({
      query,
      author: "Soofi Safavi",
      contentType: "article",
      segmentType: "article_full",
      topK: settings.defaultTopK,
    });
    const matches = rankMatches(allMatches, settings.defaultTopK);
    const best = bestRawScore(matches);

    if (!meetsParentThreshold(matches, settings)) {
      if (!deps.dryRun) await deps.state.markProcessed(key);
      return { post, outcome: "skipped", reason: "below-parent-threshold", bestRawScore: best, matches };
    }

    const qualifying = qualifyingArticles(matches, settings).slice(0, settings.maxArticlesPerPost);
    if (qualifying.length === 0) {
      if (!deps.dryRun) await deps.state.markProcessed(key);
      return {
        post,
        outcome: "skipped",
        reason: "no-article-met-recommendation-threshold",
        bestRawScore: best,
        matches,
      };
    }

    // Generate ALL drafts before any Asana write, so an LLM failure leaves no
    // orphaned parent task and the post can be retried cleanly on the next run.
    const recommendations: { article: ArticleMatch; drafts: ReplyDraft[] }[] = [];
    for (const article of qualifying) {
      recommendations.push({ article, drafts: await deps.replies.draftsForArticle(post, article) });
    }

    const assignee = resolveAssignee(matches, settings.asana);
    const parentTaskId = await deps.asana.createParentTask({
      post,
      matches,
      bestRawScore: best,
      assignee: assignee.assignee,
      dueToday: assignee.dueToday,
      thresholds: {
        asanaTaskSimilarityThreshold: settings.asanaTaskSimilarityThreshold,
        articleSimilarityThreshold: settings.articleSimilarityThreshold,
      },
    });

    let subtaskCount = 0;
    for (const { article, drafts } of recommendations) {
      for (const draft of drafts) {
        await deps.asana.createSubtask({ parentTaskId, post, article, draft });
        subtaskCount++;
      }
    }

    if (!deps.dryRun) {
      await deps.state.markTasked(key);
      await deps.state.markProcessed(key);
    }

    log.info("post tasked", { statusId: post.statusId, parentTaskId, subtaskCount });
    return { post, outcome: "tasked", bestRawScore: best, matches, parentTaskId, subtaskCount };
  } catch (err) {
    log.error("post failed", { statusId: post.statusId, error: String(err) });
    return { post, outcome: "failed", reason: String(err) };
  }
}

function summarize(
  results: PostResult[],
  base: Pick<RunSummary, "startedAt" | "finishedAt" | "dryRun" | "authorsPolled" | "postsFetched">,
): RunSummary {
  const tasked = results.filter((r) => r.outcome === "tasked");
  return {
    ...base,
    newPostsProcessed: results.length,
    ingested: 0,
    parentTasksCreated: tasked.length,
    subtasksCreated: tasked.reduce((n, r) => n + (r.subtaskCount ?? 0), 0),
    skipped: results.filter((r) => r.outcome === "skipped").length,
    failed: results.filter((r) => r.outcome === "failed").length,
    results,
  };
}
