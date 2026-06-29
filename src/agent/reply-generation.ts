import type {
  ArticleRecommendation,
  NotePost,
  SuggestedResponse,
} from "@/asana/task-notes";
import type { SoofiArticleSimilarity } from "@/matching/article-similarity";
import type { PromptBundle, ReplyPromptSlot } from "@/config/load-prompts";

function normalizeWhitespace(value: string): string {
  return String(value ?? "").replace(/\r/g, "").replace(/\s+/g, " ").trim();
}

export const MAX_REPLY_LENGTH = 280;
export const MAX_WHY_RECOMMENDED_LENGTH = 300;

export type ReplyModelInput = {
  system: string;
  constraints: string;
  post: NotePost;
  article: SoofiArticleSimilarity;
  slot: ReplyPromptSlot;
  supportingParagraphs: string[];
};

export type ReplyModelOutput = {
  text: string;
  whyRecommended?: string;
};

export type ReplyModel = (input: ReplyModelInput) => Promise<ReplyModelOutput>;

export type GenerateArticleReplyDraftsParams = {
  prompts: PromptBundle;
  post: NotePost;
  article: SoofiArticleSimilarity;
  model: ReplyModel;
  supportingParagraphs?: string[];
};

function pickQuotedPhrase(article: SoofiArticleSimilarity): string {
  const source = normalizeWhitespace(
    article.contextExcerpt || article.excerpt || article.title || "",
  );
  if (!source) return "verifiable on-chain";
  const words = source.split(" ").filter(Boolean);
  const phrase = words.slice(0, 6).join(" ");
  return phrase || source.slice(0, 48);
}

export function enforceQuestionRule(text: string, endsWithQuestion: boolean): string {
  let out = normalizeWhitespace(text);
  if (!out) return out;

  if (endsWithQuestion) {
    if (!out.endsWith("?")) {
      out = out.replace(/[.!]+$/, "");
      out = `${out}?`;
    }
  } else {
    if (out.endsWith("?")) {
      out = out.replace(/\?+$/, "").trimEnd();
      if (out && !/[.!]$/.test(out)) out = `${out}.`;
    }
  }

  if (out.length <= MAX_REPLY_LENGTH) return out;

  const tail = endsWithQuestion ? "?" : ".";
  const budget = MAX_REPLY_LENGTH - tail.length;
  let truncated = truncateAtWordBoundary(out, budget);
  truncated = dropUnbalancedTrailingQuote(truncated);
  truncated = truncated.replace(/[.!?]+$/, "").trimEnd();
  return `${truncated}${tail}`;
}

function truncateAtWordBoundary(value: string, budget: number): string {
  if (value.length <= budget) return value.trimEnd();
  const isMidWord = !/\s/.test(value.charAt(budget)) && !/\s/.test(value.charAt(budget - 1));
  const sliced = value.slice(0, budget);
  if (!isMidWord) return sliced.trimEnd();
  const lastSpace = sliced.lastIndexOf(" ");
  if (lastSpace <= 0) return sliced.trimEnd();
  return sliced.slice(0, lastSpace).trimEnd();
}

function countDoubleQuotes(value: string): number {
  let count = 0;
  for (const char of value) {
    if (char === '"') count += 1;
  }
  return count;
}

function dropUnbalancedTrailingQuote(value: string): string {
  if (countDoubleQuotes(value) % 2 === 0) return value;
  return value.slice(0, value.lastIndexOf('"')).trimEnd();
}

function verbatimRepairPhrase(article: SoofiArticleSimilarity): string {
  const source = normalizeWhitespace(
    article.contextExcerpt || article.excerpt || article.title || "",
  );
  if (!source) return "";
  const words = source.split(" ").filter(Boolean);
  const phrase = words.slice(0, 6).join(" ");
  return phrase || source.slice(0, 48);
}

