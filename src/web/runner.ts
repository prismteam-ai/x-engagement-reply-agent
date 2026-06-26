import { loadConfig } from "../config/index.js";
import { buildDeps } from "../pipeline/build.js";
import { runMonitor } from "../pipeline/monitor.js";
import type { RunSummary } from "../domain/types.js";
import {
  RecordingAsanaClient,
  type CapturedParentTask,
  type CapturedSubtask,
} from "./recording-asana-client.js";

/**
 * Thin adapters between the verified pipeline contract and the HTTP layer. No
 * pipeline logic lives here — these only project the code-managed config for the
 * dashboard and run the pipeline (dry-run+fixture by default, or live) with a
 * recording Asana client so the generated reply drafts can be returned to the
 * browser. The recording client wraps whatever driver buildDeps produced, so the
 * same projection works for both no-write dry-runs and real Asana writes.
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

export interface RunOptions {
  /** Restrict the run to a single watched author handle. */
  onlyHandle?: string;
  /** X driver: committed fixtures (default) or live X polling. */
  driver?: "fixture" | "live";
  /** When true (default), the Asana delegate performs NO writes. */
  dryRun?: boolean;
}

/**
 * Run one pipeline pass. Defaults to dry-run + fixture (no writes, no creds).
 * `onlyHandle` isolates a single watched author. In dry-run the pipeline never
 * crashes on a missing LLM key; affected posts come back with outcome "failed",
 * which the dashboard surfaces rather than erroring.
 *
 * Live mode (driver="live" and/or dryRun=false) wires the real X driver and the
 * real AsanaApiClient. AsanaApiClient throws if ASANA_PERSONAL_ACCESS_TOKEN is
 * unset; that error propagates so the server can return a clean message.
 */
export async function runPipeline(opts: RunOptions = {}): Promise<RunResult> {
  const driver = opts.driver ?? "fixture";
  const dryRun = opts.dryRun ?? true;
  const deps = buildDeps({ dryRun, xDriver: driver });
  const rec = new RecordingAsanaClient(deps.asana);
  const summary = await runMonitor({ ...deps, asana: rec }, { onlyHandle: opts.onlyHandle });
  return { summary, parentTasks: rec.parentTasks, subtasks: rec.subtasks };
}
