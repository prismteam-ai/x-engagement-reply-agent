import { describe, expect, it, vi } from "vitest";
import {
  createStubReplyModel,
  enforceQuestionRule,
  generateArticleReplyDrafts,
  type ReplyModel,
} from "@/agent/reply-generation";
import type { PromptBundle, ReplyPromptSlot } from "@/config/load-prompts";
import type { NotePost } from "@/asana/task-notes";
import type { SoofiArticleSimilarity } from "@/matching/article-similarity";

function slot(overrides: Partial<ReplyPromptSlot> & { index: number }): ReplyPromptSlot {
  return {
    index: overrides.index,
    fileName: overrides.fileName ?? `0${overrides.index}-slot.md`,
    label: overrides.label ?? `Slot ${overrides.index}`,
    text: overrides.text ?? "Draft a grounded reply.",
    endsWithQuestion: overrides.endsWithQuestion ?? true,
    frontmatter: overrides.frontmatter ?? {},
  };
}

const prompts: PromptBundle = {
  system: "You draft concise X replies for Soofi Safavi.",
  constraints: "Max 280 chars. Quote a short phrase verbatim. End with a question unless told not to.",
  replies: [
    slot({ index: 1, label: "Recommend and draft" }),
    slot({ index: 2, label: "Agree and extend" }),
    slot({ index: 3, label: "Thesis statement", endsWithQuestion: false }),
  ],
};

const post: NotePost = {
  statusId: "1234567890123456789",
  sourceUri: "https://x.com/exampleauthor/status/1234567890123456789",
  text: "On-chain property records could make ownership verifiable.",
  contentType: "post",
};

const article: SoofiArticleSimilarity = {
  rawScore: 0.82,
  score: 91,
  title: "Programmable Property Truth",
  sourceUri: "https://x.com/i/article/example",
  excerpt: "Truth becomes programmable when property records leave silos and become verifiable.",
  contextExcerpt:
    "Truth becomes programmable when property records leave silos and become verifiable on-chain, removing intermediaries.",
};

