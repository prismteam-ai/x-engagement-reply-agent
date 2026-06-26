import { describe, it, expect, beforeAll } from "vitest";
import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
  ResourceNotFoundException,
  waitUntilTableExists,
  waitUntilTableNotExists,
} from "@aws-sdk/client-dynamodb";
import { DynamoStateStore } from "../src/state/dynamo-store.js";
import type { RunSummary } from "../src/domain/types.js";

/**
 * Real DynamoDB Local integration — prefers a live container over mocks per the
 * testing standard. Skipped unless DYNAMODB_ENDPOINT is set, so CI without Docker
 * still passes. To run:
 *
 *   docker compose up -d
 *   DYNAMODB_ENDPOINT=http://localhost:8000 pnpm test
 */
const endpoint = process.env.DYNAMODB_ENDPOINT;
const TABLE = "AgentStateIntegrationTest";

const run = endpoint ? describe : describe.skip;

run("DynamoStateStore against DynamoDB Local", () => {
  beforeAll(async () => {
    const client = new DynamoDBClient({
      region: "us-east-2",
      endpoint,
      credentials: { accessKeyId: "local", secretAccessKey: "local" },
    });
    // Start from a clean table each run so assertions are isolated from the
    // persistent DynamoDB Local volume.
    try {
      await client.send(new DeleteTableCommand({ TableName: TABLE }));
      await waitUntilTableNotExists({ client, maxWaitTime: 30 }, { TableName: TABLE });
    } catch (err) {
      if (!(err instanceof ResourceNotFoundException)) throw err;
    }
    await client.send(
      new CreateTableCommand({
        TableName: TABLE,
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        BillingMode: "PAY_PER_REQUEST",
      }),
    );
    await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: TABLE });
  }, 40_000);

  function store() {
    return new DynamoStateStore({ tableName: TABLE, endpoint, region: "us-east-2" });
  }

  it("round-trips a cursor", async () => {
    const s = store();
    expect(await s.getCursor("balajis")).toBeUndefined();
    await s.setCursor("Balajis", "1990000000000000001");
    expect(await s.getCursor("balajis")).toBe("1990000000000000001");
  });

  it("round-trips the batch offset", async () => {
    const s = store();
    await s.setBatchOffset(4);
    expect(await s.getBatchOffset()).toBe(4);
  });

  it("tracks processed and tasked dedupe keys independently", async () => {
    const s = store();
    const key = "https://x.com/balajis/status/1::1";
    expect(await s.isProcessed(key)).toBe(false);
    expect(await s.isTasked(key)).toBe(false);
    await s.markProcessed(key);
    expect(await s.isProcessed(key)).toBe(true);
    expect(await s.isTasked(key)).toBe(false);
    await s.markTasked(key);
    expect(await s.isTasked(key)).toBe(true);
  });

  it("persists run summaries and the last-run pointer", async () => {
    const s = store();
    const summary = {
      startedAt: "2026-06-19T00:00:00.000Z",
      finishedAt: "2026-06-19T00:00:05.000Z",
      dryRun: false,
      authorsPolled: 2,
      postsFetched: 3,
      newPostsProcessed: 3,
      ingested: 0,
      parentTasksCreated: 1,
      subtasksCreated: 5,
      skipped: 1,
      failed: 0,
      results: [],
    } satisfies RunSummary;
    await s.appendRunSummary(summary);
    expect(await s.getLastRunAt()).toBe("2026-06-19T00:00:05.000Z");
  });
});
