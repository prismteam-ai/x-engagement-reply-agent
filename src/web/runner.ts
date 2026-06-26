import { loadConfig } from "../config/index.js";
import { buildDeps } from "../pipeline/build.js";
import { runMonitor } from "../pipeline/monitor.js";
import type { RunSummary } from "../domain/types.js";
import {
  CapturingAsanaClient,
  type CapturedParentTask,
  type CapturedSubtask,
} from "./capturing-asana-client.js";

/**
 * Thin adapters between the verified pipeline contract and the HTTP layer. No
 * pipeline logic lives here — these only project the code-managed config for the
 * dashboard and run the dry-run / fixture pipeline with a capturing Asana client
 * so the generated reply drafts can be returned to the browser.
 */

export interface ConfigView {
  modelId: string;
  thresholds: {
    asanaTaskSimilarityThreshold: number;
    articleSimilarityThreshold: number;
  };
  pollIntervalMinutes: number;
  defaultBatchSize: number;
  defaultTopK: number;
  maxArticlesPerPost: number;
  authors: Array<{
    name: string;
    handle: string;
    company: string;
    active: boolean;
    excludeFromTasking: boolean;
  }>;
  replyPrompts: Array<{
    index: number;
    label: string;
    file: string;
    title: string;
    text: string;
  }>;
}

export interface RunResult {
  summary: RunSummary;
  parentTasks: CapturedParentTask[];
  subtasks: CapturedSubtask[];
}

/** Project the code-managed config into the shape the dashboard renders. */
export function loadConfigView(): ConfigView {
  const { settings, watchlist, prompts } = loadConfig();
  return {
    modelId: settings.modelId,
    thresholds: {
      asanaTaskSimilarityThreshold: settings.asanaTaskSimilarityThreshold,
      articleSimilarityThreshold: settings.articleSimilarityThreshold,
    },
    pollIntervalMinutes: settings.pollIntervalMinutes,
    defaultBatchSize: settings.defaultBatchSize,
    defaultTopK: settings.defaultTopK,
    maxArticlesPerPost: settings.maxArticlesPerPost,
    authors: watchlist.authors.map((a) => ({
      name: a.author,
      handle: a.handle,
      company: a.company,
      active: a.active,
      excludeFromTasking: a.excludeFromTasking,
    })),
    replyPrompts: prompts.replies.map((r) => ({
      index: r.index,
      label: r.label,
      file: r.file,
      title: r.title,
      text: r.text,
    })),
  };
}

/**
 * Run one dry-run / fixture pass. `onlyHandle` isolates a single watched author.
 * The pipeline never crashes on a missing LLM key; affected posts come back with
 * outcome "failed", which the dashboard surfaces rather than erroring.
 */
export async function runPipeline(onlyHandle?: string): Promise<RunResult> {
  const deps = buildDeps({ dryRun: true, xDriver: "fixture" });
  const capture = new CapturingAsanaClient();
  const summary = await runMonitor({ ...deps, asana: capture }, { onlyHandle });
  return { summary, parentTasks: capture.parentTasks, subtasks: capture.subtasks };
}
