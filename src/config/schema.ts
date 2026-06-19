import { z } from "zod";

/**
 * Zod schemas for code-managed configuration. These replace the investors-mcp
 * Postgres `managed_authors` / `automation_settings` tables and admin-UI prompt
 * slots with version-controlled files validated at startup.
 */

export const aliasesSchema = z
  .object({
    handles: z.array(z.string()).default([]),
    authors: z.array(z.string()).default([]),
  })
  .default({ handles: [], authors: [] });

export const watchedAuthorSchema = z.object({
  author: z.string().min(1),
  handle: z.string().min(1),
  company: z.string().default(""),
  aliases: aliasesSchema,
  active: z.boolean().default(true),
  /** When true, the author's own posts are not tasked (e.g. the corpus author). */
  excludeFromTasking: z.boolean().default(false),
});

export const watchlistSchema = z.object({
  authors: z.array(watchedAuthorSchema).min(1),
});

/** Asana routing config; ids are environment-specific Asana GIDs. */
export const asanaConfigSchema = z.object({
  workspace: z.string().optional(),
  project: z.string().optional(),
  section: z.string().optional(),
  defaultAssignee: z.string().optional(),
  /** When best-match raw similarity >= this, assign to thresholdAssignee + due today. */
  thresholdAssigneeRawScore: z.number().min(0).max(1).default(1),
  thresholdAssignee: z.string().optional(),
  /** Optional custom field GIDs to write the similarity score onto. */
  parentSimilarityFieldId: z.string().optional(),
  subtaskSimilarityFieldId: z.string().optional(),
});

export const settingsSchema = z.object({
  pollIntervalMinutes: z.number().positive().default(2),
  defaultBatchSize: z.number().int().positive().default(5),
  defaultMaxPostsPerAuthor: z.number().int().positive().default(20),
  /** topK passed to investors-mcp queryInvestorContent. Hard-capped at 20 by the server. */
  defaultTopK: z.number().int().min(1).max(20).default(6),
  /** Best-match raw similarity gate for creating the parent Asana task (0 = always). */
  asanaTaskSimilarityThreshold: z.number().min(0).max(1).default(0),
  /** Per-article raw similarity gate for creating recommendation subtasks. */
  articleSimilarityThreshold: z.number().min(0).max(1).default(0.7),
  /** Max matched articles (best first) that generate reply subtasks per post. */
  maxArticlesPerPost: z.number().int().positive().default(1),
  /** Provider-agnostic model id, e.g. "openai/gpt-4.1-mini" or "bedrock/<model-id>". */
  modelId: z.string().default("openai/gpt-4.1-mini"),
  asana: asanaConfigSchema.default({}),
});

export type WatchedAuthor = z.infer<typeof watchedAuthorSchema>;
export type Watchlist = z.infer<typeof watchlistSchema>;
export type AsanaConfig = z.infer<typeof asanaConfigSchema>;
export type Settings = z.infer<typeof settingsSchema>;
