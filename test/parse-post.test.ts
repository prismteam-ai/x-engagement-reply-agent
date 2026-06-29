import { describe, expect, it } from "vitest";
import {
  buildHeuristicInteractionFromText,
  buildInteractionFromTweet,
  buildPostDedupeKey,
  dedupeKeyForPost,
  extractStatusId,
  handleFromText,
  mergeReferencedStatuses,
  parseStatusLinksFromText,
  referencedStatusDedupeKeys,
  type ParsedPost,
} from "@/x/parse-post";

describe("handleFromText", () => {
  it("strips @, whitespace and lowercases", () => {
    expect(handleFromText("@Soofi_Safavi")).toBe("soofi_safavi");
    expect(handleFromText("  @cdixon ")).toBe("cdixon");
  });
});

describe("extractStatusId", () => {
  it("extracts the numeric id from a status URL", () => {
    expect(extractStatusId("https://x.com/cdixon/status/1234567890123456789")).toBe(
      "1234567890123456789",
    );
  });
  it("returns null when no status id is present", () => {
    expect(extractStatusId("https://x.com/i/article/abc")).toBeNull();
  });
});

describe("parseStatusLinksFromText", () => {
  it("finds x.com and twitter.com status links with handles", () => {
    const refs = parseStatusLinksFromText(
      "see https://x.com/alice/status/111 and twitter.com/bob/status/222",
    );
    expect(refs).toEqual([
      { statusId: "111", handle: "alice" },
      { statusId: "222", handle: "bob" },
    ]);
  });
  it("dedupes repeated status ids", () => {
    const refs = parseStatusLinksFromText(
      "https://x.com/a/status/111 https://x.com/a/status/111",
    );
    expect(refs).toHaveLength(1);
  });
});

describe("mergeReferencedStatuses", () => {
  it("merges by id, filling in a missing handle", () => {
    const merged = mergeReferencedStatuses([
      { statusId: "111" },
      { statusId: "111", handle: "Alice" },
      { statusId: "222", handle: "Bob" },
    ]);
    expect(merged).toEqual([
      { statusId: "111", handle: "alice" },
      { statusId: "222", handle: "bob" },
    ]);
  });
});

describe("buildInteractionFromTweet — interaction type detection", () => {
  it("detects an original post (no referenced tweets)", () => {
    const i = buildInteractionFromTweet({ id: "1", text: "hello world" });
    expect(i.type).toBe("original");
    expect(i.detectionMethod).toBe("x_api_metadata");
    expect(i.parentStatusId).toBeUndefined();
  });

  it("detects a reply and captures the parent status id", () => {
    const i = buildInteractionFromTweet({
      id: "10",
      in_reply_to_user_id: "999",
      conversation_id: "777",
      referenced_tweets: [{ id: "555", type: "replied_to" }],
    });
    expect(i.type).toBe("reply");
    expect(i.parentStatusId).toBe("555");
    expect(i.inReplyToUserId).toBe("999");
    expect(i.conversationId).toBe("777");
    expect(i.referencedStatusIds).toContain("555");
  });

  it("detects a quote", () => {
    const i = buildInteractionFromTweet({
      id: "20",
      referenced_tweets: [{ id: "666", type: "quoted" }],
    });
    expect(i.type).toBe("quote");
    expect(i.parentStatusId).toBe("666");
  });

  it("detects a repost (retweet)", () => {
    const i = buildInteractionFromTweet({
      id: "30",
      referenced_tweets: [{ id: "888", type: "retweeted" }],
    });
    expect(i.type).toBe("repost");
    expect(i.parentStatusId).toBe("888");
  });

  it("prefers reply when multiple referenced tweets exist", () => {
    const i = buildInteractionFromTweet({
      id: "40",
      referenced_tweets: [
        { id: "101", type: "quoted" },
        { id: "102", type: "replied_to" },
      ],
    });
    expect(i.type).toBe("reply");
    expect(i.parentStatusId).toBe("102");
    expect(i.referencedStatusIds).toEqual(["101", "102"]);
  });

  it("resolves parent handle from referencedStatuses hint", () => {
    const i = buildInteractionFromTweet(
      { id: "50", referenced_tweets: [{ id: "201", type: "replied_to" }] },
      [{ statusId: "201", handle: "Soofi" }],
    );
    expect(i.parentAuthorHandle).toBe("soofi");
  });
});

describe("buildHeuristicInteractionFromText", () => {
  it("returns undefined for plain original text with no refs or mentions", () => {
    expect(buildHeuristicInteractionFromText("just thinking out loud", [])).toBeUndefined();
  });

  it("treats text with an @mention but no status link as original", () => {
    const i = buildHeuristicInteractionFromText("hey @cdixon what do you think", []);
    expect(i?.type).toBe("original");
    expect(i?.detectionMethod).toBe("heuristic");
  });

  it("treats a referenced status as an unknown interaction with parent id", () => {
    const i = buildHeuristicInteractionFromText("re: this", [
      { statusId: "303", handle: "alice" },
    ]);
    expect(i?.type).toBe("unknown");
    expect(i?.parentStatusId).toBe("303");
    expect(i?.parentAuthorHandle).toBe("alice");
    expect(i?.referencedStatusIds).toEqual(["303"]);
  });
});

describe("dedupe keys", () => {
  it("buildPostDedupeKey lowercases the source URI and keeps the status id", () => {
    expect(
      buildPostDedupeKey({ sourceUri: "https://X.com/a/STATUS/111", statusId: "111" }),
    ).toBe("https://x.com/a/status/111|111");
  });

  it("dedupeKeyForPost works off a post-like object", () => {
    const post = { sourceUri: "https://x.com/a/status/111", statusId: "111" };
    expect(dedupeKeyForPost(post)).toBe("https://x.com/a/status/111|111");
  });

  it("referencedStatusDedupeKeys excludes the post's own status id and dedupes", () => {
    const post: ParsedPost = {
      statusId: "111",
      sourceUri: "https://x.com/a/status/111",
      text: "",
      header: "",
      date: "",
      contentCreatedAt: "",
      contentType: "post",
      canonicalSource: true,
      referencedStatuses: [{ statusId: "222" }, { statusId: "111" }],
      interaction: {
        type: "reply",
        referencedStatusIds: ["222", "333"],
        detectionMethod: "x_api_metadata",
      },
    };
    const keys = referencedStatusDedupeKeys(post);
    expect(keys).toEqual([
      "https://x.com/a/status/111|222",
      "https://x.com/a/status/111|333",
    ]);
    expect(keys).not.toContain("https://x.com/a/status/111|111");
  });
});
