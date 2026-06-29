import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { RunMonitorResult } from "@/pipeline/run-monitor";

export const DEFAULT_RUN_STORE_PATH = resolve(process.cwd(), ".data", "latest-run.json");

export const DEFAULT_SHOWCASE_STORE_PATH = resolve(process.cwd(), ".data", "showcase-run.json");

export const DEFAULT_STATE_STORE_PATH = resolve(process.cwd(), ".data", "agent-state.json");

export type StoredRun = RunMonitorResult & { savedAt: string };

type AgentStateFile = {
  cursors: Record<string, string>;
  tasked: Record<string, true>;
  rotationOffset: number;
};

function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

function readState(path: string): AgentStateFile {
  const parsed = readJsonFile<Partial<AgentStateFile>>(path);
  return {
    cursors: parsed?.cursors ?? {},
    tasked: parsed?.tasked ?? {},
    rotationOffset: parsed?.rotationOffset ?? 0,
  };
}

export function saveLatestRunToFile(
  result: RunMonitorResult,
  savedAt: string,
  path: string = DEFAULT_RUN_STORE_PATH,
): StoredRun {
  const payload: StoredRun = { ...result, savedAt };
  writeJsonFile(path, payload);
  return payload;
}

export function readLatestRunFromFile(path: string = DEFAULT_RUN_STORE_PATH): StoredRun | null {
  return readJsonFile<StoredRun>(path);
}

export function saveShowcaseRunToFile(
  result: RunMonitorResult,
  savedAt: string,
  path: string = DEFAULT_SHOWCASE_STORE_PATH,
): StoredRun {
  const payload: StoredRun = { ...result, savedAt };
  writeJsonFile(path, payload);
  return payload;
}

export function readShowcaseRunFromFile(
  path: string = DEFAULT_SHOWCASE_STORE_PATH,
): StoredRun | null {
  return readJsonFile<StoredRun>(path);
}

export function readCursorFromFile(
  handle: string,
  path: string = DEFAULT_STATE_STORE_PATH,
): string | null {
  const state = readState(path);
  return state.cursors[handle] ?? null;
}

export function writeCursorToFile(
  handle: string,
  statusId: string,
  path: string = DEFAULT_STATE_STORE_PATH,
): void {
  const state = readState(path);
  state.cursors[handle] = statusId;
  writeJsonFile(path, state);
}

export function readRotationOffsetFromFile(
  path: string = DEFAULT_STATE_STORE_PATH,
): number | null {
  const state = readState(path);
  return typeof state.rotationOffset === "number" ? state.rotationOffset : null;
}

export function writeRotationOffsetToFile(
  offset: number,
  path: string = DEFAULT_STATE_STORE_PATH,
): void {
  const state = readState(path);
  state.rotationOffset = offset;
  writeJsonFile(path, state);
}

export function readTaskedFromFile(
  keys: string[],
  path: string = DEFAULT_STATE_STORE_PATH,
): Set<string> {
  const state = readState(path);
  return new Set(keys.filter((k) => state.tasked[k]));
}

export function writeTaskedToFile(
  keys: string[],
  path: string = DEFAULT_STATE_STORE_PATH,
): void {
  if (keys.length === 0) return;
  const state = readState(path);
  for (const k of keys) state.tasked[k] = true;
  writeJsonFile(path, state);
}
