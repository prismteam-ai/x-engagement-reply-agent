import { describe, expect, it } from "vitest";
import * as ai from "ai";
import { createLangSmithFacade } from "@/observability/langsmith";

/**
 * LangSmith facade graceful-degradation coverage (kit rule
 * observability-langsmith-telemetry § graceful degradation).
 *
 * Without an API key, the facade must return UNWRAPPED AI SDK functions, report
 * tracingEnabled=false, and a no-op flush — never throw. With LANGSMITH_TRACING
 * explicitly disabled it must also no-op even if a key is present.
 */
describe("createLangSmithFacade", () => {
  it("degrades to passthrough when no API key is present", async () => {
    const facade = await createLangSmithFacade({});
    expect(facade.tracingEnabled).toBe(false);
    expect(facade.generateText).toBe(ai.generateText);
    expect(facade.ToolLoopAgent).toBe(ai.ToolLoopAgent);
    await expect(facade.flush()).resolves.toBeUndefined();
  });

  it("degrades to passthrough when tracing is explicitly disabled", async () => {
    const facade = await createLangSmithFacade({
      LANGSMITH_API_KEY: "lsv2_dummy",
      LANGSMITH_TRACING: "false",
    });
    expect(facade.tracingEnabled).toBe(false);
    expect(facade.ToolLoopAgent).toBe(ai.ToolLoopAgent);
  });

  it("never throws when given an empty env", async () => {
    await expect(createLangSmithFacade({})).resolves.toBeTruthy();
  });
});
