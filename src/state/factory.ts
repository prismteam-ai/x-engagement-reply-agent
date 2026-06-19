import { join } from "node:path";
import type { StateStore } from "./store.js";
import { FileStateStore } from "./file-store.js";
import { DynamoStateStore } from "./dynamo-store.js";
import { createLogger, type Logger } from "../observability/logger.js";

/**
 * Select the StateStore implementation from the environment so the same pipeline
 * runs locally (JSON file) and in production (DynamoDB) with no code change:
 *
 *   STATE_STORE=file    (default) → FileStateStore at <root>/data/state.json
 *   STATE_STORE=dynamo            → DynamoStateStore (requires AGENT_STATE_TABLE)
 *
 * Optional: STATE_TTL_DAYS overrides the dedupe-key TTL (default 90).
 */
export function createStateStore(root: string, logger?: Logger): StateStore {
  const log = logger ?? createLogger("state");
  const kind = (process.env.STATE_STORE ?? "file").toLowerCase();

  if (kind === "dynamo" || kind === "dynamodb") {
    const tableName = process.env.AGENT_STATE_TABLE;
    if (!tableName) {
      throw new Error("STATE_STORE=dynamo requires AGENT_STATE_TABLE to be set.");
    }
    const ttlDays = process.env.STATE_TTL_DAYS ? Number(process.env.STATE_TTL_DAYS) : undefined;
    // DYNAMODB_ENDPOINT points at DynamoDB Local for the docker-compose dev stack.
    const endpoint = process.env.DYNAMODB_ENDPOINT ?? process.env.AWS_ENDPOINT_URL_DYNAMODB;
    log.info("using DynamoDB state store", { tableName, region: process.env.AWS_REGION, endpoint });
    return new DynamoStateStore({ tableName, region: process.env.AWS_REGION, endpoint, ttlDays, logger: log });
  }

  if (kind !== "file") {
    throw new Error(`Unknown STATE_STORE "${kind}". Use "file" or "dynamo".`);
  }

  const path = join(root, "data", "state.json");
  log.info("using file state store", { path });
  return new FileStateStore(path);
}
