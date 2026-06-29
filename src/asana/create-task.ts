import type { CreateAsanaTaskResult, WouldBeTask } from "@/pipeline/run-monitor";
import {
  clampAsanaTaskSimilarityThreshold,
  meetsAsanaTaskThreshold,
  normalizeVectorScoreTo100,
} from "@/matching/article-similarity";
import { buildPostDedupeKey } from "@/x/parse-post";
import { logRuntime } from "@/observability/logger";
import { resolvePositiveIntEnv, runWithRetry } from "@/agent/retry";
import {
  createAsanaRestClient,
  resolveAsanaConfig,
  type AsanaClient,
  type AsanaConfig,
  type RuntimeEnv,
} from "@/asana/asana-client";

export type CreateAsanaTaskAdapterOptions = {
  client?: AsanaClient;
  config?: AsanaConfig;
  env?: RuntimeEnv;
  asanaTaskSimilarityThreshold?: number;
  now?: () => Date;
};

export function formatDueOn(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function buildSimilarityCustomFields(params: {
  rawScore: number | null | undefined;
  rawFieldGid?: string;
  normalizedFieldGid?: string;
}): Record<string, number> | undefined {
  const { rawScore, rawFieldGid, normalizedFieldGid } = params;
  if (rawScore === null || rawScore === undefined || !Number.isFinite(rawScore)) {
    return undefined;
  }
  const fields: Record<string, number> = {};
  if (rawFieldGid) fields[rawFieldGid] = Number(rawScore.toFixed(4));
  if (normalizedFieldGid) fields[normalizedFieldGid] = normalizeVectorScoreTo100(rawScore);
  return Object.keys(fields).length > 0 ? fields : undefined;
}

function readGid(value: unknown): string | undefined {
  if (value && typeof value === "object" && typeof (value as { gid?: unknown }).gid === "string") {
    return (value as { gid: string }).gid;
  }
  return undefined;
}

function readPermalink(value: unknown): string | undefined {
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { permalink_url?: unknown }).permalink_url === "string"
  ) {
    return (value as { permalink_url: string }).permalink_url;
  }
  return undefined;
}

export const DEFAULT_ASANA_MAX_RETRIES = 3;
export const DEFAULT_ASANA_REQUEST_TIMEOUT_MS = 20_000;

export function resolveAsanaMaxRetries(env: RuntimeEnv = process.env): number {
  return resolvePositiveIntEnv(env, "ASANA_MAX_RETRIES", DEFAULT_ASANA_MAX_RETRIES, { minimum: 0 });
}

export function resolveAsanaTimeoutMs(env: RuntimeEnv = process.env): number {
  return resolvePositiveIntEnv(env, "ASANA_REQUEST_TIMEOUT_MS", DEFAULT_ASANA_REQUEST_TIMEOUT_MS);
}

