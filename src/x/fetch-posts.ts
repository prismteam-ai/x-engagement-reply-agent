import type { Settings } from "@/config/load-settings";
import type { WatchAuthor } from "@/config/load-watchlist";
import type { FetchPostsResult, InputPost } from "@/pipeline/run-monitor";
import {
  buildHeuristicInteractionFromText,
  buildInteractionFromTweet,
  mergeReferencedStatuses,
  parseStatusLinksFromText,
  type XApiTweetLike,
} from "@/x/parse-post";
import { logRuntime } from "@/observability/logger";
import { resolvePositiveIntEnv, runWithRetry } from "@/agent/retry";

export type RuntimeEnv = Record<string, string | undefined>;

export const X_API_BASE_URL = "https://api.twitter.com/2";

export function isXPollerConfigured(env: RuntimeEnv = process.env): boolean {
  return Boolean((env.X_BEARER_TOKEN ?? "").trim());
}

type XApiUser = { id?: string; username?: string; name?: string };

type FetchImpl = typeof fetch;

export type CreateXPollerOptions = {
  env?: RuntimeEnv;
  fetch?: FetchImpl;
  baseUrl?: string;
  maxResultsPerAuthor?: number;
  getCursor?: (handle: string) => Promise<string | null>;
};

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, accept: "application/json" };
}

function isFallbackStatus(status: number): boolean {
  return status === 401 || status === 402 || status === 403 || status === 429;
}

export const DEFAULT_X_MAX_RETRIES = 3;
export const DEFAULT_X_REQUEST_TIMEOUT_MS = 15_000;

export function resolveXMaxRetries(env: RuntimeEnv = process.env): number {
  return resolvePositiveIntEnv(env, "X_MAX_RETRIES", DEFAULT_X_MAX_RETRIES, { minimum: 0 });
}

export function resolveXRequestTimeoutMs(env: RuntimeEnv = process.env): number {
  return resolvePositiveIntEnv(env, "X_REQUEST_TIMEOUT_MS", DEFAULT_X_REQUEST_TIMEOUT_MS);
}

class TransientHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`X API transient http ${status}`);
    this.status = status;
  }
}

type FetchWithRetryOptions = { maxRetries: number; timeoutMs: number };

function createTransientFetch(
  fetchImpl: FetchImpl,
  options: FetchWithRetryOptions,
): (url: string, init: RequestInit) => Promise<Response> {
  return (url, init) =>
    runWithRetry(async (signal) => {
      const res = await fetchImpl(url, { ...init, signal });
      if (res.status >= 500 && res.status <= 599) {
        throw new TransientHttpError(res.status);
      }
      return res;
    }, options);
}

export function tweetToInputPost(params: {
  tweet: XApiTweetLike;
  author: WatchAuthor;
}): InputPost | null {
  const { tweet, author } = params;
  const statusId = String(tweet.id ?? "").trim();
  if (!statusId) return null;

  const baseText = String(tweet.text ?? "");
  const noteTweet =
    tweet.note_tweet && typeof tweet.note_tweet === "object"
      ? (tweet.note_tweet as { text?: unknown })
      : null;
  const noteText = String(noteTweet?.text ?? "").trim();
  const isLongForm = noteText.length > baseText.trim().length;
  const text = isLongForm ? noteText : baseText;
  const contentType: "post" | "article" = isLongForm ? "article" : "post";

  const handle = author.handle.replace(/^@/, "").toLowerCase();
  const sourceUri = `https://x.com/${handle}/status/${statusId}`;

  const textRefs = parseStatusLinksFromText(text);
  const referencedFromApi = Array.isArray(tweet.referenced_tweets)
    ? tweet.referenced_tweets
        .map((row) => ({ statusId: String(row?.id ?? "").trim() }))
        .filter((row) => row.statusId)
    : [];
  const referencedStatuses = mergeReferencedStatuses([...textRefs, ...referencedFromApi]);

  const interaction =
    Array.isArray(tweet.referenced_tweets) && tweet.referenced_tweets.length > 0
      ? buildInteractionFromTweet(tweet, referencedStatuses)
      : buildHeuristicInteractionFromText(text, referencedStatuses);

  const createdAt = String((tweet as { created_at?: unknown }).created_at ?? "").trim();

  return {
    statusId,
    sourceUri,
    text,
    author: author.author,
    handle,
    contentType,
    ...(createdAt ? { contentCreatedAt: createdAt, date: createdAt } : {}),
    ...(referencedStatuses.length ? { referencedStatuses } : {}),
    ...(interaction ? { interaction } : {}),
  };
}

