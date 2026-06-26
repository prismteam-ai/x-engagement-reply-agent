import { z } from "zod";
import type { PostCandidate, ReferencedPost } from "../domain/types.js";
import type { XClient } from "./client.js";
import { createLogger, type Logger } from "../observability/logger.js";

/**
 * Live XClient over the X API v2. Requires X_BEARER_TOKEN. Detects reply/quote
 * references and enriches the referenced original. Article (long-form) bodies
 * are attached when the note_tweet field is present.
 *
 * Endpoints used (read scope):
 *   GET /2/users/by/username/:handle
 *   GET /2/users/:id/tweets
 */
const API_BASE = "https://api.twitter.com/2";

const userSchema = z.object({ data: z.object({ id: z.string(), username: z.string() }) });

const tweetSchema = z.object({
  id: z.string(),
  text: z.string(),
  created_at: z.string().optional(),
  referenced_tweets: z
    .array(z.object({ type: z.string(), id: z.string() }))
    .optional(),
  note_tweet: z.object({ text: z.string() }).optional(),
});

const timelineSchema = z.object({
  data: z.array(tweetSchema).optional(),
  includes: z
    .object({
      tweets: z.array(tweetSchema.extend({ author_id: z.string().optional() })).optional(),
      users: z.array(z.object({ id: z.string(), username: z.string() })).optional(),
    })
    .optional(),
});

export interface LiveXClientOptions {
  bearerToken?: string;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

export class LiveXClient implements XClient {
  private readonly token: string;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly userIdCache = new Map<string, string>();

  constructor(opts: LiveXClientOptions = {}) {
    const token = opts.bearerToken ?? process.env.X_BEARER_TOKEN;
    if (!token) {
      throw new Error("LiveXClient requires X_BEARER_TOKEN (or pass bearerToken).");
    }
    this.token = token;
    this.logger = opts.logger ?? createLogger("x-live");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async fetchAuthorPosts(params: {
    handle: string;
    sinceStatusId?: string;
    maxResults: number;
  }): Promise<PostCandidate[]> {
    const userId = await this.resolveUserId(params.handle);
    const query = new URLSearchParams({
      max_results: String(Math.min(Math.max(params.maxResults, 5), 100)),
      "tweet.fields": "created_at,referenced_tweets,note_tweet",
      expansions: "referenced_tweets.id,referenced_tweets.id.author_id",
      "user.fields": "username",
    });
    if (params.sinceStatusId) query.set("since_id", params.sinceStatusId);

    const json = await this.get(`/users/${userId}/tweets?${query.toString()}`);
    const parsed = timelineSchema.parse(json);
    const includedTweets = new Map(
      (parsed.includes?.tweets ?? []).map((t) => [t.id, t] as const),
    );
    const includedUsers = new Map(
      (parsed.includes?.users ?? []).map((u) => [u.id, u.username] as const),
    );

    return (parsed.data ?? [])
      // Skip pure retweets — they are not the author's own content and only add noise.
      .filter((t) => !(t.referenced_tweets ?? []).some((r) => r.type === "retweeted"))
      .map((t): PostCandidate => {
      const ref = (t.referenced_tweets ?? []).find(
        (r) => r.type === "replied_to" || r.type === "quoted",
      );
      let referencedOriginal: ReferencedPost | undefined;
      if (ref) {
        const orig = includedTweets.get(ref.id);
        const authorHandle = orig?.author_id ? includedUsers.get(orig.author_id) : undefined;
        referencedOriginal = {
          sourceUri: `https://x.com/i/status/${ref.id}`,
          statusId: ref.id,
          relation: ref.type === "quoted" ? "quote" : "reply",
          authorHandle,
          text: orig?.note_tweet?.text ?? orig?.text ?? "",
        };
      }
      const articleBody = t.note_tweet?.text;
      return {
        sourceUri: `https://x.com/${params.handle}/status/${t.id}`,
        statusId: t.id,
        handle: params.handle,
        header: t.text.split("\n")[0]?.slice(0, 120) ?? "",
        text: articleBody ?? t.text,
        createdAt: t.created_at,
        referencedOriginal,
        articleBody,
      };
    });
  }

  private async resolveUserId(handle: string): Promise<string> {
    const key = handle.toLowerCase();
    const cached = this.userIdCache.get(key);
    if (cached) return cached;
    const json = await this.get(`/users/by/username/${encodeURIComponent(handle)}`);
    const { data } = userSchema.parse(json);
    this.userIdCache.set(key, data.id);
    return data.id;
  }

  private async get(path: string): Promise<unknown> {
    const res = await this.fetchImpl(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      throw new Error(`X API ${res.status} for ${path}: ${await res.text()}`);
    }
    return res.json();
  }
}
