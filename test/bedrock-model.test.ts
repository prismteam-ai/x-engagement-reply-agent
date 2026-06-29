import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AWS_REGION,
  isBedrockConfigured,
  loadConfiguredBedrockModelId,
  resolveBedrockConfig,
  resolveBedrockModelId,
} from "@/agent/model";
import {
  DEFAULT_BEDROCK_REQUEST_TIMEOUT_MS,
  generateWithRetry,
  isRetryableError,
  isThrottleError,
  resolveRequestTimeoutMs,
} from "@/agent/bedrock-reply-model";

describe("resolveBedrockConfig", () => {
  it("resolves region + model id + apiKey from env (bearer token)", () => {
    const cfg = resolveBedrockConfig({
      AWS_BEARER_TOKEN_BEDROCK: "test-bearer-token",
      AWS_REGION: "us-east-1",
      BEDROCK_MODEL_ID: "us.anthropic.claude-opus-4-6-v1",
    });
    expect(cfg.region).toBe("us-east-1");
    expect(cfg.bedrockModelId).toBe("us.anthropic.claude-opus-4-6-v1");
    expect(cfg.apiKey).toBe("test-bearer-token");
  });

  it("falls back to the default region when AWS_REGION is unset", () => {
    const cfg = resolveBedrockConfig({
      AWS_BEARER_TOKEN_BEDROCK: "k",
      BEDROCK_MODEL_ID: "m",
    });
    expect(cfg.region).toBe(DEFAULT_AWS_REGION);
  });

  it("throws a secret-free error when the bearer token is missing", () => {
    expect(() => resolveBedrockConfig({ BEDROCK_MODEL_ID: "m" })).toThrow(
      /AWS_BEARER_TOKEN_BEDROCK/,
    );
  });

  it("throws when no model id is resolvable from env OR config", () => {
    expect(() => resolveBedrockConfig({ AWS_BEARER_TOKEN_BEDROCK: "k" })).toThrow(
      /BEDROCK_MODEL_ID/,
    );
  });

  it("uses the configured model id when BEDROCK_MODEL_ID env is unset", () => {
    const cfg = resolveBedrockConfig(
      { AWS_BEARER_TOKEN_BEDROCK: "k" },
      { configModelId: "us.anthropic.config-model-v1" },
    );
    expect(cfg.bedrockModelId).toBe("us.anthropic.config-model-v1");
  });

  it("lets BEDROCK_MODEL_ID env OVERRIDE the configured model id", () => {
    const cfg = resolveBedrockConfig(
      { AWS_BEARER_TOKEN_BEDROCK: "k", BEDROCK_MODEL_ID: "env-override" },
      { configModelId: "config-model" },
    );
    expect(cfg.bedrockModelId).toBe("env-override");
  });

  it("isBedrockConfigured reflects presence of api key + an env-or-config model id", () => {
    expect(isBedrockConfigured({ AWS_BEARER_TOKEN_BEDROCK: "k", BEDROCK_MODEL_ID: "m" })).toBe(true);
    expect(isBedrockConfigured({ AWS_BEARER_TOKEN_BEDROCK: "k" })).toBe(false);
    expect(
      isBedrockConfigured({ AWS_BEARER_TOKEN_BEDROCK: "k" }, { configModelId: "config-model" }),
    ).toBe(true);
    expect(isBedrockConfigured({})).toBe(false);
  });
});

describe("resolveBedrockModelId (config-as-code with env override)", () => {
  it("prefers the env override when set", () => {
    expect(resolveBedrockModelId({ BEDROCK_MODEL_ID: "env-model" }, "config-model")).toBe(
      "env-model",
    );
  });

  it("falls back to the configured model id when env is unset", () => {
    expect(resolveBedrockModelId({}, "config-model")).toBe("config-model");
  });

  it("trims and ignores a blank env override", () => {
    expect(resolveBedrockModelId({ BEDROCK_MODEL_ID: "   " }, "config-model")).toBe(
      "config-model",
    );
  });

  it("throws (fail-loud) when neither env nor config provides a model id", () => {
    expect(() => resolveBedrockModelId({}, undefined)).toThrow(/model id/i);
    expect(() => resolveBedrockModelId({}, "  ")).toThrow(/model id/i);
  });

  it("loads the version-controlled config/settings.yaml model id as the configured source", () => {
    const configured = loadConfiguredBedrockModelId();
    expect(configured).toMatch(/anthropic/);
    expect(resolveBedrockModelId({}, configured)).toBe(configured);
  });
});

