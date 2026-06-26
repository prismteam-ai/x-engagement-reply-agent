import { openai } from "@ai-sdk/openai";
import { bedrock } from "@ai-sdk/amazon-bedrock";
import type { LanguageModel } from "ai";

/**
 * Resolve a provider-agnostic `modelId` to a Vercel AI SDK LanguageModel.
 * All LLM calls go through the AI SDK (golden path) — no direct provider SDKs.
 *
 * Format: "<provider>/<model>" where provider is `openai` or `bedrock`.
 * A bare id (no slash) defaults to OpenAI for convenience.
 */
export function resolveModel(modelId: string): LanguageModel {
  const slash = modelId.indexOf("/");
  const provider = slash === -1 ? "openai" : modelId.slice(0, slash);
  const id = slash === -1 ? modelId : modelId.slice(slash + 1);

  switch (provider) {
    case "openai":
      return openai(id);
    case "bedrock":
      return bedrock(id);
    default:
      throw new Error(`Unsupported model provider "${provider}" in modelId "${modelId}". Use openai/* or bedrock/*.`);
  }
}
