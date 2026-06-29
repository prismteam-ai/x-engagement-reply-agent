import { resolve } from "node:path";
import { loadPromptBundle } from "@/config/load-prompts";
import { loadSettings, type Settings } from "@/config/load-settings";
import { loadActiveWatchlist } from "@/config/load-watchlist";
import {
  runMonitor,
  type InputPost,
  type RunMonitorDeps,
  type RunMonitorResult,
} from "@/pipeline/run-monitor";
import { createBedrockReplyModel } from "@/agent/bedrock-reply-model";
import { isBedrockConfigured } from "@/agent/model";
import { createAsanaTaskAdapter } from "@/asana/create-task";
import { isAsanaConfigured } from "@/asana/asana-client";
import {
  createReferencedFetcher,
  createXPoller,
  isXPollerConfigured,
} from "@/x/fetch-posts";
import {
  getAlreadyTasked,
  getPollingCursor,
  getRotationOffset,
  markTasked,
  setPollingCursor,
  setRotationOffset,
} from "@/state/agent-state";
import { isDynamoDbConfigured } from "@/state/ddb-client";
import { logRuntime } from "@/observability/logger";

export type RunFromConfigOptions = {
  dryRun?: boolean;
  authorHandle?: string;
  posts?: InputPost[];
  settings?: Settings;
  deps?: RunMonitorDeps;
  configRoot?: string;
  skipState?: boolean;
};

export async function runFromConfig(
  options: RunFromConfigOptions = {},
): Promise<RunMonitorResult> {
  const configRoot = options.configRoot ?? process.cwd();
  const settings =
    options.settings ?? loadSettings(resolve(configRoot, "config/settings.yaml"));
  let watchlist = loadActiveWatchlist(resolve(configRoot, "config/watchlist.yaml"));
  if (options.authorHandle) {
    const wanted = options.authorHandle.replace(/^@/, "").toLowerCase();
    const filtered = watchlist.filter((w) => w.handle.toLowerCase() === wanted);
    if (filtered.length > 0) watchlist = filtered;
  }
  const prompts = loadPromptBundle(resolve(configRoot, "prompts"));

  const dryRun = options.dryRun ?? true;
  const deps: RunMonitorDeps = { ...options.deps };

  if (!deps.model) {
    if (!isBedrockConfigured()) {
      throw new Error(
        "Bedrock is not configured (AWS_BEARER_TOKEN_BEDROCK + BEDROCK_MODEL_ID) — the reply model is required at runtime.",
      );
    }
    deps.model = createBedrockReplyModel();
  }

  const livePollerConfigured = isXPollerConfigured();
  if (!options.posts && !deps.fetchPosts && !livePollerConfigured) {
    throw new Error(
      "X poller is not configured (X_BEARER_TOKEN) and no posts were injected — the live poller is required at runtime.",
    );
  }

  if (!deps.fetchPosts && !options.posts && livePollerConfigured) {
    const useCursor = isDynamoDbConfigured() && !options.skipState;
    deps.fetchPosts = createXPoller(
      useCursor ? { getCursor: (handle) => getPollingCursor(handle) } : {},
    );
  }

  if (!deps.fetchReferenced && !options.posts && livePollerConfigured) {
    deps.fetchReferenced = createReferencedFetcher();
  }

  if (!deps.createAsanaTask && !dryRun && isAsanaConfigured()) {
    deps.createAsanaTask = createAsanaTaskAdapter({
      asanaTaskSimilarityThreshold: settings.asanaTaskSimilarityThreshold,
    });
  }

  const realRunNeedsState =
    !dryRun && !options.posts && !options.skipState && !deps.state;
  if (realRunNeedsState && !isDynamoDbConfigured()) {
    throw new Error(
      "DynamoDB is not configured (DYNAMODB_TABLE + IAM credentials) — a real run requires durable dedupe/cursor state to avoid re-creating Asana tasks every poll.",
    );
  }

  if (!deps.state && !options.skipState && isDynamoDbConfigured()) {
    deps.state = {
      getAlreadyTasked: (keys) => getAlreadyTasked(keys),
      markTasked: (keys) => markTasked(keys),
      setPollingCursor: (handle, statusId) => setPollingCursor(handle, statusId),
      getRotationOffset: () => getRotationOffset(),
      setRotationOffset: (offset) => setRotationOffset(offset),
    };
  } else if (!deps.state && !options.skipState && !isDynamoDbConfigured()) {
    logRuntime({
      level: "warn",
      message:
        "DynamoDB is not configured; watchlist rotation will not advance (offset stays 0).",
    });
  }

  return runMonitor({
    posts: options.posts ?? [],
    settings,
    watchlist,
    prompts,
    dryRun,
    deps,
  });
}
