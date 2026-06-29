import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runFromConfig } from "@/pipeline/run-from-config";
import { createStubReplyModel } from "@/agent/reply-generation";
import { loadFixturePosts } from "./fixtures/posts";
import type {
  InvestorContentMatch,
  QueryInvestorContentParams,
} from "@/mcp/investor-content-client";

const ROOT = resolve(__dirname, "..");
const CRED_ENV_KEYS = ["AWS_BEARER_TOKEN_BEDROCK", "BEDROCK_MODEL_ID", "X_BEARER_TOKEN"];

function stubClient(): (params: QueryInvestorContentParams) => Promise<InvestorContentMatch[]> {
  return vi.fn(async () => [
    {
      id: "m1",
      score: 0.82,
      title: "Programmable Property Truth",
      sourceUri: "https://x.com/i/article/example",
      content:
        "Truth becomes programmable when property records leave silos and become verifiable on-chain.",
    },
  ]);
}

describe("runFromConfig (real on-disk config, mocked MCP + injected posts/model)", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const key of CRED_ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of CRED_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("loads settings + watchlist + prompts and produces a dry-run result", async () => {
    const result = await runFromConfig({
      dryRun: true,
      configRoot: ROOT,
      posts: loadFixturePosts(),
      deps: { queryClient: stubClient(), model: createStubReplyModel() },
    });
    expect(result.summary.dryRun).toBe(true);
    expect(result.summary.counts.authorsPolled).toBeGreaterThan(0);
    expect(result.summary.counts.tasksWouldCreate).toBe(1);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.subtasks.length).toBeGreaterThanOrEqual(6);
  });

  it("restricts the watchlist by authorHandle", async () => {
    const result = await runFromConfig({
      dryRun: true,
      configRoot: ROOT,
      authorHandle: "centrifuge",
      posts: loadFixturePosts(),
      deps: { queryClient: stubClient(), model: createStubReplyModel() },
    });
    expect(result.summary.counts.authorsPolled).toBe(1);
  });

  it("throws when no model is injected and Bedrock is not configured", async () => {
    await expect(
      runFromConfig({
        dryRun: true,
        configRoot: ROOT,
        posts: loadFixturePosts(),
        deps: { queryClient: stubClient() },
      }),
    ).rejects.toThrow(/Bedrock is not configured/);
  });

  it("throws when no posts are injected and the live X poller is not configured", async () => {
    await expect(
      runFromConfig({
        dryRun: true,
        configRoot: ROOT,
        deps: { queryClient: stubClient(), model: createStubReplyModel() },
      }),
    ).rejects.toThrow(/X poller is not configured/);
  });

  it("throws on a real run when DynamoDB state is not configured", async () => {
    const savedTable = process.env.DYNAMODB_TABLE;
    delete process.env.DYNAMODB_TABLE;
    try {
      await expect(
        runFromConfig({
          dryRun: false,
          configRoot: ROOT,
          deps: {
            queryClient: stubClient(),
            model: createStubReplyModel(),
            fetchPosts: async ({ posts }) => posts,
          },
        }),
      ).rejects.toThrow(/DynamoDB is not configured/);
    } finally {
      if (savedTable === undefined) delete process.env.DYNAMODB_TABLE;
      else process.env.DYNAMODB_TABLE = savedTable;
    }
  });

  it("allows an explicit skipState real run without DynamoDB (showcase bake)", async () => {
    const savedTable = process.env.DYNAMODB_TABLE;
    delete process.env.DYNAMODB_TABLE;
    try {
      const result = await runFromConfig({
        dryRun: false,
        skipState: true,
        configRoot: ROOT,
        deps: {
          queryClient: stubClient(),
          model: createStubReplyModel(),
          fetchPosts: async () => loadFixturePosts(),
        },
      });
      expect(result.summary.dryRun).toBe(false);
    } finally {
      if (savedTable === undefined) delete process.env.DYNAMODB_TABLE;
      else process.env.DYNAMODB_TABLE = savedTable;
    }
  });
});