describe("resolveRequestTimeoutMs", () => {
  it("defaults when unset or invalid", () => {
    expect(resolveRequestTimeoutMs({})).toBe(DEFAULT_BEDROCK_REQUEST_TIMEOUT_MS);
    expect(resolveRequestTimeoutMs({ BEDROCK_REQUEST_TIMEOUT_MS: "nope" })).toBe(
      DEFAULT_BEDROCK_REQUEST_TIMEOUT_MS,
    );
    expect(resolveRequestTimeoutMs({ BEDROCK_REQUEST_TIMEOUT_MS: "0" })).toBe(
      DEFAULT_BEDROCK_REQUEST_TIMEOUT_MS,
    );
  });

  it("reads an explicit positive value", () => {
    expect(resolveRequestTimeoutMs({ BEDROCK_REQUEST_TIMEOUT_MS: "12000" })).toBe(12_000);
  });
});

describe("isThrottleError / isRetryableError", () => {
  it("treats 429 / throttle as retryable", () => {
    expect(isThrottleError({ status: 429 })).toBe(true);
    expect(isRetryableError({ status: 429 })).toBe(true);
    expect(isRetryableError(new Error("Rate exceeded"))).toBe(true);
    expect(isRetryableError(new Error("ThrottlingException"))).toBe(true);
  });

  it("treats HTTP 5xx as retryable", () => {
    expect(isRetryableError({ status: 500 })).toBe(true);
    expect(isRetryableError({ statusCode: 503 })).toBe(true);
    expect(isRetryableError({ status: 599 })).toBe(true);
  });

  it("treats aborts / timeouts as retryable", () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    expect(isRetryableError(abort)).toBe(true);
    const timeout = new Error("request timed out");
    timeout.name = "TimeoutError";
    expect(isRetryableError(timeout)).toBe(true);
  });

  it("treats network errors as retryable", () => {
    expect(isRetryableError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))).toBe(true);
    expect(isRetryableError(Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }))).toBe(true);
    expect(isRetryableError(new TypeError("fetch failed"))).toBe(true);
    expect(isRetryableError(new Error("socket hang up"))).toBe(true);
  });

  it("treats non-retryable 4xx / validation as NOT retryable", () => {
    expect(isThrottleError({ status: 400 })).toBe(false);
    expect(isRetryableError({ status: 400 })).toBe(false);
    expect(isRetryableError({ status: 403 })).toBe(false);
    expect(isRetryableError(new Error("ValidationException: bad input"))).toBe(false);
  });
});

describe("generateWithRetry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the real draft after a transient 5xx then success", async () => {
    let calls = 0;
    const generate = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("Service Unavailable"), { status: 503 });
      return "real draft";
    });

    vi.useFakeTimers();
    const promise = generateWithRetry(generate, { maxRetries: 4, timeoutMs: 1_000 });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("real draft");
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("retries after a request timeout (hung call) then succeeds", async () => {
    let calls = 0;
    const generate = vi.fn(
      (signal: AbortSignal) =>
        new Promise<string>((resolve, reject) => {
          calls += 1;
          if (calls === 1) {
            signal.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
            return;
          }
          resolve("draft after timeout");
        }),
    );

    vi.useFakeTimers();
    const promise = generateWithRetry(generate, { maxRetries: 4, timeoutMs: 1_000 });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("draft after timeout");
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("throws immediately on a non-retryable 4xx without retrying", async () => {
    const generate = vi.fn(async () => {
      throw Object.assign(new Error("ValidationException"), { status: 400 });
    });

    await expect(
      generateWithRetry(generate, { maxRetries: 4, timeoutMs: 1_000 }),
    ).rejects.toThrow(/ValidationException/);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("throws (fail-loud) after the retry budget is exhausted", async () => {
    const generate = vi.fn(async () => {
      throw Object.assign(new Error("Internal Server Error"), { status: 500 });
    });

    vi.useFakeTimers();
    const promise = generateWithRetry(generate, { maxRetries: 2, timeoutMs: 1_000 });
    const assertion = expect(promise).rejects.toThrow(/Internal Server Error/);
    await vi.runAllTimersAsync();
    await assertion;
    expect(generate).toHaveBeenCalledTimes(3);
  });
});