export function createAsanaTaskAdapter(
  options: CreateAsanaTaskAdapterOptions = {},
): (task: WouldBeTask) => Promise<CreateAsanaTaskResult> {
  const env = options.env ?? process.env;
  const config = options.config ?? resolveAsanaConfig(env);
  const client = options.client ?? createAsanaRestClient({ accessToken: config.accessToken });
  const now = options.now ?? (() => new Date());
  const maxRetries = resolveAsanaMaxRetries(env);
  const timeoutMs = resolveAsanaTimeoutMs(env);
  const retryOptions = { maxRetries, timeoutMs };
  const threshold = clampAsanaTaskSimilarityThreshold(
    options.asanaTaskSimilarityThreshold ?? 0,
  );

  const tasked = new Set<string>();

  return async (task: WouldBeTask): Promise<CreateAsanaTaskResult> => {
    const dedupeKey = buildPostDedupeKey({
      sourceUri: task.sourceUri,
      statusId: task.statusId,
    });
    if (tasked.has(dedupeKey)) {
      return { created: false, reason: "already-tasked" };
    }

    const meetsThreshold = meetsAsanaTaskThreshold(task.bestRawScore, threshold);
    const assignee =
      meetsThreshold && config.thresholdAssigneeGid
        ? config.thresholdAssigneeGid
        : config.defaultAssigneeGid;
    const dueOn = meetsThreshold ? formatDueOn(now()) : undefined;

    const parentCustomFields = buildSimilarityCustomFields({
      rawScore: task.bestRawScore,
      ...(config.rawSimilarityFieldGid ? { rawFieldGid: config.rawSimilarityFieldGid } : {}),
      ...(config.normalizedSimilarityFieldGid
        ? { normalizedFieldGid: config.normalizedSimilarityFieldGid }
        : {}),
    });

    let parentGid: string | undefined;
    let parentUrl: string | undefined;
    try {
      if (parentCustomFields) {
        const created = await runWithRetry(
          () =>
            client.transport.post("/tasks", {
              body: {
                name: task.name,
                notes: task.notes,
                workspace: config.workspaceGid,
                projects: [config.projectGid],
                ...(assignee ? { assignee } : {}),
                ...(dueOn ? { due_on: dueOn } : {}),
                custom_fields: parentCustomFields,
              },
            }),
          retryOptions,
        );
        const data = (created as { data?: unknown })?.data;
        parentGid = readGid(data);
        parentUrl = readPermalink(data);
      } else {
        const parent = await runWithRetry(
          () =>
            client.tasks.create({
              name: task.name,
              notes: task.notes,
              workspace: config.workspaceGid,
              projects: [config.projectGid],
              ...(assignee ? { assignee } : {}),
              ...(dueOn ? { due_on: dueOn } : {}),
            }),
          retryOptions,
        );
        parentGid = readGid(parent);
        parentUrl = readPermalink(parent);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logRuntime({
        level: "error",
        message: "Asana parent task creation failed.",
        statusId: task.statusId,
        reason: message.slice(0, 220),
      });
      return { created: false, reason: `asana-create-failed: ${message.slice(0, 180)}` };
    }

    if (!parentGid) {
      return { created: false, reason: "asana-create-failed: no parent gid in response" };
    }

    tasked.add(dedupeKey);

    if (config.sectionGid) {
      try {
        await runWithRetry(
          () =>
            client.transport.post(`/sections/${config.sectionGid}/addTask`, {
              body: { task: parentGid },
            }),
          retryOptions,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logRuntime({
          level: "warn",
          message: "Asana section add failed; task created, placement skipped.",
          parentGid,
          sectionGid: config.sectionGid,
          reason: message.slice(0, 200),
        });
      }
    }

    const subtaskRawByIndex = new Map<number, number>();
    for (const rec of task.recommendations) {
      for (const resp of rec.suggestedResponses ?? []) {
        if (!subtaskRawByIndex.has(resp.promptIndex)) {
          subtaskRawByIndex.set(resp.promptIndex, rec.rawScore);
        }
      }
    }

    const subtaskGids: string[] = [];
    for (const subtask of task.subtasks) {
      const subtaskCustomFields = buildSimilarityCustomFields({
        rawScore: subtaskRawByIndex.get(subtask.promptIndex) ?? task.bestRawScore,
        ...(config.rawSimilarityFieldGid ? { rawFieldGid: config.rawSimilarityFieldGid } : {}),
        ...(config.normalizedSimilarityFieldGid
          ? { normalizedFieldGid: config.normalizedSimilarityFieldGid }
          : {}),
      });
      try {
        const created = await runWithRetry(
          () =>
            client.transport.post(`/tasks/${parentGid}/subtasks`, {
              body: {
                name: subtask.promptLabel,
                notes: subtask.notes,
                ...(assignee ? { assignee } : {}),
                ...(dueOn ? { due_on: dueOn } : {}),
                ...(subtaskCustomFields ? { custom_fields: subtaskCustomFields } : {}),
              },
            }),
          retryOptions,
        );
        const gid = readGid((created as { data?: unknown })?.data);
        if (gid) subtaskGids.push(gid);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logRuntime({
          level: "warn",
          message: "Asana subtask creation failed; continuing.",
          parentGid,
          promptLabel: subtask.promptLabel,
          reason: message.slice(0, 200),
        });
      }
    }

    return {
      created: true,
      reason: "created",
      parentGid,
      ...(parentUrl ? { parentUrl } : {}),
      subtaskGids,
    };
  };
}
