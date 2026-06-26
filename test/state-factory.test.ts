import { describe, it, expect, afterEach } from "vitest";
import { createStateStore } from "../src/state/factory.js";
import { FileStateStore } from "../src/state/file-store.js";
import { DynamoStateStore } from "../src/state/dynamo-store.js";

const ENV_KEYS = ["STATE_STORE", "AGENT_STATE_TABLE", "STATE_TTL_DAYS"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("createStateStore (env-selected)", () => {
  it("defaults to the file store when STATE_STORE is unset", () => {
    delete process.env.STATE_STORE;
    expect(createStateStore("/tmp/agent")).toBeInstanceOf(FileStateStore);
  });

  it("selects the file store explicitly", () => {
    process.env.STATE_STORE = "file";
    expect(createStateStore("/tmp/agent")).toBeInstanceOf(FileStateStore);
  });

  it("selects DynamoDB when STATE_STORE=dynamo and a table is set", () => {
    process.env.STATE_STORE = "dynamo";
    process.env.AGENT_STATE_TABLE = "AgentState";
    expect(createStateStore("/tmp/agent")).toBeInstanceOf(DynamoStateStore);
  });

  it("throws when dynamo is selected without a table name", () => {
    process.env.STATE_STORE = "dynamo";
    delete process.env.AGENT_STATE_TABLE;
    expect(() => createStateStore("/tmp/agent")).toThrow(/AGENT_STATE_TABLE/);
  });

  it("rejects an unknown store kind", () => {
    process.env.STATE_STORE = "redis";
    expect(() => createStateStore("/tmp/agent")).toThrow(/Unknown STATE_STORE/);
  });
});
