import type { RunSummary } from "../domain/types.js";

/**
 * External runtime state: polling cursors, dedupe sets, batch rotation offset,
 * and run summaries. The pipeline depends only on this interface so the local
 * file driver can be swapped for DynamoDB in production without touching logic.
 */
export interface StateStore {
  getCursor(handle: string): Promise<string | undefined>;
  setCursor(handle: string, statusId: string): Promise<void>;

  getBatchOffset(): Promise<number>;
  setBatchOffset(offset: number): Promise<void>;

  isProcessed(dedupeKey: string): Promise<boolean>;
  markProcessed(dedupeKey: string): Promise<void>;

  isTasked(dedupeKey: string): Promise<boolean>;
  markTasked(dedupeKey: string): Promise<void>;

  getLastRunAt(): Promise<string | undefined>;
  appendRunSummary(summary: RunSummary): Promise<void>;
}
