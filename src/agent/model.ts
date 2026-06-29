import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { withBedrockPromptCaching } from "@/agent/bedrock-prompt-cache";
import { loadSettings } from "@/config/load-settings";

export type RuntimeEnv = Record<string, string | undefined>;

export const DEFAULT_AWS_REGION = "us-east-1";

export type BedrockModelConfig = {
  region: string;
  bedrockModelId: string;
  apiKey: string;
};

export type ResolveBedrockConfigOptions = {
  configModelId?: string;
};

export function loadConfiguredBedrockModelId(): string {
  return loadSettings().bedrockModelId;
}

export function resolveBedrockModelId(
  env: RuntimeEnv,
  configModelId: string | undefined,
): string {
  const envModelId = (env.BEDROCK_MODEL_ID ?? "").trim();
  if (envModelId) return envModelId;
  const configured = (configModelId ?? "").trim();
  if (configured) return configured;
  throw new Error(
    "No Bedrock model id resolved — set bedrockModelId in config/settings.yaml (override with the BEDROCK_MODEL_ID env var).",
  );
}

export function resolveBedrockConfig(
  env: RuntimeEnv = process.env,
  options: ResolveBedrockConfigOptions = {},
): BedrockModelConfig {
  const apiKey = (env.AWS_BEARER_TOKEN_BEDROCK ?? "").trim();
  if (!apiKey) {
    throw new Error(
      "AWS_BEARER_TOKEN_BEDROCK is not set — the Bedrock reply model requires a Bedrock API key (bearer token).",
    );
  }
  const bedrockModelId = resolveBedrockModelId(env, options.configModelId);
  const region = (env.AWS_REGION ?? "").trim() || DEFAULT_AWS_REGION;
  return { region, bedrockModelId, apiKey };
}

export function isBedrockConfigured(
  env: RuntimeEnv = process.env,
  options: ResolveBedrockConfigOptions = {},
): boolean {
  const apiKey = (env.AWS_BEARER_TOKEN_BEDROCK ?? "").trim();
  if (!apiKey) return false;
  const envModelId = (env.BEDROCK_MODEL_ID ?? "").trim();
  if (envModelId) return true;
  if ((options.configModelId ?? "").trim()) return true;
  if (env === process.env) {
    try {
      return Boolean(loadConfiguredBedrockModelId().trim());
    } catch {
      return false;
    }
  }
  return false;
}

export function createBedrockReplyLanguageModel(
  env: RuntimeEnv = process.env,
  options: ResolveBedrockConfigOptions = {},
): LanguageModelV4 {
  const { region, bedrockModelId, apiKey } = resolveBedrockConfig(env, options);

  const bedrock = createAmazonBedrock({ region, apiKey });

  return withBedrockPromptCaching(bedrock(bedrockModelId));
}
