import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  DynamoDbStateStore,
  isDynamoDbConfigured,
  resolveDynamoDbConfig,
} from "@/state/ddb-client";
import {
  getStateBackend,
  resetStateBackendCache,
  saveLatestRun,
  readLatestRun,
  getPollingCursor,
  setPollingCursor,
  getAlreadyTasked,
  markTasked,
  normalizeHandle,
} from "@/state/agent-state";
import type { RunMonitorResult } from "@/pipeline/run-monitor";

/**
 * Unit tests for the DynamoDB state layer with a MOCKED document client — no
 * network, no AWS. The mock implements the GetCommand/PutCommand/UpdateCommand
 * subset the store uses against an in-memory item map keyed by pk+sk, including
 * the native string-set ADD semantics for the dedupe set.
 *
 * The live integration test (ddb-state.live.test.ts) is the only thing that
 * touches the real table, and it is double-gated.
 */

type Item = Record<string, unknown> & { pk: string; sk: string };

/** Minimal in-memory DynamoDBDocumentClient mock. */
function makeFakeDocClient() {
  const items = new Map<string, Item>();
  const keyOf = (k: { pk: string; sk: string }) => `${k.pk}::${k.sk}`;

  const send = vi.fn(async (command: { constructor: { name: string }; input: any }) => {
    const name = command.constructor.name;
    const input = command.input;
    if (name === "GetCommand") {
      const item = items.get(keyOf(input.Key));
      return { Item: item ? { ...item } : undefined };
    }
    if (name === "PutCommand") {
      const item = input.Item as Item;
      items.set(keyOf(item), { ...item });
      return {};
    }
    if (name === "UpdateCommand") {
      // Only the ADD-to-string-set update shape is exercised.
      const key = input.Key as { pk: string; sk: string };
      const existing = items.get(keyOf(key)) ?? { ...key };
      const addMembers = input.ExpressionAttributeValues[":members"] as Set<string>;
      const prior =
        existing.members instanceof Set
          ? (existing.members as Set<string>)
          : new Set<string>(Array.isArray(existing.members) ? (existing.members as string[]) : []);
      for (const m of addMembers) prior.add(m);
      const next: Item = {
        ...existing,
        members: prior,
        keyPrefix: input.ExpressionAttributeValues[":kp"],
        logicalKey: input.ExpressionAttributeValues[":lk"],
      };
      if (input.ExpressionAttributeValues[":ttl"] !== undefined) {
        next.ttl = input.ExpressionAttributeValues[":ttl"];
      }
      items.set(keyOf(key), next);
      return {};
    }
    throw new Error(`unexpected command: ${name}`);
  });

  return { send, items } as unknown as {
    send: ReturnType<typeof vi.fn>;
    items: Map<string, Item>;
  };
}

function makeStore() {
  const doc = makeFakeDocClient();
  const store = new DynamoDbStateStore({
    tableName: "test-table",
    // The mock satisfies the DynamoDBDocumentClient.send contract used here.
    documentClient: doc as any,
    keyPrefix: "xatu-test",
  });
  return { store, doc };
}

const fakeResult: RunMonitorResult = {
  organic: true,
  summary: {
    runKey: "run-1",
    startedAt: "2026-06-22T00:00:00.000Z",
    finishedAt: "2026-06-22T00:00:01.000Z",
    dryRun: true,
    counts: {
      authorsPolled: 1,
      postsFetched: 1,
      newPosts: 1,
      matched: 1,
      tasksWouldCreate: 1,
      tasksCreated: 0,
      skipped: 0,
      failures: 0,
      skipReasons: {},
    },
    posts: [],
  },
  tasks: [],
};

describe("DynamoDbStateStore (mocked client)", () => {
  it("get returns null for an absent key", async () => {
    const { store } = makeStore();
    expect(await store.get("missing")).toBeNull();
  });

  it("set then get round-trips a JSON payload", async () => {
    const { store } = makeStore();
    await store.set("k", { a: 1, b: ["x"] });
    expect(await store.get("k")).toEqual({ a: 1, b: ["x"] });
  });

  it("treats a logically-expired TTL item as absent", async () => {
    const { store } = makeStore();
    await store.set("expiring", "v", -1000); // already expired
    expect(await store.get("expiring")).toBeNull();
  });

  it("value and set keys do not collide for the same logical key", async () => {
    const { store } = makeStore();
    await store.set("same", "as-value");
    await store.addToSet("same", ["m1"]);
    expect(await store.get("same")).toBe("as-value");
    expect(await store.getSet("same")).toEqual(["m1"]);
  });

  it("addToSet unions idempotently and getSet returns a sorted array", async () => {
    const { store } = makeStore();
    await store.addToSet("dedupe", ["b", "a"]);
    await store.addToSet("dedupe", ["a", "c"]); // 'a' already present
    expect(await store.getSet("dedupe")).toEqual(["a", "b", "c"]);
  });

  it("getSet returns [] for an absent set", async () => {
    const { store } = makeStore();
    expect(await store.getSet("nope")).toEqual([]);
  });
});

