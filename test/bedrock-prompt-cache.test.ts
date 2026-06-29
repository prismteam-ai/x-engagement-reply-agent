import { describe, expect, it } from "vitest";
import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import {
  applyBedrockPromptCaching,
  BEDROCK_PROMPT_CACHE_METADATA,
} from "@/agent/bedrock-prompt-cache";

/**
 * Unit coverage for the Bedrock prompt-cache helper (kit rule
 * implementation-bedrock-prompt-caching § Tests):
 *   - marks the first system message AND the last non-system message,
 *   - preserves existing provider options (only bedrock.cachePoint changes),
 *   - exposes the comparable cache-policy metadata.
 */

function prompt(): LanguageModelV4Prompt {
  return [
    { role: "system", content: "system A" },
    { role: "user", content: [{ type: "text", text: "hello" }] },
    {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      providerOptions: { bedrock: { reasoningConfig: { type: "enabled" } } },
    },
    { role: "user", content: [{ type: "text", text: "last" }] },
  ] as unknown as LanguageModelV4Prompt;
}

const CACHE_POINT = { type: "default" };

describe("applyBedrockPromptCaching", () => {
  it("marks the first system message and the last non-system message", () => {
    const { prompt: out, cachePointsAdded } = applyBedrockPromptCaching(prompt());
    expect(cachePointsAdded).toBe(2);

    // first system
    expect((out[0] as any).providerOptions.bedrock.cachePoint).toEqual(CACHE_POINT);
    // last message (a user message) — the last non-system
    expect((out[3] as any).providerOptions.bedrock.cachePoint).toEqual(CACHE_POINT);
    // middle messages untouched
    expect((out[1] as any).providerOptions).toBeUndefined();
  });

  it("preserves existing bedrock provider options and only sets cachePoint", () => {
    const withOptionsLast: LanguageModelV4Prompt = [
      { role: "system", content: "sys" },
      {
        role: "user",
        content: [{ type: "text", text: "q" }],
        providerOptions: { bedrock: { foo: "bar" } },
      },
    ] as unknown as LanguageModelV4Prompt;

    const { prompt: out } = applyBedrockPromptCaching(withOptionsLast);
    const last = (out[1] as any).providerOptions.bedrock;
    expect(last.foo).toBe("bar"); // preserved
    expect(last.cachePoint).toEqual(CACHE_POINT); // added
  });

  it("does not mutate the input prompt", () => {
    const input = prompt();
    applyBedrockPromptCaching(input);
    expect((input[0] as any).providerOptions).toBeUndefined();
  });

  it("handles a system-only prompt (one cache point on the system message)", () => {
    const sysOnly = [{ role: "system", content: "only" }] as unknown as LanguageModelV4Prompt;
    const { cachePointsAdded } = applyBedrockPromptCaching(sysOnly);
    expect(cachePointsAdded).toBe(1);
  });

  it("exposes comparable cache-policy metadata", () => {
    expect(BEDROCK_PROMPT_CACHE_METADATA).toMatchObject({
      bedrock_prompt_caching: true,
      bedrock_prompt_cache_strategy: "system_and_last_non_system",
      bedrock_prompt_cache_ttl: "default",
      bedrock_prompt_cache_tool_config: false,
    });
  });
});
