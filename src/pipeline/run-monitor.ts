import type { Settings } from "@/config/load-settings";
import type { PromptBundle } from "@/config/load-prompts";
import type { WatchAuthor } from "@/config/load-watchlist";
import type {
  EnvLike,
  InvestorContentMatch,
  QueryInvestorContentParams,
} from "@/mcp/investor-content-client";
import {
  bestRawScore,
  clampArticleSimilarityThreshold,
  clampAsanaTaskSimilarityThreshold,
  effectiveAsanaTaskThreshold,
  filterArticlesAboveThreshold,
  getTopSoofiArticleSimilarities,
  qualifyingTaskArticles,
  type SoofiArticleSimilarity,
} from "@/matching/article-similarity";
import {
  buildPostDedupeKey,
  type ParsedPost,
} from "@/x/parse-post";
import {
  generateArticleReplyDrafts,
  type ReplyModel,
} from "@/agent/reply-generation";
import {
  buildAsanaRecommendationSubtaskNotes,
  buildAsanaSimilarityTaskNotes,
  type ArticleRecommendation,
  type NotePost,
} from "@/asana/task-notes";
import {
  createRunSummaryBuilder,
  logRuntime,
  type RunSummary,
} from "@/observability/logger";

export type InputPost = Partial<ParsedPost> & {
  statusId: string;
  sourceUri: string;
  text: string;
  header?: string;
  author?: string;
  handle?: string;
};

export type WouldBeSubtask = {
  promptIndex: number;
  promptLabel: string;
  draftText: string;
  notes: string;
};

export type WouldBeTask = {
  statusId: string;
  sourceUri: string;
  author: string;
  handle: string;
  name: string;
  notes: string;
  bestRawScore: number | null;
  recommendations: ArticleRecommendation[];
  subtasks: WouldBeSubtask[];
  created?: CreatedAsanaTask;
};

export type CreatedAsanaTask = {
  parentGid?: string;
  parentUrl?: string;
  subtaskGids?: string[];
};

export type CreateAsanaTaskResult = {
  created: boolean;
  reason: string;
} & CreatedAsanaTask;

type AsanaDecision = {
  created: boolean;
  reason: string;
  task?: WouldBeTask;
};

export type FetchPostsResult =
  | InputPost[]
  | { posts: InputPost[]; organic: boolean };

export type RunMonitorState = {
  getAlreadyTasked: (keys: string[]) => Promise<Set<string>>;
  markTasked: (keys: string[]) => Promise<void>;
  setPollingCursor: (handle: string, statusId: string) => Promise<void>;
  getRotationOffset?: () => Promise<number>;
  setRotationOffset?: (offset: number) => Promise<void>;
};

export function selectBatch<T>(items: T[], batchSize: number, offset: number): T[] {
  const total = items.length;
  if (total === 0) return [];
  const size = Math.min(Math.max(1, Math.floor(batchSize)), total);
  const start = ((Math.floor(offset) % total) + total) % total;
  const out: T[] = [];
  for (let i = 0; i < size; i += 1) {
    out.push(items[(start + i) % total] as T);
  }
  return out;
}

export function nextRotationOffset(
  total: number,
  batchSize: number,
  offset: number,
): number {
  if (total === 0) return 0;
  const size = Math.min(Math.max(1, Math.floor(batchSize)), total);
  const start = ((Math.floor(offset) % total) + total) % total;
  return (start + size) % total;
}

export type RunMonitorDeps = {
  state?: RunMonitorState;
  fetchPosts?: (params: {
    watchlist: WatchAuthor[];
    settings: Settings;
    posts: InputPost[];
  }) => Promise<FetchPostsResult>;
  fetchReferenced?: (statusIds: string[]) => Promise<InputPost[]>;
  model?: ReplyModel;
  queryClient?: (
    params: QueryInvestorContentParams,
    options?: { url?: string; env?: EnvLike },
  ) => Promise<InvestorContentMatch[]>;
  mcpUrl?: string;
  env?: EnvLike;
  createAsanaTask?: (task: WouldBeTask) => Promise<CreateAsanaTaskResult>;
  now?: () => Date;
  runKey?: () => string;
};

export type RunMonitorParams = {
  posts: InputPost[];
  settings: Settings;
  watchlist: WatchAuthor[];
  prompts: PromptBundle;
  deps?: RunMonitorDeps;
  dryRun?: boolean;
};

export type RunMonitorResult = {
  summary: RunSummary;
  tasks: WouldBeTask[];
  organic: boolean;
};

function normalizeWhitespace(value: string): string {
  return String(value ?? "").replace(/\r/g, "").replace(/\s+/g, " ").trim();
}

