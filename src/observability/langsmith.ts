import * as ai from "ai";
import { Client } from "langsmith";
import { wrapAISDK } from "langsmith/experimental/vercel";
import { logRuntime } from "@/observability/logger";

export type RuntimeEnv = Record<string, string | undefined>;

export const DEFAULT_LANGSMITH_ENDPOINT = "https://api.smith.langchain.com";
export const DEFAULT_LANGSMITH_PROJECT = "xatu-agent";

export type LangSmithFacade = {
  tracingEnabled: boolean;
  generateText: typeof ai.generateText;
  ToolLoopAgent: typeof ai.ToolLoopAgent;
  flush: () => Promise<void>;
};

function tracingDisabled(env: RuntimeEnv): boolean {
  const flag = (env.LANGSMITH_TRACING ?? "").trim().toLowerCase();
  return flag === "false" || flag === "0" || flag === "off";
}

function resolveApiKey(env: RuntimeEnv): string | undefined {
  const key = (env.LANGSMITH_API_KEY ?? "").trim();
  return key || undefined;
}

function passthroughFacade(): LangSmithFacade {
  return {
    tracingEnabled: false,
    generateText: ai.generateText,
    ToolLoopAgent: ai.ToolLoopAgent,
    flush: async () => {},
  };
}

export async function createLangSmithFacade(
  env: RuntimeEnv = process.env,
): Promise<LangSmithFacade> {
  if (tracingDisabled(env)) {
    return passthroughFacade();
  }

  const key = resolveApiKey(env);
  if (!key) {
    return passthroughFacade();
  }

  try {
    const endpoint = (env.LANGSMITH_ENDPOINT ?? "").trim() || DEFAULT_LANGSMITH_ENDPOINT;
    const project = (env.LANGSMITH_PROJECT ?? "").trim() || DEFAULT_LANGSMITH_PROJECT;

    process.env.LANGSMITH_API_KEY = key;
    process.env.LANGSMITH_ENDPOINT = endpoint;
    process.env.LANGSMITH_PROJECT = project;
    process.env.LANGSMITH_TRACING = "true";

    const client = new Client({ apiKey: key, apiUrl: endpoint });
    const wrapped = wrapAISDK(ai);

    logRuntime({
      level: "info",
      message: "LangSmith tracing enabled.",
      langsmithProject: project,
    });

    return {
      tracingEnabled: true,
      generateText: wrapped.generateText,
      ToolLoopAgent: wrapped.ToolLoopAgent ?? ai.ToolLoopAgent,
      flush: () => client.awaitPendingTraceBatches(),
    };
  } catch (error) {
    logRuntime({
      level: "warn",
      message: "LangSmith setup failed; continuing without tracing.",
      reason: error instanceof Error ? error.message : String(error),
    });
    return passthroughFacade();
  }
}
