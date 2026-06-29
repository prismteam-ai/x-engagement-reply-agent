import { wrapLanguageModel } from "ai";
import type {
  LanguageModelV4,
  LanguageModelV4Middleware,
  LanguageModelV4Prompt,
} from "@ai-sdk/provider";
import { logRuntime } from "@/observability/logger";

type BedrockPrompt = LanguageModelV4Prompt;
type BedrockPromptMessage = BedrockPrompt[number];
type BedrockUsage = Awaited<ReturnType<LanguageModelV4["doGenerate"]>>["usage"];

const BEDROCK_CACHE_POINT = { type: "default" as const };

export const BEDROCK_PROMPT_CACHE_METADATA = {
  bedrock_prompt_caching: true,
  bedrock_prompt_cache_strategy: "system_and_last_non_system",
  bedrock_prompt_cache_ttl: "default",
  bedrock_prompt_cache_tool_config: false,
} as const;

function withCachePoint(message: BedrockPromptMessage): BedrockPromptMessage {
  const providerOptions = message.providerOptions ?? {};
  const bedrockOptions =
    typeof providerOptions.bedrock === "object" && providerOptions.bedrock !== null
      ? providerOptions.bedrock
      : {};

  return {
    ...message,
    providerOptions: {
      ...providerOptions,
      bedrock: {
        ...bedrockOptions,
        cachePoint: BEDROCK_CACHE_POINT,
      },
    },
  };
}

export function applyBedrockPromptCaching(prompt: BedrockPrompt): {
  prompt: BedrockPrompt;
  cachePointsAdded: number;
} {
  const targetIndexes = new Set<number>();

  const firstSystemIndex = prompt.findIndex((message) => message.role === "system");
  if (firstSystemIndex >= 0) {
    targetIndexes.add(firstSystemIndex);
  }

  for (let index = prompt.length - 1; index >= 0; index -= 1) {
    if (prompt[index]?.role !== "system") {
      targetIndexes.add(index);
      break;
    }
  }

  if (targetIndexes.size === 0) {
    return { prompt, cachePointsAdded: 0 };
  }

  return {
    prompt: prompt.map((message, index) =>
      targetIndexes.has(index) ? withCachePoint(message) : message,
    ),
    cachePointsAdded: targetIndexes.size,
  };
}

function logCacheUsage(usage: BedrockUsage | undefined): void {
  const cacheRead = usage?.inputTokens?.cacheRead ?? 0;
  const cacheWrite = usage?.inputTokens?.cacheWrite ?? 0;

  if (cacheRead <= 0 && cacheWrite <= 0) {
    return;
  }

  logRuntime({
    level: "info",
    message: "Bedrock prompt cache usage.",
    bedrockPromptCacheReadInputTokens: cacheRead,
    bedrockPromptCacheWriteInputTokens: cacheWrite,
  });
}

export function withBedrockPromptCaching(model: LanguageModelV4): LanguageModelV4 {
  const middleware: LanguageModelV4Middleware = {
    specificationVersion: "v4",
    transformParams: async ({ params }) => ({
      ...params,
      prompt: applyBedrockPromptCaching(params.prompt).prompt,
    }),
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate();
      logCacheUsage(result.usage);
      return result;
    },
    wrapStream: async ({ doStream }) => {
      const result = await doStream();
      const stream = result.stream.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            if (chunk.type === "finish") {
              logCacheUsage(chunk.usage);
            }
            controller.enqueue(chunk);
          },
        }),
      );
      return { ...result, stream };
    },
  };

  return wrapLanguageModel({ model, middleware });
}