function toParsedPost(input: InputPost): ParsedPost {
  return {
    statusId: normalizeWhitespace(input.statusId),
    sourceUri: normalizeWhitespace(input.sourceUri),
    text: String(input.text ?? ""),
    header: input.header ?? "",
    date: input.date ?? "",
    contentCreatedAt: input.contentCreatedAt ?? "",
    contentType: input.contentType ?? "post",
    canonicalSource: input.canonicalSource ?? true,
    ...(input.referencedStatuses ? { referencedStatuses: input.referencedStatuses } : {}),
    ...(input.interaction ? { interaction: input.interaction } : {}),
  };
}

function toNotePost(post: ParsedPost): NotePost {
  return {
    statusId: post.statusId,
    sourceUri: post.sourceUri,
    text: post.text,
    contentType: post.contentType,
    ...(post.contentCreatedAt ? { contentCreatedAt: post.contentCreatedAt } : {}),
  };
}

async function decideAsanaTask(params: {
  post: ParsedPost;
  author: string;
  handle: string;
  settings: Settings;
  prompts: PromptBundle;
  model: ReplyModel;
  topSimilarArticles: SoofiArticleSimilarity[];
  dryRun: boolean;
  excluded: boolean;
}): Promise<AsanaDecision & { matched: ArticleRecommendation[]; best: number | null }> {
  const {
    post,
    settings,
    prompts,
    model,
    topSimilarArticles,
    dryRun,
    excluded,
  } = params;

  const asanaTaskSimilarityThreshold = clampAsanaTaskSimilarityThreshold(
    settings.asanaTaskSimilarityThreshold,
  );
  const articleSimilarityThreshold = clampArticleSimilarityThreshold(
    settings.articleSimilarityThreshold,
  );
  const best = bestRawScore(topSimilarArticles);

  if (excluded) {
    return { created: false, reason: "excluded-soofi-author", matched: [], best };
  }

  const taskThreshold = effectiveAsanaTaskThreshold(
    asanaTaskSimilarityThreshold,
    articleSimilarityThreshold,
  );
  const taskQualified = qualifyingTaskArticles(
    topSimilarArticles,
    asanaTaskSimilarityThreshold,
    articleSimilarityThreshold,
  );
  if (taskQualified.length === 0) {
    const scoreLabel = best === null ? "none" : best.toFixed(4);
    return {
      created: false,
      reason: `below-similarity-threshold:${scoreLabel}<${taskThreshold.toFixed(4)}`,
      matched: [],
      best,
    };
  }

  const recommendArticleSet = new Set(
    [
      ...filterArticlesAboveThreshold(topSimilarArticles, articleSimilarityThreshold),
      ...taskQualified,
    ].map((row) => row.sourceUri.toLowerCase()),
  );
  const thresholdQualified = topSimilarArticles.filter((row) =>
    recommendArticleSet.has(row.sourceUri.toLowerCase()),
  );

  const recommendations: ArticleRecommendation[] = await Promise.all(
    thresholdQualified.map((article) =>
      generateArticleReplyDrafts({
        prompts,
        post: toNotePost(post),
        article,
        model,
      }),
    ),
  );

  const notePost = toNotePost(post);
  const taskName = `Draft response: ${params.author} - ${post.header || post.text.slice(0, 60)}`;
  const notes = buildAsanaSimilarityTaskNotes({
    post: notePost,
    topSimilarArticles: recommendations,
    asanaTaskSimilarityThreshold,
    articleSimilarityThreshold,
    bestCandidateRawScore: best,
  });

  const subtasks: WouldBeSubtask[] = [];
  for (const rec of recommendations) {
    for (const response of rec.suggestedResponses ?? []) {
      subtasks.push({
        promptIndex: response.promptIndex,
        promptLabel: response.promptLabel,
        draftText: response.text,
        notes: buildAsanaRecommendationSubtaskNotes({
          recommendation: rec,
          post: notePost,
          response,
        }),
      });
    }
  }

  const task: WouldBeTask = {
    statusId: post.statusId,
    sourceUri: post.sourceUri,
    author: params.author,
    handle: params.handle,
    name: taskName,
    notes,
    bestRawScore: best,
    recommendations,
    subtasks,
  };

  const reason = dryRun ? "dry-run" : "created";
  return { created: false, reason, task, matched: recommendations, best };
}

function requireModel(deps: RunMonitorDeps): ReplyModel {
  if (!deps.model) {
    throw new Error(
      "No reply model provided — runMonitor requires deps.model (real Bedrock at runtime; a stub in tests).",
    );
  }
  return deps.model;
}

