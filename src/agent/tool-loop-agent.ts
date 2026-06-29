import type { JSONValue, ToolSet } from "ai";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import {
  createLangSmithFacade,
  type LangSmithFacade,
  type RuntimeEnv,
} from "@/observability/langsmith";
import { BEDROCK_PROMPT_CACHE_METADATA } from "@/agent/bedrock-prompt-cache";

export type ReplyToolLoopAgent = {
  generateText: (prompt: string, abortSignal?: AbortSignal) => Promise<string>;
  flush: () => Promise<void>;
  tracingEnabled: boolean;
};

export type CreateReplyToolLoopAgentParams = {
  model: LanguageModelV4;
  instructions: string;
  tools?: ToolSet;
  sessionId?: string;
  bedrockModelId?: string;
  maxOutputTokens?: number;
  langsmith?: LangSmithFacade;
  env?: RuntimeEnv;
};

function buildLangSmithProviderMetadata(params: {
  sessionId?: string;
  bedrockModelId?: string;
}): Record<string, JSONValue> {
  return {
    metadata: {
      ls_provider: "anthropic",
      ...(params.bedrockModelId ? { bedrock_model_id: params.bedrockModelId } : {}),
      ...BEDROCK_PROMPT_CACHE_METADATA,
      ...(params.sessionId ? { source_post: params.sessionId } : {}),
    },
  };
}

export async function createReplyToolLoopAgent(
  params: CreateReplyToolLoopAgentParams,
): Promise<ReplyToolLoopAgent> {
  const langsmith =
    params.langsmith ?? (await createLangSmithFacade(params.env ?? process.env));

  const providerOptions = {
    langsmith: buildLangSmithProviderMetadata({
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      ...(params.bedrockModelId ? { bedrockModelId: params.bedrockModelId } : {}),
    }),
  };

  const agent = new langsmith.ToolLoopAgent({
    model: params.model,
    tools: params.tools ?? {},
    instructions: params.instructions,
    ...(params.maxOutputTokens ? { maxOutputTokens: params.maxOutputTokens } : {}),
    providerOptions,
  });

  return {
    tracingEnabled: langsmith.tracingEnabled,
    flush: () => langsmith.flush(),
    generateText: async (prompt: string, abortSignal?: AbortSignal): Promise<string> => {
      const result = await agent.generate({
        prompt,
        ...(abortSignal ? { abortSignal } : {}),
      });
      return result.text;
    },
  };
}