export function enforceQuotedPhraseRule(
  text: string,
  article: SoofiArticleSimilarity,
): { text: string; repaired: boolean } {
  const out = normalizeWhitespace(text);
  if (!out) return { text: out, repaired: false };

  const grounding = normalizeWhitespace(
    [article.contextExcerpt, article.excerpt, article.title].filter(Boolean).join(" "),
  ).toLowerCase();

  const quotedSpans = Array.from(out.matchAll(/"([^"]+)"/g)).map((m) =>
    normalizeWhitespace(m[1] ?? ""),
  );
  const hasGenuineQuote = quotedSpans.some(
    (span) => span.length > 0 && grounding.includes(span.toLowerCase()),
  );
  if (hasGenuineQuote) return { text: out, repaired: false };

  const repair = verbatimRepairPhrase(article);
  if (!repair) return { text: out, repaired: false };
  const stripped = normalizeWhitespace(out.replace(/"[^"]*"/g, "").replace(/\s+([.!?])/g, "$1"));
  const base = stripped || out;
  const joined = /[.!?]$/.test(base) ? `${base} As I put it, "${repair}".` : `${base}. As I put it, "${repair}".`;
  return { text: normalizeWhitespace(joined), repaired: true };
}

export async function generateArticleReplyDrafts(
  params: GenerateArticleReplyDraftsParams,
): Promise<ArticleRecommendation> {
  const { prompts, post, article, model } = params;
  const supportingParagraphs = (params.supportingParagraphs ?? []).filter(Boolean);

  const slots = prompts.replies;
  let whyRecommended = "";

  const suggestedResponses: SuggestedResponse[] = await Promise.all(
    slots.map(async (slot): Promise<SuggestedResponse> => {
      const base = {
        promptIndex: slot.index,
        promptLabel: slot.label,
        prompt: slot.text,
      };
      try {
        const output = await model({
          system: prompts.system,
          constraints: prompts.constraints,
          post,
          article,
          slot,
          supportingParagraphs,
        });
        const quoted = enforceQuotedPhraseRule(output.text, article);
        const text = enforceQuestionRule(quoted.text, slot.endsWithQuestion);
        if (!whyRecommended && output.whyRecommended) {
          whyRecommended = normalizeWhitespace(output.whyRecommended).slice(
            0,
            MAX_WHY_RECOMMENDED_LENGTH,
          );
        }
        if (!text) {
          return {
            ...base,
            text: `LLM generation failed for ${slot.label.toLowerCase()}: empty model output.`,
          };
        }
        return { ...base, text };
      } catch (error) {
        const reason = normalizeWhitespace(
          error instanceof Error ? error.message : String(error),
        );
        return {
          ...base,
          text: `LLM generation failed for ${slot.label.toLowerCase()}: ${reason}.`,
        };
      }
    }),
  );

  if (!whyRecommended) {
    whyRecommended =
      "This article is one of the closest thematic matches to the source post and offers reusable framing for a reply.";
  }

  return {
    ...article,
    whyRecommended,
    ...(supportingParagraphs.length ? { supportingParagraphs } : {}),
    suggestedResponses,
  };
}

export function createStubReplyModel(): ReplyModel {
  return async (input: ReplyModelInput): Promise<ReplyModelOutput> => {
    const quoted = pickQuotedPhrase(input.article);
    const grounding = normalizeWhitespace(
      input.supportingParagraphs[0] ||
        input.article.excerpt ||
        input.article.contextExcerpt ||
        input.article.title ||
        "",
    ).slice(0, 120);

    const opener =
      input.slot.label && /counterpoint/i.test(input.slot.label)
        ? "You raise a fair point, and I'd add a tension here."
        : input.slot.label && /question first/i.test(input.slot.label)
          ? "What changes once ownership is verifiable end to end?"
          : "I keep coming back to one idea here.";

    const body = grounding
      ? `My work argues "${quoted}" — and that reframes ${grounding.slice(0, 60)}`
      : `My work argues "${quoted}" — and I think that reframes the question.`;

    const question = "What would change in your model if that held?";

    const text = input.slot.endsWithQuestion
      ? `${opener} ${body}. ${question}`
      : `${opener} ${body}.`;

    const whyRecommended = `This article's "${quoted}" framing maps directly onto the post's topic, giving a grounded angle for the reply.`;

    return { text, whyRecommended };
  };
}