export async function runMonitor(params: RunMonitorParams): Promise<RunMonitorResult> {
  const dryRun = params.dryRun ?? true;
  const deps = params.deps ?? {};
  const model = requireModel(deps);
  const now = deps.now ?? (() => new Date());
  const runKey = (deps.runKey ?? (() => now().toISOString()))();
  const startedAt = now().toISOString();

  const excludeAuthors = new Set(
    params.settings.excludeAuthors.map((a) => a.toLowerCase()),
  );

  const builder = createRunSummaryBuilder({ runKey, startedAt, dryRun });

  if (params.settings.paused) {
    builder.setSkipReason("paused");
    return { summary: builder.build({ finishedAt: now().toISOString() }), tasks: [], organic: false };
  }

  if (params.watchlist.length === 0) {
    builder.setSkipReason("watchlist-empty");
    return { summary: builder.build({ finishedAt: now().toISOString() }), tasks: [], organic: false };
  }

  const rotationEnabled = Boolean(
    deps.state?.getRotationOffset && deps.state?.setRotationOffset,
  );
  let rotationOffset = 0;
  if (rotationEnabled && deps.state?.getRotationOffset) {
    rotationOffset = await deps.state.getRotationOffset();
  }
  const batch = selectBatch(
    params.watchlist,
    params.settings.defaultBatchSize,
    rotationOffset,
  );

  builder.recordAuthorsPolled(batch.length);

  const fetchPosts =
    deps.fetchPosts ?? (async ({ posts }) => posts);
  const fetchedRaw = await fetchPosts({
    watchlist: batch,
    settings: params.settings,
    posts: params.posts,
  });
  const polled = Array.isArray(fetchedRaw) ? fetchedRaw : fetchedRaw.posts;
  const organic = Array.isArray(fetchedRaw) ? true : fetchedRaw.organic;

  const polledIds = new Set(polled.map((p) => normalizeWhitespace(p.statusId)));
  const referencedIds = new Set<string>();
  for (const input of polled) {
    const interactionType = input.interaction?.type;
    if (interactionType !== "reply" && interactionType !== "quote") continue;
    const refs = [
      ...(input.interaction?.referencedStatusIds ?? []),
      ...(input.referencedStatuses ?? []).map((r) => r.statusId),
      ...(input.interaction?.parentStatusId ? [input.interaction.parentStatusId] : []),
    ];
    for (const id of refs) {
      const clean = normalizeWhitespace(String(id ?? ""));
      if (clean && !polledIds.has(clean)) referencedIds.add(clean);
    }
  }
  let referencedPosts: InputPost[] = [];
  if (deps.fetchReferenced && referencedIds.size > 0) {
    try {
      const result = await deps.fetchReferenced(Array.from(referencedIds));
      referencedPosts = result.filter(
        (p) => !polledIds.has(normalizeWhitespace(p.statusId)),
      );
    } catch (error) {
      logRuntime({
        level: "warn",
        message: "Referenced-original fetch failed; processing polled posts only.",
        reason: error instanceof Error ? error.message : String(error),
        referencedIds: referencedIds.size,
      });
    }
  }

  const fetched = [...polled, ...referencedPosts];
  builder.recordPostsFetched(fetched.length);
  builder.recordNewPosts(fetched.length);

  const tasks: WouldBeTask[] = [];
  const seen = new Set<string>();

  const allDedupeKeys = fetched.map((input) =>
    buildPostDedupeKey({
      sourceUri: normalizeWhitespace(input.sourceUri),
      statusId: normalizeWhitespace(input.statusId),
    }),
  );
  const priorTasked = deps.state
    ? await deps.state.getAlreadyTasked(allDedupeKeys)
    : new Set<string>();

  const watchlistHandles = new Set(
    batch.map((w) => normalizeWhitespace(w.handle).toLowerCase()).filter(Boolean),
  );
  const maxStatusByHandle = new Map<string, string>();
  const advanceCursor = (handle: string, statusId: string): void => {
    if (!handle || !statusId || !watchlistHandles.has(handle)) return;
    const current = maxStatusByHandle.get(handle);
    if (current === undefined || compareStatusIds(statusId, current) > 0) {
      maxStatusByHandle.set(handle, statusId);
    }
  };

  const taskedThisRun: string[] = [];

  for (const input of fetched) {
    const post = toParsedPost(input);
    const author = normalizeWhitespace(input.author || "") || "(unknown author)";
    const handle = normalizeWhitespace(input.handle || "").toLowerCase();
    const excluded =
      excludeAuthors.has(author.toLowerCase()) ||
      (handle ? excludeAuthors.has(handle) : false);

    const dedupeKey = buildPostDedupeKey({
      sourceUri: post.sourceUri,
      statusId: post.statusId,
    });

    if (seen.has(dedupeKey)) {
      advanceCursor(handle, post.statusId);
      builder.recordPost({
        sourceUri: post.sourceUri,
        statusId: post.statusId,
        author,
        handle,
        outcome: "skipped",
        reason: "already-tasked",
      });
      continue;
    }
    seen.add(dedupeKey);

    if (priorTasked.has(dedupeKey)) {
      advanceCursor(handle, post.statusId);
      builder.recordPost({
        sourceUri: post.sourceUri,
        statusId: post.statusId,
        author,
        handle,
        outcome: "skipped",
        reason: "already-tasked",
      });
      continue;
    }

    try {
      const topSimilarArticles = await getTopSoofiArticleSimilarities(post.text, {
        topK: params.settings.defaultTopK,
        ...(deps.mcpUrl ? { url: deps.mcpUrl } : {}),
        ...(deps.env ? { env: deps.env } : {}),
        ...(deps.queryClient ? { queryClient: deps.queryClient } : {}),
      });

      const decision = await decideAsanaTask({
        post,
        author,
        handle,
        settings: params.settings,
        prompts: params.prompts,
        model,
        topSimilarArticles,
        dryRun,
        excluded,
      });

      if (decision.task) {
        let live: { created: boolean; reason: string } | null = null;
        if (!dryRun && deps.createAsanaTask) {
          const result = await deps.createAsanaTask(decision.task);
          live = { created: result.created, reason: result.reason };
          if (result.created) {
            decision.task.created = {
              ...(result.parentGid ? { parentGid: result.parentGid } : {}),
              ...(result.parentUrl ? { parentUrl: result.parentUrl } : {}),
              ...(result.subtaskGids ? { subtaskGids: result.subtaskGids } : {}),
            };
          }
        }
        tasks.push(decision.task);

        if (live && !live.created) {
          builder.recordPost({
            sourceUri: post.sourceUri,
            statusId: post.statusId,
            author,
            handle,
            outcome: "skipped",
            reason: live.reason,
            bestRawScore: decision.best,
            matchedArticleCount: decision.matched.length,
          });
          continue;
        }

        if (!dryRun && live?.created) {
          taskedThisRun.push(dedupeKey);
        }

        advanceCursor(handle, post.statusId);
        builder.recordPost({
          sourceUri: post.sourceUri,
          statusId: post.statusId,
          author,
          handle,
          outcome: "tasked",
          reason: live ? live.reason : decision.reason,
          bestRawScore: decision.best,
          matchedArticleCount: decision.matched.length,
          draftCount: decision.task.subtasks.length,
        });
        continue;
      }

      advanceCursor(handle, post.statusId);
      builder.recordPost({
        sourceUri: post.sourceUri,
        statusId: post.statusId,
        author,
        handle,
        outcome: "skipped",
        reason: decision.reason,
        bestRawScore: decision.best,
        matchedArticleCount: 0,
      });
    } catch (error) {
      const message = normalizeWhitespace(
        error instanceof Error ? error.message : String(error),
      );
      builder.recordPost({
        sourceUri: post.sourceUri,
        statusId: post.statusId,
        author,
        handle,
        outcome: "failed",
        reason: `post-processing-failed: ${message.slice(0, 220)}`,
      });
    }
  }

  if (deps.state) {
    if (rotationEnabled && deps.state.setRotationOffset) {
      const advanced = nextRotationOffset(
        params.watchlist.length,
        params.settings.defaultBatchSize,
        rotationOffset,
      );
      try {
        await deps.state.setRotationOffset(advanced);
      } catch (error) {
        logRuntime({
          level: "warn",
          message: "Failed to persist watchlist rotation offset.",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (taskedThisRun.length > 0) {
      try {
        await deps.state.markTasked(taskedThisRun);
      } catch (error) {
        logRuntime({
          level: "warn",
          message: "Failed to persist cross-run dedupe keys.",
          reason: error instanceof Error ? error.message : String(error),
          count: taskedThisRun.length,
        });
      }
    }
    for (const [handle, statusId] of maxStatusByHandle) {
      try {
        await deps.state.setPollingCursor(handle, statusId);
      } catch (error) {
        logRuntime({
          level: "warn",
          message: "Failed to persist polling cursor.",
          reason: error instanceof Error ? error.message : String(error),
          handle,
        });
      }
    }
  }

  return {
    summary: builder.build({ finishedAt: now().toISOString() }),
    tasks,
    organic,
  };
}

function compareStatusIds(a: string, b: string): number {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) {
    if (a.length !== b.length) return a.length - b.length;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
