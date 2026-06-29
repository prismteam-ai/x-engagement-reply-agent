import { afterEach, describe, expect, it, vi } from "vitest";
import { createXPoller, isXPollerConfigured, tweetToInputPost } from "@/x/fetch-posts";
import { SETTINGS_DEFAULTS, type Settings } from "@/config/load-settings";
import type { WatchAuthor } from "@/config/load-watchlist";
import type { InputPost } from "@/pipeline/run-monitor";

/**
 * Unit tests for the live X poller with a MOCKED fetch. No network. Asserts the
 * tweets→InputPost mapping and the GRACEFUL fallback contract (401/403/429 →
 * injected posts, never a throw).
 */

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
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("tweetToInputPost", () => {
  it("maps an X API v2 tweet to the InputPost shape", () => {
    const post = tweetToInputPost({
      tweet: {
        id: "1800000000000000001",
        text: "On-chain title is the future.",
        created_at: "2026-06-20T10:00:00.000Z",
      },
      author: watchlist[0]!,
    });
    expect(post).not.toBeNull();
    expect(post!.statusId).toBe("1800000000000000001");
    expect(post!.sourceUri).toBe("https://x.com/balajis/status/1800000000000000001");
    expect(post!.text).toBe("On-chain title is the future.");
    expect(post!.author).toBe("Balaji Srinivasan");
    expect(post!.handle).toBe("balajis");
    expect(post!.contentCreatedAt).toBe("2026-06-20T10:00:00.000Z");
  });

  it("detects a reply interaction from referenced_tweets", () => {
    const post = tweetToInputPost({
      tweet: {
        id: "1800000000000000002",
        text: "Replying to a thread.",
        referenced_tweets: [{ id: "1700000000000000000", type: "replied_to" }],
        in_reply_to_user_id: "42",
      },
      author: watchlist[0]!,
    });
    expect(post!.interaction?.type).toBe("reply");
    expect(post!.interaction?.parentStatusId).toBe("1700000000000000000");
    expect(post!.referencedStatuses?.[0]?.statusId).toBe("1700000000000000000");
  });

  it("returns null for a tweet with no id", () => {
    expect(tweetToInputPost({ tweet: { text: "no id" }, author: watchlist[0]! })).toBeNull();
  });
});

describe("createXPoller (mocked fetch)", () => {
  it("returns live posts: user lookup → recent tweets → InputPost[]", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/users/by")) {
        return jsonResponse({ data: [{ id: "user_1", username: "balajis", name: "Balaji" }] });
      }
      if (url.includes("/users/user_1/tweets")) {
        return jsonResponse({
          data: [
            { id: "1800000000000000010", text: "Tokenized real estate.", created_at: "2026-06-21T00:00:00Z" },
            { id: "1800000000000000011", text: "Verifiable property records." },
          ],
        });
      }
      return jsonResponse({ data: [] });
    }) as unknown as typeof fetch;

    const poller = createXPoller({ env: { X_BEARER_TOKEN: "tok" }, fetch: fetchImpl });
    const result = await poller({ watchlist, settings, posts: injected });
    const posts = Array.isArray(result) ? result : result.posts;
    const organic = Array.isArray(result) ? true : result.organic;

    expect(organic).toBe(true);
    expect(posts).toHaveLength(2);
    expect(posts[0]!.statusId).toBe("1800000000000000010");
    expect(posts[0]!.handle).toBe("balajis");
    expect(posts[0]!.sourceUri).toContain("/status/1800000000000000010");
  });

  it("sends the bearer token in the Authorization header", async () => {
    let authHeader: string | null = null;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      authHeader = new Headers(init?.headers).get("authorization");
      const url = String(input);
      if (url.includes("/users/by")) {
        return jsonResponse({ data: [{ id: "user_1", username: "balajis" }] });
      }
      return jsonResponse({ data: [{ id: "1", text: "hi" }] });
    }) as unknown as typeof fetch;

    const poller = createXPoller({ env: { X_BEARER_TOKEN: "secret-token" }, fetch: fetchImpl });
    await poller({ watchlist, settings, posts: injected });
    expect(authHeader).toBe("Bearer secret-token");
  });

  it.each([401, 402, 403, 429])(
    "falls back to injected posts on HTTP %i (no throw)",
    async (status) => {
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/users/by")) return jsonResponse({ errors: [] }, status);
        return jsonResponse({ data: [] });
      }) as unknown as typeof fetch;

      const poller = createXPoller({ env: { X_BEARER_TOKEN: "tok" }, fetch: fetchImpl });
      const result = await poller({ watchlist, settings, posts: injected });
      expect(result).toEqual({ posts: injected, organic: false });
    },
  );

  it("falls back when tweets fetch is rate-limited (429) with nothing collected", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/users/by")) {
        return jsonResponse({ data: [{ id: "user_1", username: "balajis" }] });
      }
      return jsonResponse({ errors: [] }, 429);
    }) as unknown as typeof fetch;

    const poller = createXPoller({ env: { X_BEARER_TOKEN: "tok" }, fetch: fetchImpl });
    const result = await poller({ watchlist, settings, posts: injected });
    expect(result).toEqual({ posts: injected, organic: false });
  });

  it("falls back (no throw) when fetch itself rejects", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    vi.useFakeTimers();
    const poller = createXPoller({ env: { X_BEARER_TOKEN: "tok" }, fetch: fetchImpl });
    const promise = poller({ watchlist, settings, posts: injected });
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();
    expect(result).toEqual({ posts: injected, organic: false });
  });

  it("falls back when X_BEARER_TOKEN is absent (never calls fetch)", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const poller = createXPoller({ env: {}, fetch: fetchImpl });
    const result = await poller({ watchlist, settings, posts: injected });
    expect(result).toEqual({ posts: injected, organic: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("falls back to empty when no posts are injected and X fails", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ errors: [] }, 401)) as unknown as typeof fetch;
    const poller = createXPoller({ env: { X_BEARER_TOKEN: "tok" }, fetch: fetchImpl });
    const result = await poller({ watchlist, settings, posts: [] });
    expect(result).toEqual({ posts: [], organic: false });
  });
});

describe("isXPollerConfigured", () => {
  it("is true only when X_BEARER_TOKEN is present", () => {
    expect(isXPollerConfigured({ X_BEARER_TOKEN: "x" })).toBe(true);
    expect(isXPollerConfigured({})).toBe(false);
    expect(isXPollerConfigured({ X_BEARER_TOKEN: "  " })).toBe(false);
  });
});
