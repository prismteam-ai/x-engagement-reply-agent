import { createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

export type RuntimeEnv = Record<string, string | undefined>;

export const DEFAULT_KEY_PREFIX = "xatu-agent";

export type DynamoDbConfig = {
  tableName: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  endpoint?: string;
};

export function isDynamoDbConfigured(env: RuntimeEnv = process.env): boolean {
  const table = (env.DYNAMODB_TABLE ?? "").trim();
  if (!table) return false;
  const hasKeys =
    Boolean((env.AWS_ACCESS_KEY_ID ?? "").trim()) &&
    Boolean((env.AWS_SECRET_ACCESS_KEY ?? "").trim());
  return hasKeys;
}

export function resolveDynamoDbConfig(env: RuntimeEnv = process.env): DynamoDbConfig {
  const tableName = (env.DYNAMODB_TABLE ?? "").trim();
  if (!tableName) {
    throw new Error("DYNAMODB_TABLE is not set — the DynamoDB state store requires a table name.");
  }
  const region = (env.AWS_REGION ?? "us-east-1").trim() || "us-east-1";
  const accessKeyId = (env.AWS_ACCESS_KEY_ID ?? "").trim();
  const secretAccessKey = (env.AWS_SECRET_ACCESS_KEY ?? "").trim();
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are not set — the DynamoDB state store requires IAM credentials.",
    );
  }
  const sessionToken = (env.AWS_SESSION_TOKEN ?? "").trim();
  const endpoint = (env.DYNAMODB_ENDPOINT ?? "").trim();
  return {
    tableName,
    region,
    accessKeyId,
    secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
    ...(endpoint ? { endpoint } : {}),
  };
}

export function createDocumentClient(config: DynamoDbConfig): DynamoDBDocumentClient {
  const raw = new DynamoDBClient({
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
    },
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
  });
  return DynamoDBDocumentClient.from(raw, {
    marshallOptions: { removeUndefinedValues: true },
  });
}

function hashLogicalKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

type StoreItem = {
  pk: string;
  sk: string;
  keyPrefix: string;
  logicalKey: string;
  payload: unknown;
  ttl?: number;
};

export type DynamoDbStoreOptions = {
  tableName: string;
  documentClient: DynamoDBDocumentClient;
  keyPrefix?: string;
};

export class DynamoDbStateStore {
  private readonly tableName: string;
  private readonly doc: DynamoDBDocumentClient;
  private readonly keyPrefix: string;

  constructor(options: DynamoDbStoreOptions) {
    this.tableName = options.tableName;
    this.doc = options.documentClient;
    this.keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
  }

  private valuePk(logicalKey: string): string {
    return `KP#${this.keyPrefix}#CACHE#${hashLogicalKey(logicalKey)}`;
  }

  private setPk(logicalKey: string): string {
    return `KP#${this.keyPrefix}#SET#${hashLogicalKey(logicalKey)}`;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const result = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: this.valuePk(key), sk: "VALUE" },
        ConsistentRead: true,
      }),
    );
    const item = result.Item as StoreItem | undefined;
    if (!item) return null;
    if (item.ttl !== undefined && item.ttl * 1000 <= Date.now()) {
      return null;
    }
    return (item.payload as T) ?? null;
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    const item: StoreItem = {
      pk: this.valuePk(key),
      sk: "VALUE",
      keyPrefix: this.keyPrefix,
      logicalKey: key,
      payload: value,
      ...(ttlMs !== undefined ? { ttl: Math.ceil((Date.now() + ttlMs) / 1000) } : {}),
    };
    await this.doc.send(new PutCommand({ TableName: this.tableName, Item: item }));
  }

  async addToSet(key: string, members: string[], ttlMs?: number): Promise<void> {
    const clean = Array.from(new Set(members.map((m) => String(m)).filter((m) => m.length > 0)));
    if (clean.length === 0) return;
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: this.setPk(key), sk: "SET" },
        UpdateExpression:
          "ADD #members :members SET keyPrefix = :kp, logicalKey = :lk" +
          (ttlMs !== undefined ? ", #ttl = :ttl" : ""),
        ExpressionAttributeNames: {
          "#members": "members",
          ...(ttlMs !== undefined ? { "#ttl": "ttl" } : {}),
        },
        ExpressionAttributeValues: {
          ":members": new Set(clean),
          ":kp": this.keyPrefix,
          ":lk": key,
          ...(ttlMs !== undefined ? { ":ttl": Math.ceil((Date.now() + ttlMs) / 1000) } : {}),
        },
      }),
    );
  }

  async getSet(key: string): Promise<string[]> {
    const result = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: this.setPk(key), sk: "SET" },
        ConsistentRead: true,
      }),
    );
    const item = result.Item as { members?: Set<string> | string[] } | undefined;
    if (!item || !item.members) return [];
    const members = item.members instanceof Set ? Array.from(item.members) : item.members;
    return [...members].sort();
  }
}

export function createDynamoDbStateStore(env: RuntimeEnv = process.env): DynamoDbStateStore {
  const config = resolveDynamoDbConfig(env);
  return new DynamoDbStateStore({
    tableName: config.tableName,
    documentClient: createDocumentClient(config),
  });
}
