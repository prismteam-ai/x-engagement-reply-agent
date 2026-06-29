import {
  DEFAULT_KEY_PREFIX,
  DynamoDbStateStore,
  isDynamoDbConfigured,
  createDynamoDbStateStore,
  type RuntimeEnv,
} from "@/state/ddb-client";
import {
  readCursorFromFile,
  readLatestRunFromFile,
  readShowcaseRunFromFile,
  readTaskedFromFile,
  saveLatestRunToFile,
  saveShowcaseRunToFile,
  writeCursorToFile,
  writeTaskedToFile,
  readRotationOffsetFromFile,
  writeRotationOffsetToFile,
  type StoredRun,
} from "@/state/file-store";
import { logRuntime } from "@/observability/logger";
import type { RunMonitorResult } from "@/pipeline/run-monitor";

export type { StoredRun };

const LATEST_RUN_KEY = "run:latest";
const SHOWCASE_RUN_KEY = "run:showcase";
const cursorKey = (handle: string): string => `cursor:${handle}`;
const taskedKey = (dedupeKey: string): string => `dedupe:tasked:${dedupeKey}`;
const rotationOffsetKey = (): string => "rotation:offset";
const DEDUPE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type StateBackend = {
  readonly kind: "dynamodb" | "file";
  saveLatestRun(result: RunMonitorResult, savedAt: string): Promise<StoredRun>;
  readLatestRun(): Promise<StoredRun | null>;
  saveShowcaseRun(result: RunMonitorResult, savedAt: string): Promise<StoredRun>;
  readShowcaseRun(): Promise<StoredRun | null>;
  readCursor(handle: string): Promise<string | null>;
  writeCursor(handle: string, statusId: string): Promise<void>;
  readTasked(keys: string[]): Promise<Set<string>>;
  markTasked(keys: string[]): Promise<void>;
  readRotationOffset(): Promise<number | null>;
  writeRotationOffset(offset: number): Promise<void>;
};

function createFileBackend(): StateBackend {
  return {
    kind: "file",
    async saveLatestRun(result, savedAt) {
      return saveLatestRunToFile(result, savedAt);
    },
    async readLatestRun() {
      return readLatestRunFromFile();
    },
    async saveShowcaseRun(result, savedAt) {
      return saveShowcaseRunToFile(result, savedAt);
    },
    async readShowcaseRun() {
      return readShowcaseRunFromFile();
    },
    async readCursor(handle) {
      return readCursorFromFile(handle);
    },
    async writeCursor(handle, statusId) {
      writeCursorToFile(handle, statusId);
    },
    async readTasked(keys) {
      return readTaskedFromFile(keys);
    },
    async markTasked(keys) {
      writeTaskedToFile(keys);
    },
    async readRotationOffset() {
      return readRotationOffsetFromFile();
    },
    async writeRotationOffset(offset) {
      writeRotationOffsetToFile(offset);
    },
  };
}

function createDynamoBackend(store: DynamoDbStateStore): StateBackend {
  return {
    kind: "dynamodb",
    async saveLatestRun(result, savedAt) {
      const payload: StoredRun = { ...result, savedAt };
      await store.set(LATEST_RUN_KEY, payload);
      return payload;
    },
    async readLatestRun() {
      return store.get<StoredRun>(LATEST_RUN_KEY);
    },
    async saveShowcaseRun(result, savedAt) {
      const payload: StoredRun = { ...result, savedAt };
      await store.set(SHOWCASE_RUN_KEY, payload);
      return payload;
    },
    async readShowcaseRun() {
      return store.get<StoredRun>(SHOWCASE_RUN_KEY);
    },
    async readCursor(handle) {
      return store.get<string>(cursorKey(handle));
    },
    async writeCursor(handle, statusId) {
      await store.set<string>(cursorKey(handle), statusId);
    },
    async readTasked(keys) {
      if (keys.length === 0) return new Set();
      const present = await Promise.all(
        keys.map(async (k) => ((await store.get<string>(taskedKey(k))) ? k : null)),
      );
      return new Set(present.filter((k): k is string => k !== null));
    },
    async markTasked(keys) {
      await Promise.all(
        keys.map((k) => store.set<string>(taskedKey(k), k, DEDUPE_TTL_MS)),
      );
    },
    async readRotationOffset() {
      return store.get<number>(rotationOffsetKey());
    },
    async writeRotationOffset(offset) {
      await store.set<number>(rotationOffsetKey(), offset);
    },
  };
}

let cachedBackend: StateBackend | null = null;
let loggedSelection = false;

export function getStateBackend(options?: {
  env?: RuntimeEnv;
  store?: DynamoDbStateStore;
}): StateBackend {
  if (options?.store) {
    return createDynamoBackend(options.store);
  }
  if (options?.env) {
    return isDynamoDbConfigured(options.env)
      ? createDynamoBackend(createDynamoDbStateStore(options.env))
      : createFileBackend();
  }
  if (cachedBackend) return cachedBackend;

  if (!isDynamoDbConfigured()) {
    throw new Error(
      "DynamoDB is not configured (DYNAMODB_TABLE + IAM credentials) — the runtime state store requires DynamoDB.",
    );
  }
  cachedBackend = createDynamoBackend(createDynamoDbStateStore());
  if (!loggedSelection) {
    loggedSelection = true;
    logRuntime({
      level: "info",
      message: "Agent state backend selected.",
      backend: cachedBackend.kind,
      keyPrefix: DEFAULT_KEY_PREFIX,
    });
  }
  return cachedBackend;
}

