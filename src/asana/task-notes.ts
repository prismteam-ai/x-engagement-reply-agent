import type { SoofiArticleSimilarity } from "@/matching/article-similarity";
import { buildXReplyIntentUrl } from "@/asana/compose-link";

export type NotePost = {
  statusId: string;
  sourceUri: string;
  text: string;
  contentType: "post" | "article";
  contentCreatedAt?: string;
};

export type SuggestedResponse = {
  promptIndex: number;
  promptLabel: string;
  prompt?: string;
  text: string;
};

export type ArticleRecommendation = SoofiArticleSimilarity & {
  whyRecommended?: string;
  supportingParagraphs?: string[];
  suggestedResponses?: SuggestedResponse[];
};

export function buildAsanaSimilarityTaskNotes(params: {
  post: NotePost;
  topSimilarArticles: ArticleRecommendation[];
  asanaTaskSimilarityThreshold: number;
  articleSimilarityThreshold: number;
  bestCandidateRawScore?: number | null;
}): string {
  const { post, topSimilarArticles } = params;

  const lines: string[] = [
    "Source post/article:",
    post.sourceUri || "(none)",
    "",
    `Source status ID: ${post.statusId || "(none)"}`,
    `Type: ${post.contentType}`,
    ...(post.contentCreatedAt ? [`Posted At: ${post.contentCreatedAt}`] : []),
    "",
    `Task creation threshold (raw similarity): ${params.asanaTaskSimilarityThreshold.toFixed(4)}`,
    `Recommendation threshold (raw similarity): ${params.articleSimilarityThreshold.toFixed(4)}`,
    params.bestCandidateRawScore !== undefined && params.bestCandidateRawScore !== null
      ? `Best article match before thresholding: ${params.bestCandidateRawScore.toFixed(4)}`
      : "Best article match before thresholding: (none)",
    "",
    "Top similar Soofi Safavi articles (similarity score: raw + 1-100):",
  ];

  if (topSimilarArticles.length === 0) {
    lines.push("- none met the similarity threshold");
  } else {
    for (const [index, row] of topSimilarArticles.entries()) {
      lines.push(`${index + 1}. [raw=${row.rawScore.toFixed(4)} | score=${row.score}] ${row.title}`);
      lines.push(`   ${row.sourceUri}`);
      if (row.whyRecommended) {
        lines.push(`   Why recommended: ${row.whyRecommended}`);
      }
      if (row.suggestedResponses && row.suggestedResponses.length > 0) {
        lines.push("   Suggested Soofi responses:");
        for (const responseRow of row.suggestedResponses) {
          lines.push(`   - ${responseRow.promptLabel}: ${responseRow.text}`);
        }
      }
    }
  }

  return lines.join("\n");
}

export function buildAsanaRecommendationSubtaskNotes(params: {
  recommendation: ArticleRecommendation;
  post: NotePost;
  response: SuggestedResponse;
}): string {
  const { recommendation, post, response } = params;
  const isFailurePlaceholder = response.text.startsWith("LLM generation failed");
  const composeUrl = buildXReplyIntentUrl({
    statusId: post.statusId,
    text: isFailurePlaceholder ? "" : response.text,
  });

  return [
    "Approval action:",
    "Approve this task when the drafted reply is ready for manual posting.",
    "",
    "Source post/article:",
    post.sourceUri || "(none)",
    "",
    "Source status ID:",
    post.statusId || "(none)",
    "",
    "Prompt:",
    response.promptLabel,
    response.prompt || "(none)",
    "",
    "Draft response:",
    response.text || "(none)",
    ...(composeUrl ? ["", "Open in X:", composeUrl] : []),
    "",
    "Why recommended:",
    recommendation.whyRecommended || "(none)",
    "",
    ...(recommendation.supportingParagraphs && recommendation.supportingParagraphs.length
      ? [
          "Supporting article passages:",
          ...recommendation.supportingParagraphs.map((row) => `- ${row}`),
          "",
        ]
      : []),
    "Soofi article:",
    recommendation.title || "(untitled)",
    recommendation.sourceUri || "(no source)",
    "",
    `Similarity: raw=${recommendation.rawScore.toFixed(4)} | score=${recommendation.score}`,
  ].join("\n");
}
