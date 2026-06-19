import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { RunSummary } from "../domain/types.js";
import type { StateStore } from "./store.js";

/**
 * Local JSON-file StateStore for dev/demo. Single-file persistence is enough for
 * the demo's volume; production swaps in a DynamoDB driver behind StateStore.
 * Keeps a bounded history of run summaries.
 */
interface StateShape {
  cursors: Record<string, string>;
  batchOffset: number;
  processed: string[];
  tasked: string[];
  lastRunAt?: string;
  runs: RunSummary[];
}

const EMPTY: StateShape = {
  cursors: {},
  batchOffset: 0,
  processed: [],
  tasked: [],
  runs: [],
};

const MAX_RUN_HISTORY = 50;
const MAX_DEDUPE_KEYS = 5000;

export class FileStateStore implements StateStore {
  private state: StateShape;
  private readonly processedSet: Set<string>;
  private readonly taskedSet: Set<string>;

  constructor(private readonly path: string) {
    this.state = this.read();
    this.processedSet = new Set(this.state.processed);
    this.taskedSet = new Set(this.state.tasked);
  }

  private read(): StateShape {
    if (!existsSync(this.path)) return structuredClone(EMPTY);
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<StateShape>;
      return { ...structuredClone(EMPTY), ...parsed };
    } catch {
      return structuredClone(EMPTY);
    }
  }

  private flush(): void {
    this.state.processed = [...this.processedSet].slice(-MAX_DEDUPE_KEYS);
    this.state.tasked = [...this.taskedSet].slice(-MAX_DEDUPE_KEYS);
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.state, null, 2));
  }

  async getCursor(handle: string): Promise<string | undefined> {
    return this.state.cursors[handle.toLowerCase()];
  }

  async setCursor(handle: string, statusId: string): Promise<void> {
    this.state.cursors[handle.toLowerCase()] = statusId;
    this.flush();
  }

  async getBatchOffset(): Promise<number> {
    return this.state.batchOffset;
  }

  async setBatchOffset(offset: number): Promise<void> {
    this.state.batchOffset = offset;
    this.flush();
  }

  async isProcessed(dedupeKey: string): Promise<boolean> {
    return this.processedSet.has(dedupeKey);
  }

  async markProcessed(dedupeKey: string): Promise<void> {
    this.processedSet.add(dedupeKey);
    this.flush();
  }

  async isTasked(dedupeKey: string): Promise<boolean> {
    return this.taskedSet.has(dedupeKey);
  }

  async markTasked(dedupeKey: string): Promise<void> {
    this.taskedSet.add(dedupeKey);
    this.flush();
  }

  async getLastRunAt(): Promise<string | undefined> {
    return this.state.lastRunAt;
  }

  async appendRunSummary(summary: RunSummary): Promise<void> {
    this.state.lastRunAt = summary.finishedAt;
    this.state.runs.push(summary);
    if (this.state.runs.length > MAX_RUN_HISTORY) {
      this.state.runs = this.state.runs.slice(-MAX_RUN_HISTORY);
    }
    this.flush();
  }
}

/** In-memory StateStore for tests. */
export class MemoryStateStore implements StateStore {
  private cursors = new Map<string, string>();
  private offset = 0;
  private processed = new Set<string>();
  private tasked = new Set<string>();
  private lastRunAt?: string;
  public runs: RunSummary[] = [];

  async getCursor(handle: string) {
    return this.cursors.get(handle.toLowerCase());
  }
  async setCursor(handle: string, statusId: string) {
    this.cursors.set(handle.toLowerCase(), statusId);
  }
  async getBatchOffset() {
    return this.offset;
  }
  async setBatchOffset(offset: number) {
    this.offset = offset;
  }
  async isProcessed(k: string) {
    return this.processed.has(k);
  }
  async markProcessed(k: string) {
    this.processed.add(k);
  }
  async isTasked(k: string) {
    return this.tasked.has(k);
  }
  async markTasked(k: string) {
    this.tasked.add(k);
  }
  async getLastRunAt() {
    return this.lastRunAt;
  }
  async appendRunSummary(summary: RunSummary) {
    this.lastRunAt = summary.finishedAt;
    this.runs.push(summary);
  }
}
