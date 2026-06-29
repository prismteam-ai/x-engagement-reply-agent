import { describe, expect, it } from "vitest";
import {
  buildAsanaRecommendationSubtaskNotes,
  buildAsanaSimilarityTaskNotes,
  type ArticleRecommendation,
  type NotePost,
} from "@/asana/task-notes";

const post: NotePost = {
  statusId: "1234567890123456789",
  sourceUri: "https://x.com/exampleauthor/status/1234567890123456789",
  text: "Example post about decentralized property data.",
  contentType: "post",
  contentCreatedAt: "2026-06-01T00:00:00.000Z",
};

const article: ArticleRecommendation = {
  rawScore: 0.82,
  score: 91,
  title: "Example Soofi Article Title",
  sourceUri: "https://x.com/i/article/example",
  excerpt: "Example excerpt from matched article content.",
  contextExcerpt: "Longer example excerpt from matched article content.",
};

describe("buildAsanaSimilarityTaskNotes", () => {
  it("includes source post meta + thresholds", () => {
    const notes = buildAsanaSimilarityTaskNotes({
      post,
      topSimilarArticles: [article],
      asanaTaskSimilarityThreshold: 0,
      articleSimilarityThreshold: 0.7,
      bestCandidateRawScore: 0.82,
    });
    expect(notes).toContain(post.sourceUri);
    expect(notes).toContain(`Source status ID: ${post.statusId}`);
    expect(notes).toContain("Type: post");
    expect(notes).toContain("Task creation threshold (raw similarity): 0.0000");
    expect(notes).toContain("Recommendation threshold (raw similarity): 0.7000");
    expect(notes).toContain("Best article match before thresholding: 0.8200");
  });

  it("includes per-article provenance and VISIBLE scores (raw + 1-100)", () => {
    const notes = buildAsanaSimilarityTaskNotes({
      post,
      topSimilarArticles: [article],
      asanaTaskSimilarityThreshold: 0,
      articleSimilarityThreshold: 0.7,
    });
    expect(notes).toContain("1. [raw=0.8200 | score=91] Example Soofi Article Title");
    expect(notes).toContain("https://x.com/i/article/example");
  });

  it("includes reply-gen fields when present", () => {
    const notes = buildAsanaSimilarityTaskNotes({
      post,
      topSimilarArticles: [
        {
          ...article,
          whyRecommended: "Same theme of verifiable property data.",
          suggestedResponses: [
            { promptIndex: 1, promptLabel: "Prompt 1", text: "Truth becomes programmable." },
          ],
        },
      ],
      asanaTaskSimilarityThreshold: 0,
      articleSimilarityThreshold: 0.7,
    });
    expect(notes).toContain("Why recommended: Same theme of verifiable property data.");
    expect(notes).toContain("- Prompt 1: Truth becomes programmable.");
  });

  it("notes when no articles met the threshold", () => {
    const notes = buildAsanaSimilarityTaskNotes({
      post,
      topSimilarArticles: [],
      asanaTaskSimilarityThreshold: 0.5,
      articleSimilarityThreshold: 0.7,
      bestCandidateRawScore: null,
    });
    expect(notes).toContain("- none met the similarity threshold");
    expect(notes).toContain("Best article match before thresholding: (none)");
  });
});

describe("buildAsanaRecommendationSubtaskNotes", () => {
  it("includes provenance, visible scores, and the X compose-reply intent URL", () => {
    const notes = buildAsanaRecommendationSubtaskNotes({
      post,
      recommendation: {
        ...article,
        whyRecommended: "Discusses verifiable property data.",
      },
      response: {
        promptIndex: 1,
        promptLabel: "Prompt 1",
        prompt: "Recommend and draft",
        text: 'I\'ve argued "truth becomes programmable" — what changes on-chain?',
      },
    });
    expect(notes).toContain("Soofi article:");
    expect(notes).toContain("Example Soofi Article Title");
    expect(notes).toContain("https://x.com/i/article/example");
    expect(notes).toContain("Similarity: raw=0.8200 | score=91");
    expect(notes).toContain("Why recommended:");
    expect(notes).toContain("Open in X:");
    expect(notes).toContain(`https://twitter.com/intent/tweet?in_reply_to=${post.statusId}`);
    // draft text is reflected in the note
    expect(notes).toContain('I\'ve argued "truth becomes programmable" — what changes on-chain?');
  });

  it("omits the compose URL for an LLM-failure placeholder draft", () => {
    const notes = buildAsanaRecommendationSubtaskNotes({
      post,
      recommendation: article,
      response: {
        promptIndex: 1,
        promptLabel: "Prompt 1",
        text: "LLM generation failed: timeout",
      },
    });
    expect(notes).not.toContain("Open in X:");
  });

  it("renders supporting passages when present", () => {
    const notes = buildAsanaRecommendationSubtaskNotes({
      post,
      recommendation: {
        ...article,
        supportingParagraphs: ["passage one", "passage two"],
      },
      response: { promptIndex: 1, promptLabel: "Prompt 1", text: "draft" },
    });
    expect(notes).toContain("Supporting article passages:");
    expect(notes).toContain("- passage one");
    expect(notes).toContain("- passage two");
  });
});