describe("agent-state public API (DynamoDB backend, mocked client)", () => {
  let backend: ReturnType<typeof getStateBackend>;
  beforeEach(() => {
    resetStateBackendCache();
    const { store } = makeStore();
    backend = getStateBackend({ store });
  });

  it("reports the dynamodb backend kind when a store is injected", () => {
    expect(backend.kind).toBe("dynamodb");
  });

  it("saveLatestRun + readLatestRun round-trip with a savedAt", async () => {
    const stored = await saveLatestRun(fakeResult, backend);
    expect(stored.savedAt).toBeTruthy();
    const read = await readLatestRun(backend);
    expect(read?.summary.runKey).toBe("run-1");
    expect(read?.savedAt).toBe(stored.savedAt);
  });

  it("polling cursors persist per handle", async () => {
    await setPollingCursor("@Balajis", "1999999999999999999", backend);
    expect(await getPollingCursor("balajis", backend)).toBe("1999999999999999999");
    expect(await getPollingCursor("unknown", backend)).toBeNull();
  });

  it("ignores empty cursor handle / status id", async () => {
    await setPollingCursor("", "123", backend);
    await setPollingCursor("h", "", backend);
    expect(await getPollingCursor("h", backend)).toBeNull();
  });

  it("cross-run dedupe: markTasked then getAlreadyTasked", async () => {
    await markTasked(["uri-1|111", "uri-2|222"], backend);
    const present = await getAlreadyTasked(["uri-1|111", "uri-3|333"], backend);
    expect(present.has("uri-1|111")).toBe(true);
    expect(present.has("uri-3|333")).toBe(false);
  });

  it("cross-run dedupe entries carry a TTL so the set self-expires", async () => {
    const { store, doc } = makeStore();
    const ttlBackend = getStateBackend({ store });
    await markTasked(["uri-9|999"], ttlBackend);
    const written = Array.from(doc.items.values()).filter((item) => {
      const logicalKey = (item as Record<string, unknown>).logicalKey;
      return typeof logicalKey === "string" && logicalKey.startsWith("dedupe:tasked:");
    });
    expect(written.length).toBe(1);
    const ttl = (written[0] as Record<string, unknown>).ttl as number | undefined;
    expect(typeof ttl).toBe("number");
    expect(ttl!).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("getAlreadyTasked short-circuits on an empty key list", async () => {
    const present = await getAlreadyTasked([], backend);
    expect(present.size).toBe(0);
  });
});

describe("config + helpers", () => {
  it("isDynamoDbConfigured requires table + IAM creds", () => {
    expect(isDynamoDbConfigured({})).toBe(false);
    expect(isDynamoDbConfigured({ DYNAMODB_TABLE: "t" })).toBe(false);
    expect(
      isDynamoDbConfigured({
        DYNAMODB_TABLE: "t",
        AWS_ACCESS_KEY_ID: "id",
        AWS_SECRET_ACCESS_KEY: "secret",
      }),
    ).toBe(true);
  });

  it("resolveDynamoDbConfig throws a secret-free error when creds are missing", () => {
    expect(() => resolveDynamoDbConfig({ DYNAMODB_TABLE: "t" })).toThrow(/IAM credentials/);
    expect(() => resolveDynamoDbConfig({})).toThrow(/DYNAMODB_TABLE/);
  });

  it("resolveDynamoDbConfig defaults region to us-east-1", () => {
    const cfg = resolveDynamoDbConfig({
      DYNAMODB_TABLE: "t",
      AWS_ACCESS_KEY_ID: "id",
      AWS_SECRET_ACCESS_KEY: "secret",
    });
    expect(cfg.region).toBe("us-east-1");
    expect(cfg.tableName).toBe("t");
  });

  it("normalizeHandle strips @ and lowercases", () => {
    expect(normalizeHandle("@Balajis")).toBe("balajis");
    expect(normalizeHandle("  Foo ")).toBe("foo");
  });

  it("getStateBackend(env) picks file backend without DYNAMODB_TABLE", () => {
    expect(getStateBackend({ env: {} }).kind).toBe("file");
    expect(
      getStateBackend({
        env: { DYNAMODB_TABLE: "t", AWS_ACCESS_KEY_ID: "id", AWS_SECRET_ACCESS_KEY: "s" },
      }).kind,
    ).toBe("dynamodb");
  });
});