export function resetStateBackendCache(): void {
  cachedBackend = null;
  loggedSelection = false;
}

export async function saveLatestRun(
  result: RunMonitorResult,
  backend: StateBackend = getStateBackend(),
): Promise<StoredRun> {
  return backend.saveLatestRun(toShowcaseHeadline(result), new Date().toISOString());
}

export async function readLatestRun(
  backend: StateBackend = getStateBackend(),
): Promise<StoredRun | null> {
  return backend.readLatestRun();
}

export function isShowcaseWorthy(result: RunMonitorResult): boolean {
  return (
    result.organic !== false &&
    result.summary.dryRun === false &&
    result.tasks.length > 0
  );
}

const SHOWCASE_MAX_SUBTASKS = 8;

function trimHeadlineTask(
  task: RunMonitorResult["tasks"][number],
): RunMonitorResult["tasks"][number] {
  if (task.subtasks.length <= SHOWCASE_MAX_SUBTASKS) return task;
  return { ...task, subtasks: task.subtasks.slice(0, SHOWCASE_MAX_SUBTASKS) };
}

function pickHeadlineTask(
  tasks: RunMonitorResult["tasks"],
): RunMonitorResult["tasks"][number] {
  const rank = (t: RunMonitorResult["tasks"][number]): [number, number, number] => [
    t.bestRawScore ?? -1,
    t.recommendations.length,
    t.subtasks.length,
  ];
  return tasks.reduce((a, b) => {
    const [as, ar, asub] = rank(a);
    const [bs, br, bsub] = rank(b);
    if (bs !== as) return bs > as ? b : a;
    if (br !== ar) return br > ar ? b : a;
    return bsub > asub ? b : a;
  });
}

export function toShowcaseHeadline(result: RunMonitorResult): RunMonitorResult {
  if (result.tasks.length === 0) return result;
  const best = trimHeadlineTask(pickHeadlineTask(result.tasks));
  const wasDry = result.summary.dryRun;
  const headlinePost = result.summary.posts.find(
    (p) => p.statusId === best.statusId && p.sourceUri === best.sourceUri,
  );
  return {
    organic: result.organic,
    tasks: [best],
    summary: {
      ...result.summary,
      counts: {
        ...result.summary.counts,
        postsFetched: 1,
        newPosts: 1,
        matched: 1,
        tasksWouldCreate: wasDry ? 1 : 0,
        tasksCreated: wasDry ? 0 : 1,
        skipped: 0,
        failures: 0,
        skipReasons: {},
      },
      posts: headlinePost ? [headlinePost] : [],
    },
  };
}

export async function saveShowcaseRun(
  result: RunMonitorResult,
  backend: StateBackend = getStateBackend(),
): Promise<StoredRun | null> {
  if (!isShowcaseWorthy(result)) {
    return backend.readShowcaseRun();
  }
  return backend.saveShowcaseRun(toShowcaseHeadline(result), new Date().toISOString());
}

export async function readShowcaseRun(
  backend: StateBackend = getStateBackend(),
): Promise<StoredRun | null> {
  return backend.readShowcaseRun();
}

export function normalizeHandle(handle: string): string {
  return String(handle ?? "").replace(/^@/, "").trim().toLowerCase();
}

export async function getPollingCursor(
  handle: string,
  backend: StateBackend = getStateBackend(),
): Promise<string | null> {
  const key = normalizeHandle(handle);
  if (!key) return null;
  return backend.readCursor(key);
}

export async function setPollingCursor(
  handle: string,
  statusId: string,
  backend: StateBackend = getStateBackend(),
): Promise<void> {
  const key = normalizeHandle(handle);
  const id = String(statusId ?? "").trim();
  if (!key || !id) return;
  await backend.writeCursor(key, id);
}

export async function getRotationOffset(
  backend: StateBackend = getStateBackend(),
): Promise<number> {
  const stored = await backend.readRotationOffset();
  return typeof stored === "number" && Number.isFinite(stored)
    ? Math.max(0, Math.trunc(stored))
    : 0;
}

export async function setRotationOffset(
  offset: number,
  backend: StateBackend = getStateBackend(),
): Promise<void> {
  if (!Number.isFinite(offset)) return;
  await backend.writeRotationOffset(Math.max(0, Math.trunc(offset)));
}

export async function getAlreadyTasked(
  keys: string[],
  backend: StateBackend = getStateBackend(),
): Promise<Set<string>> {
  const clean = keys.filter((k) => Boolean(k));
  if (clean.length === 0) return new Set();
  return backend.readTasked(clean);
}

export async function markTasked(
  keys: string[],
  backend: StateBackend = getStateBackend(),
): Promise<void> {
  const clean = Array.from(new Set(keys.filter((k) => Boolean(k))));
  if (clean.length === 0) return;
  await backend.markTasked(clean);
}
