import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import type { RunSummary } from "../domain/types.js";
import type { StateStore } from "./store.js";
import { createLogger, type Logger } from "../observability/logger.js";

/**
 * Production StateStore backed by a single DynamoDB table. Mirrors the local
 * FileStateStore semantics exactly so the pipeline is identical in dev and prod
 * (selected by the STATE_STORE env var — see ./factory.ts).
 *
 * Single-table design (matches infra/README.md and the CDK stack):
 *
 *   | pk                      | sk        | attributes              |
 *   |-------------------------|-----------|-------------------------|
 *   | CURSOR#<handle>         | -         | statusId                |
 *   | OFFSET                  | -         | batchOffset             |
 *   | PROCESSED#<dedupeKey>   | -         | ttl (epoch seconds)     |
 *   | TASKED#<dedupeKey>      | -         | ttl (epoch seconds)     |
 *   | RUN#<isoTimestamp>      | -         | summary (JSON)          |
 *   | META                    | LASTRUN   | lastRunAt               |
 *
 * Dedupe items carry a TTL so the table self-prunes; cursors/offset/last-run are
 * durable. All keys are partition-only lookups (sk is a constant), so every read
 * is a single GetItem and every write a single PutItem — no scans, no GSIs.
 */
const SK = "-";
const SECONDS_PER_DAY = 86_400;

export interface DynamoStateStoreOptions {
  tableName: string;
  /** Pre-built client (tests inject a mocked one; prod builds its own). */
  client?: DynamoDBDocumentClient;
  region?: string;
  /** Override the DynamoDB endpoint (e.g. http://localhost:8000 for DynamoDB Local). */
  endpoint?: string;
  /** TTL applied to processed/tasked dedupe keys. Default 90 days. */
  ttlDays?: number;
  logger?: Logger;
  /** Injected for deterministic tests; defaults to Date.now at runtime. */
  now?: () => number;
}

export class DynamoStateStore implements StateStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly table: string;
  private readonly ttlDays: number;
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(opts: DynamoStateStoreOptions) {
    this.table = opts.tableName;
    this.ttlDays = opts.ttlDays ?? 90;
    this.logger = opts.logger ?? createLogger("dynamo-state");
    this.now = opts.now ?? (() => Date.now());
    if (opts.client) {
      this.client = opts.client;
    } else {
      // DynamoDB Local accepts any credentials; supply dummies when an endpoint is
      // set and none are in the environment so the SDK doesn't fail to resolve them.
      const credentials =
        opts.endpoint && !process.env.AWS_ACCESS_KEY_ID
          ? { accessKeyId: "local", secretAccessKey: "local" }
          : undefined;
      const base = new DynamoDBClient({
        region: opts.region ?? process.env.AWS_REGION ?? "us-east-2",
        ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
        ...(credentials ? { credentials } : {}),
      });
      this.client = DynamoDBDocumentClient.from(base, {
        marshallOptions: { removeUndefinedValues: true },
      });
    }
  }

  private async get(pk: string, sk: string = SK): Promise<Record<string, unknown> | undefined> {
    const res = await this.client.send(
      new GetCommand({ TableName: this.table, Key: { pk, sk } }),
    );
    return res.Item;
  }

  private async put(item: Record<string, unknown>): Promise<void> {
    await this.client.send(new PutCommand({ TableName: this.table, Item: { sk: SK, ...item } }));
  }

  private ttl(): number {
    return Math.floor(this.now() / 1000) + this.ttlDays * SECONDS_PER_DAY;
  }

  async getCursor(handle: string): Promise<string | undefined> {
    const item = await this.get(`CURSOR#${handle.toLowerCase()}`);
    return item?.statusId as string | undefined;
  }

  async setCursor(handle: string, statusId: string): Promise<void> {
    await this.put({ pk: `CURSOR#${handle.toLowerCase()}`, statusId });
  }

  async getBatchOffset(): Promise<number> {
    const item = await this.get("OFFSET");
    return (item?.batchOffset as number | undefined) ?? 0;
  }

  async setBatchOffset(offset: number): Promise<void> {
    await this.put({ pk: "OFFSET", batchOffset: offset });
  }

  async isProcessed(dedupeKey: string): Promise<boolean> {
    return Boolean(await this.get(`PROCESSED#${dedupeKey}`));
  }

  async markProcessed(dedupeKey: string): Promise<void> {
    await this.put({ pk: `PROCESSED#${dedupeKey}`, ttl: this.ttl() });
  }

  async isTasked(dedupeKey: string): Promise<boolean> {
    return Boolean(await this.get(`TASKED#${dedupeKey}`));
  }

  async markTasked(dedupeKey: string): Promise<void> {
    await this.put({ pk: `TASKED#${dedupeKey}`, ttl: this.ttl() });
  }

  async getLastRunAt(): Promise<string | undefined> {
    const item = await this.get("META", "LASTRUN");
    return item?.lastRunAt as string | undefined;
  }

  async appendRunSummary(summary: RunSummary): Promise<void> {
    // Persist the full run for history, and a small pointer for getLastRunAt().
    // Run history items carry a TTL so the table self-prunes over time.
    await this.put({ pk: `RUN#${summary.finishedAt}`, summary, ttl: this.ttl() });
    await this.client.send(
      new PutCommand({
        TableName: this.table,
        Item: { pk: "META", sk: "LASTRUN", lastRunAt: summary.finishedAt },
      }),
    );
  }
}
