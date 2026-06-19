import { describe, it, expect } from "vitest";
import { LiveXClient } from "../src/x/live-driver.js";

function routedFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (url: string) => {
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("LiveXClient", () => {
  it("requires a bearer token", () => {
    expect(() => new LiveXClient({ bearerToken: "" })).toThrow(/X_BEARER_TOKEN/);
  });

  it("maps tweets to PostCandidates and enriches quoted originals + article body", async () => {
    const fetchImpl = routedFetch({
      "/users/by/username/balajis": { data: { id: "U1", username: "balajis" } },
      "/users/U1/tweets": {
        data: [
          {
            id: "200",
            text: "This is the right framing on stealth addresses.",
            created_at: "2026-06-18T00:00:00.000Z",
            referenced_tweets: [{ type: "quoted", id: "199" }],
          },
          {
            id: "201",
            text: "short header line\nmore body",
            note_tweet: { text: "Long-form article body about on-chain property." },
          },
        ],
        includes: {
          tweets: [{ id: "199", text: "How do privacy-preserving ledgers stay verifiable?", author_id: "U9" }],
          users: [{ id: "U9", username: "someone" }],
        },
      },
    });

    const client = new LiveXClient({ bearerToken: "t", fetchImpl });
    const posts = await client.fetchAuthorPosts({ handle: "balajis", maxResults: 10 });

    expect(posts).toHaveLength(2);

    const quoted = posts[0]!;
    expect(quoted.statusId).toBe("200");
    expect(quoted.sourceUri).toBe("https://x.com/balajis/status/200");
    expect(quoted.referencedOriginal).toMatchObject({
      statusId: "199",
      relation: "quote",
      authorHandle: "someone",
    });
    expect(quoted.referencedOriginal?.text).toContain("verifiable");

    const articlePost = posts[1]!;
    expect(articlePost.header).toBe("short header line");
    expect(articlePost.text).toContain("Long-form article body");
    expect(articlePost.articleBody).toContain("Long-form article body");
  });

  it("filters out pure retweets", async () => {
    const fetchImpl = routedFetch({
      "/users/by/username/balajis": { data: { id: "U1", username: "balajis" } },
      "/users/U1/tweets": {
        data: [
          { id: "300", text: "RT @someone: not my content", referenced_tweets: [{ type: "retweeted", id: "299" }] },
          { id: "301", text: "My own original post about on-chain property." },
        ],
      },
    });
    const client = new LiveXClient({ bearerToken: "t", fetchImpl });
    const posts = await client.fetchAuthorPosts({ handle: "balajis", maxResults: 10 });
    expect(posts.map((p) => p.statusId)).toEqual(["301"]);
  });

  it("passes since_id when a cursor is supplied", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (url: string) => {
      capturedUrl = url;
      if (url.includes("/users/by/username/")) {
        return new Response(JSON.stringify({ data: { id: "U1", username: "balajis" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new LiveXClient({ bearerToken: "t", fetchImpl });
    await client.fetchAuthorPosts({ handle: "balajis", maxResults: 10, sinceStatusId: "150" });
    expect(capturedUrl).toContain("since_id=150");
  });
});
