import { afterEach, describe, expect, it, vi } from "vitest";
import { createXPoller } from "@/x/fetch-posts";
import { SETTINGS_DEFAULTS, type Settings } from "@/config/load-settings";
import type { WatchAuthor } from "@/config/load-watchlist";
import type { InputPost } from "@/pipeline/run-monitor";

const settings: Settings = {
  ...SETTINGS_DEFAULTS,
  excludeAuthors: [...SETTINGS_DEFAULTS.excludeAuthors],
};

const watchlist: WatchAuthor[] = [
  { author: "Balaji Srinivasan", handle: "balajis", aliases: { handles: [], authors: [] }, active: true },
];

const injected: InputPost[] = [
  {
    statusId: "999",
    sourceUri: "https://x.com/balajis/status/999",
    text: "fixture fallback post",
    author: "Balaji Srinivasan",
    handle: "balajis",
    contentType: "post",
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createXPoller transient retry", () => {
  it("retries a transient 5xx then succeeds (organic)", async () => {
    let lookupCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/users/by")) {
        lookupCalls += 1;
        if (lookupCalls === 1) return jsonResponse({ errors: [] }, 503);
        return jsonResponse({ data: [{ id: "user_1", username: "balajis", name: "Balaji" }] });
      }
      return jsonResponse({ data: [{ id: "1800000000000000010", text: "Tokenized real estate." }] });
    }) as unknown as typeof fetch;

    vi.useFakeTimers();
    const poller = createXPoller({ env: { X_BEARER_TOKEN: "tok" }, fetch: fetchImpl });
    const promise = poller({ watchlist, settings, posts: injected });
    await vi.runAllTimersAsync();
    const result = await promise;
    const posts = Array.isArray(result) ? result : result.posts;
    const organic = Array.isArray(result) ? true : result.organic;

    expect(organic).toBe(true);
    expect(posts).toHaveLength(1);
    expect(lookupCalls).toBe(2);
  });

  it("does NOT retry a 429 — aborts to fallback immediately", async () => {
    let lookupCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/users/by")) {
        lookupCalls += 1;
        return jsonResponse({ errors: [] }, 429);
      }
      return jsonResponse({ data: [] });
    }) as unknown as typeof fetch;

    const poller = createXPoller({ env: { X_BEARER_TOKEN: "tok" }, fetch: fetchImpl });
    const result = await poller({ watchlist, settings, posts: injected });

    expect(result).toEqual({ posts: injected, organic: false });
    expect(lookupCalls).toBe(1);
  });

  it("retries a request timeout then aborts to fallback once the budget is exhausted", async () => {
    let lookupCalls = 0;
    const fetchImpl = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const url = String(input);
          if (url.includes("/users/by")) {
            lookupCalls += 1;
            init?.signal?.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
            return;
          }
          resolve(jsonResponse({ data: [] }));
        }),
    ) as unknown as typeof fetch;

    vi.useFakeTimers();
    const poller = createXPoller({
      env: { X_BEARER_TOKEN: "tok", X_MAX_RETRIES: "2", X_REQUEST_TIMEOUT_MS: "50" },
      fetch: fetchImpl,
    });
    const promise = poller({ watchlist, settings, posts: injected });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ posts: injected, organic: false });
    expect(lookupCalls).toBe(3);
  });
});
