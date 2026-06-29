import { describe, expect, it } from "vitest";
import { buildXReplyIntentUrl } from "@/asana/compose-link";

describe("buildXReplyIntentUrl", () => {
  it("builds the exact intent URL shape", () => {
    const url = buildXReplyIntentUrl({ statusId: "123", text: "hello world" });
    expect(url).toBe("https://twitter.com/intent/tweet?in_reply_to=123&text=hello+world");
  });

  it("returns empty string when statusId is missing", () => {
    expect(buildXReplyIntentUrl({ statusId: "", text: "hi" })).toBe("");
  });

  it("returns empty string when text is missing", () => {
    expect(buildXReplyIntentUrl({ statusId: "123", text: "   " })).toBe("");
  });

  it("URL-encodes reserved characters (& # ? =)", () => {
    const url = buildXReplyIntentUrl({
      statusId: "123",
      text: "A&B #tag ?q=1",
    });
    // URLSearchParams encodes spaces as "+", & -> %26, # -> %23, ? -> %3F, = -> %3D
    expect(url).toBe(
      "https://twitter.com/intent/tweet?in_reply_to=123&text=A%26B+%23tag+%3Fq%3D1",
    );
  });

  it("encodes quotes and unicode", () => {
    const url = buildXReplyIntentUrl({
      statusId: "999",
      text: 'I said "truth becomes programmable" — really',
    });
    expect(url).toContain("in_reply_to=999");
    expect(url).toContain("%22truth+becomes+programmable%22");
    // em dash is percent-encoded
    expect(url).toContain("%E2%80%94");
    // round-trips back to the original text
    const parsed = new URL(url);
    expect(parsed.searchParams.get("text")).toBe(
      'I said "truth becomes programmable" — really',
    );
    expect(parsed.searchParams.get("in_reply_to")).toBe("999");
  });

  it("normalizes whitespace in the status id and trims text", () => {
    const url = buildXReplyIntentUrl({ statusId: "  456  ", text: "  hi  " });
    expect(url).toBe("https://twitter.com/intent/tweet?in_reply_to=456&text=hi");
  });
});
