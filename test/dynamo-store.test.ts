import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { DynamoStateStore } from "../src/state/dynamo-store.js";
import type { RunSummary } from "../src/domain/types.js";

const ddbMock = mockClient(DynamoDBDocumentClient);
const TABLE = "AgentState";
const FIXED_NOW = 1_700_000_000_000; // fixed clock for deterministic TTLs

function store() {
  // No client passed — the store builds its own DocumentClient, whose `send` the
  // aws-sdk-client-mock prototype patch intercepts.
  return new DynamoStateStore({ tableName: TABLE, region: "us-east-2", now: () => FIXED_NOW });
}

/** Find the single PutCommand whose Item.pk matches. */
function putWithPk(pk: string) {
  return ddbMock
    .commandCalls(PutCommand)
    .map((c) => c.args[0].input)
    .find((i) => (i.Item as Record<string, unknown>).pk === pk);
}

describe("DynamoStateStore", () => {
  beforeEach(() => ddbMock.reset());

  it("reads a cursor (lowercased handle) via GetItem", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { pk: "CURSOR#balajis", sk: "-", statusId: "123" } });
    const s = store();
    expect(await s.getCursor("BalajiS")).toBe("123");

    const key = ddbMock.commandCalls(GetCommand)[0]!.args[0].input.Key;
    expect(key).toEqual({ pk: "CURSOR#balajis", sk: "-" });
  });

  it("returns undefined when a cursor is absent", async () => {
    ddbMock.on(GetCommand).resolves({});
    expect(await store().getCursor("nobody")).toBeUndefined();
  });

  it("writes a cursor with the constant sort key", async () => {
    ddbMock.on(PutCommand).resolves({});
    await store().setCursor("Balajis", "999");
    expect(putWithPk("CURSOR#balajis")!.Item).toMatchObject({ pk: "CURSOR#balajis", sk: "-", statusId: "999" });
  });

  it("defaults batch offset to 0 when missing and round-trips a value", async () => {
    ddbMock.on(GetCommand).resolves({});
    expect(await store().getBatchOffset()).toBe(0);

    ddbMock.on(PutCommand).resolves({});
    await store().setBatchOffset(3);
    expect(putWithPk("OFFSET")!.Item).toMatchObject({ pk: "OFFSET", batchOffset: 3 });
  });

  it("marks and detects processed keys with a TTL", async () => {
    ddbMock.on(PutCommand).resolves({});
    await store().markProcessed("uri::100");
    const item = putWithPk("PROCESSED#uri::100")!.Item as Record<string, unknown>;
    // 90 days past the fixed clock, in epoch seconds
    expect(item.ttl).toBe(Math.floor(FIXED_NOW / 1000) + 90 * 86_400);

    ddbMock.on(GetCommand).resolves({ Item: item });
    expect(await store().isProcessed("uri::100")).toBe(true);
  });

  it("isProcessed / isTasked are false when the item is absent", async () => {
    ddbMock.on(GetCommand).resolves({});
    const s = store();
    expect(await s.isProcessed("missing")).toBe(false);
    expect(await s.isTasked("missing")).toBe(false);
  });

  it("honors a custom ttlDays", async () => {
    ddbMock.on(PutCommand).resolves({});
    const s = new DynamoStateStore({ tableName: TABLE, region: "us-east-2", now: () => FIXED_NOW, ttlDays: 7 });
    await s.markTasked("uri::7");
    const item = putWithPk("TASKED#uri::7")!.Item as Record<string, unknown>;
    expect(item.ttl).toBe(Math.floor(FIXED_NOW / 1000) + 7 * 86_400);
  });

  it("appends a run summary and a LASTRUN pointer", async () => {
    ddbMock.on(PutCommand).resolves({});
    const summary = { finishedAt: "2026-06-19T00:00:00.000Z", parentTasksCreated: 2 } as unknown as RunSummary;
    await store().appendRunSummary(summary);

    expect(putWithPk("RUN#2026-06-19T00:00:00.000Z")!.Item).toMatchObject({ summary });
    const meta = putWithPk("META")!.Item as Record<string, unknown>;
    expect(meta).toMatchObject({ pk: "META", sk: "LASTRUN", lastRunAt: "2026-06-19T00:00:00.000Z" });

    ddbMock.on(GetCommand).resolves({ Item: meta });
    expect(await store().getLastRunAt()).toBe("2026-06-19T00:00:00.000Z");
  });
});
