import "dotenv/config";
import {
  DynamoDBClient,
  CreateTableCommand,
  UpdateTimeToLiveCommand,
  DescribeTableCommand,
  ResourceInUseException,
} from "@aws-sdk/client-dynamodb";
import { createLogger } from "../observability/logger.js";

/**
 * Create the AgentState table in DynamoDB Local (or any endpoint) for local dev.
 * Idempotent — safe to re-run. Mirrors the CDK table: pk/sk, PAY_PER_REQUEST, TTL
 * on `ttl`. Used by `pnpm dynamo:init` and the docker-compose init service.
 *
 *   AGENT_STATE_TABLE   table name (default "AgentState")
 *   DYNAMODB_ENDPOINT   endpoint URL (default http://localhost:8000)
 *   AWS_REGION          region (default us-east-2)
 */
async function main(): Promise<void> {
  const log = createLogger("dynamo-init");
  const tableName = process.env.AGENT_STATE_TABLE ?? "AgentState";
  const endpoint = process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000";
  const region = process.env.AWS_REGION ?? "us-east-2";

  const client = new DynamoDBClient({
    region,
    endpoint,
    credentials: process.env.AWS_ACCESS_KEY_ID
      ? undefined
      : { accessKeyId: "local", secretAccessKey: "local" },
  });

  try {
    await client.send(
      new CreateTableCommand({
        TableName: tableName,
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
    log.info("table created", { tableName, endpoint });
  } catch (err) {
    if (err instanceof ResourceInUseException) {
      log.info("table already exists", { tableName, endpoint });
    } else {
      throw err;
    }
  }

  // Wait until ACTIVE, then enable TTL (best-effort; DynamoDB Local accepts it).
  await client.send(new DescribeTableCommand({ TableName: tableName }));
  try {
    await client.send(
      new UpdateTimeToLiveCommand({
        TableName: tableName,
        TimeToLiveSpecification: { Enabled: true, AttributeName: "ttl" },
      }),
    );
    log.info("TTL enabled on `ttl`", { tableName });
  } catch (err) {
    log.warn("could not enable TTL (continuing)", { error: String(err) });
  }

  log.info("AgentState ready", { tableName, endpoint });
}

main().catch((err) => {
  createLogger("dynamo-init").error("init failed", {
    error: err instanceof Error ? err.stack : String(err),
  });
  process.exitCode = 1;
});