function clampMaxResults(value: number): number {
  if (!Number.isFinite(value)) return 5;
  if (value < 5) return 5;
  if (value > 100) return 100;
  return Math.floor(value);
}

export function createXPoller(
  options: CreateXPollerOptions = {},
): (params: {
  watchlist: WatchAuthor[];
  settings: Settings;
  posts: InputPost[];
}) => Promise<FetchPostsResult> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = options.baseUrl ?? X_API_BASE_URL;
  const token = (env.X_BEARER_TOKEN ?? "").trim();
  const transientFetch = createTransientFetch(fetchImpl, {
    maxRetries: resolveXMaxRetries(env),
    timeoutMs: resolveXRequestTimeoutMs(env),
  });

  return async ({ watchlist, settings, posts }): Promise<FetchPostsResult> => {
    const fallback = (reason: string, status?: number): FetchPostsResult => {
      logRuntime({
        level: "warn",
        message: "X poller falling back to injected posts.",
        reason,
        ...(status ? { status } : {}),
        injectedPosts: posts.length,
      });
      return { posts, organic: false };
    };

    if (!token) return fallback("X_BEARER_TOKEN not set");

    const handles = watchlist
      .map((a) => a.handle.replace(/^@/, "").trim())
      .filter(Boolean);
    if (handles.length === 0) return fallback("empty watchlist");

    const byHandle = new Map<string, WatchAuthor>(
      watchlist.map((a) => [a.handle.replace(/^@/, "").toLowerCase(), a]),
    );
    const maxResults = clampMaxResults(
      options.maxResultsPerAuthor ?? settings.defaultMaxPostsPerAuthor,
    );

    let users: XApiUser[] = [];
    try {
      const url = `${baseUrl}/users/by?usernames=${encodeURIComponent(handles.slice(0, 100).join(","))}`;
      const res = await transientFetch(url, { headers: authHeaders(token) });
      if (isFallbackStatus(res.status)) {
        return fallback("user lookup rejected", res.status);
      }
      if (!res.ok) return fallback(`user lookup http ${res.status}`, res.status);
      const json = (await res.json()) as { data?: XApiUser[] };
      users = Array.isArray(json.data) ? json.data : [];
    } catch (error) {
      return fallback(`user lookup error: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (users.length === 0) return fallback("no users resolved");

    const collected: InputPost[] = [];
    for (const user of users) {
      const userId = String(user.id ?? "").trim();
      const username = String(user.username ?? "").toLowerCase();
      const author = byHandle.get(username);
      if (!userId || !author) continue;

      try {
        let sinceId = "";
        if (options.getCursor) {
          try {
            sinceId = (await options.getCursor(username)) ?? "";
          } catch (error) {
            logRuntime({
              level: "warn",
              message: "Polling cursor read failed; polling full recent timeline.",
              handle: username,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }
        const tweetsUrl =
          `${baseUrl}/users/${userId}/tweets` +
          `?max_results=${maxResults}` +
          `&tweet.fields=${encodeURIComponent("created_at,conversation_id,in_reply_to_user_id,referenced_tweets,note_tweet")}` +
          `&exclude=${encodeURIComponent("retweets")}` +
          (sinceId ? `&since_id=${encodeURIComponent(sinceId)}` : "");
        const res = await transientFetch(tweetsUrl, { headers: authHeaders(token) });
        if (isFallbackStatus(res.status)) {
          logRuntime({
            level: "warn",
            message: "X tweets fetch rate/quota limited.",
            status: res.status,
            handle: username,
          });
          if (collected.length === 0) return fallback("tweets fetch rejected", res.status);
          break;
        }
        if (!res.ok) {
          logRuntime({
            level: "warn",
            message: "X tweets fetch non-OK; skipping author.",
            status: res.status,
            handle: username,
          });
          continue;
        }
        const json = (await res.json()) as { data?: XApiTweetLike[] };
        const tweets = Array.isArray(json.data) ? json.data : [];
        for (const tweet of tweets) {
          const mapped = tweetToInputPost({ tweet, author });
          if (mapped) collected.push(mapped);
        }
      } catch (error) {
        logRuntime({
          level: "warn",
          message: "X tweets fetch error; skipping author.",
          handle: username,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
    }

    if (collected.length === 0) {
      return fallback("no tweets returned (free-tier limits likely)");
    }

    logRuntime({
      level: "info",
      message: "X poller returned live posts.",
      authors: users.length,
      posts: collected.length,
    });
    return { posts: collected, organic: true };
  };
}

export function createReferencedFetcher(
  options: CreateXPollerOptions = {},
): (statusIds: string[]) => Promise<InputPost[]> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = options.baseUrl ?? X_API_BASE_URL;
  const token = (env.X_BEARER_TOKEN ?? "").trim();
  const transientFetch = createTransientFetch(fetchImpl, {
    maxRetries: resolveXMaxRetries(env),
    timeoutMs: resolveXRequestTimeoutMs(env),
  });

  return async (statusIds: string[]): Promise<InputPost[]> => {
    if (!token) return [];
    const ids = Array.from(
      new Set(statusIds.map((id) => String(id ?? "").trim()).filter(Boolean)),
    ).slice(0, 100);
    if (ids.length === 0) return [];

    try {
      const url =
        `${baseUrl}/tweets?ids=${encodeURIComponent(ids.join(","))}` +
        `&tweet.fields=${encodeURIComponent("created_at,conversation_id,in_reply_to_user_id,referenced_tweets,note_tweet,author_id")}` +
        `&expansions=${encodeURIComponent("author_id")}` +
        `&user.fields=${encodeURIComponent("username,name")}`;
      const res = await transientFetch(url, { headers: authHeaders(token) });
      if (!res.ok) {
        logRuntime({
          level: "warn",
          message: "Referenced-tweet fetch non-OK; skipping enrichment.",
          status: res.status,
        });
        return [];
      }
      const json = (await res.json()) as {
        data?: XApiTweetLike[];
        includes?: { users?: XApiUser[] };
      };
      const tweets = Array.isArray(json.data) ? json.data : [];
      const usersById = new Map<string, XApiUser>(
        (json.includes?.users ?? []).map((u) => [String(u.id ?? "").trim(), u]),
      );

      const out: InputPost[] = [];
      for (const tweet of tweets) {
        const authorId = String((tweet as { author_id?: unknown }).author_id ?? "").trim();
        const user = usersById.get(authorId);
        const username = String(user?.username ?? "").toLowerCase().trim();
        const displayName = String(user?.name ?? "").trim();
        const mapped = tweetToInputPost({
          tweet,
          author: {
            author: displayName || username || "(referenced author)",
            handle: username || authorId,
            aliases: { handles: [], authors: [] },
            active: true,
          },
        });
        if (mapped) out.push(mapped);
      }
      logRuntime({
        level: "info",
        message: "Referenced originals fetched.",
        requested: ids.length,
        resolved: out.length,
      });
      return out;
    } catch (error) {
      logRuntime({
        level: "warn",
        message: "Referenced-tweet fetch error; skipping enrichment.",
        reason: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  };
}