describe("enforceQuestionRule", () => {
  it("guarantees a trailing question mark when required", () => {
    expect(enforceQuestionRule("This is a statement.", true)).toMatch(/\?$/);
    expect(enforceQuestionRule("Already asking?", true)).toBe("Already asking?");
  });

  it("strips a trailing question mark when not required", () => {
    expect(enforceQuestionRule("Is this allowed?", false)).not.toMatch(/\?$/);
    expect(enforceQuestionRule("A flat thesis.", false)).toBe("A flat thesis.");
  });

  it("truncates to the 280-char cap while preserving the rule", () => {
    const long = "word ".repeat(100).trim();
    const q = enforceQuestionRule(long, true);
    expect(q.length).toBeLessThanOrEqual(280);
    expect(q).toMatch(/\?$/);
    const noq = enforceQuestionRule(long, false);
    expect(noq.length).toBeLessThanOrEqual(280);
    expect(noq).not.toMatch(/\?$/);
  });

  it("keeps a 281-char period-terminated no-question draft at the cap (regression)", () => {
    // A non-question draft already ending in '.' at exactly 281 chars must not
    // overflow to 281 after the truncation path re-appends a terminal '.'.
    const overflow = `${"a".repeat(280)}.`;
    expect(overflow.length).toBe(281);
    const out = enforceQuestionRule(overflow, false);
    expect(out.length).toBeLessThanOrEqual(280);
    expect(out.endsWith(".")).toBe(true);
  });

  it("keeps a 281-char question draft at the cap", () => {
    const overflow = `${"a".repeat(280)}?`;
    const out = enforceQuestionRule(overflow, true);
    expect(out.length).toBeLessThanOrEqual(280);
    expect(out.endsWith("?")).toBe(true);
  });

  it("never cuts a word mid-token and keeps balanced quotes on a long-quote draft", () => {
    const sentence =
      'On-chain title makes ownership "verifiable end to end" which reframes discovery governance ';
    const draft = `${sentence}${"discovery ".repeat(40)}`;
    expect(draft.length).toBeGreaterThan(300);
    const inputWords = new Set(draft.trim().split(/\s+/));
    for (const endsWithQuestion of [true, false]) {
      const out = enforceQuestionRule(draft, endsWithQuestion);
      expect(out.length).toBeLessThanOrEqual(280);
      const quoteCount = (out.match(/"/g) ?? []).length;
      expect(quoteCount % 2, `expected balanced quotes, got ${quoteCount}: ${out}`).toBe(0);
      const lastWord = out
        .replace(/[.!?]+$/, "")
        .trim()
        .split(/\s+/)
        .pop()!
        .replace(/"+$/, "");
      expect(
        inputWords.has(lastWord),
        `last word "${lastWord}" must be a whole input word, not a mid-word fragment: ${out}`,
      ).toBe(true);
    }
  });

  it("drops a partial trailing quote so truncated output has balanced quotes (long-quote case)", () => {
    const lead = `My work argues "truth becomes programmable" and `.padEnd(250, "x");
    const draft = `${lead} a second quote "${"phrase ".repeat(20)}"`;
    expect(draft.length).toBeGreaterThan(300);
    for (const endsWithQuestion of [true, false]) {
      const out = enforceQuestionRule(draft, endsWithQuestion);
      expect(out.length).toBeLessThanOrEqual(280);
      const quoteCount = (out.match(/"/g) ?? []).length;
      expect(quoteCount % 2, `expected balanced quotes, got ${quoteCount}: ${out}`).toBe(0);
      if (endsWithQuestion) expect(out.endsWith("?")).toBe(true);
      else expect(out.endsWith("?")).toBe(false);
    }
  });
});

describe("generateArticleReplyDrafts with the stub model", () => {
  it("produces exactly one draft per reply slot", async () => {
    const rec = await generateArticleReplyDrafts({
      prompts,
      post,
      article,
      model: createStubReplyModel(),
    });
    expect(rec.suggestedResponses).toBeDefined();
    expect(rec.suggestedResponses).toHaveLength(prompts.replies.length);
    expect(rec.suggestedResponses!.map((r) => r.promptIndex)).toEqual([1, 2, 3]);
  });

  it("grounds each draft in the article with a verbatim quoted phrase", async () => {
    const rec = await generateArticleReplyDrafts({
      prompts,
      post,
      article,
      model: createStubReplyModel(),
    });
    for (const response of rec.suggestedResponses!) {
      // contains a double-quoted phrase
      const quoted = response.text.match(/"([^"]+)"/);
      expect(quoted, `draft ${response.promptIndex} should quote a phrase`).not.toBeNull();
      // the quoted phrase is verbatim from the article context
      const phrase = quoted![1]!;
      const haystack = `${article.contextExcerpt} ${article.excerpt} ${article.title}`;
      expect(haystack.includes(phrase)).toBe(true);
    }
  });

  it("ends question slots with '?' and honors endsWithQuestion:false", async () => {
    const rec = await generateArticleReplyDrafts({
      prompts,
      post,
      article,
      model: createStubReplyModel(),
    });
    const byIndex = new Map(rec.suggestedResponses!.map((r) => [r.promptIndex, r.text]));
    expect(byIndex.get(1)).toMatch(/\?$/);
    expect(byIndex.get(2)).toMatch(/\?$/);
    // slot 3 (Thesis statement) sets endsWithQuestion:false
    expect(byIndex.get(3)).not.toMatch(/\?$/);
  });

  it("respects each draft's 280-char cap", async () => {
    const rec = await generateArticleReplyDrafts({
      prompts,
      post,
      article,
      model: createStubReplyModel(),
    });
    for (const response of rec.suggestedResponses!) {
      expect(response.text.length).toBeLessThanOrEqual(280);
    }
  });

  it("populates whyRecommended for the note builders", async () => {
    const rec = await generateArticleReplyDrafts({
      prompts,
      post,
      article,
      model: createStubReplyModel(),
    });
    expect(typeof rec.whyRecommended).toBe("string");
    expect(rec.whyRecommended!.length).toBeGreaterThan(0);
  });

  it("emits a labelled failure placeholder when a slot's model call throws", async () => {
    const flakyModel: ReplyModel = async ({ slot: s }) => {
      if (s.index === 2) throw new Error("bedrock unavailable");
      return { text: 'Grounded reply "verifiable on-chain".' };
    };
    const rec = await generateArticleReplyDrafts({
      prompts,
      post,
      article,
      model: flakyModel,
    });
    const byIndex = new Map(rec.suggestedResponses!.map((r) => [r.promptIndex, r.text]));
    expect(byIndex.get(2)).toMatch(/^LLM generation failed/);
    expect(byIndex.get(1)).not.toMatch(/^LLM generation failed/);
  });

  it("yields no drafts when there are no reply slots", async () => {
    const noSlots: PromptBundle = { ...prompts, replies: [] };
    const model = vi.fn(createStubReplyModel());
    const rec = await generateArticleReplyDrafts({
      prompts: noSlots,
      post,
      article,
      model,
    });
    expect(rec.suggestedResponses).toEqual([]);
    expect(model).not.toHaveBeenCalled();
  });
});
