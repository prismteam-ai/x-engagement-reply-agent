import type {
  ReplyGenerationInput,
  ReplyGenerationOutput,
  ReplyGenerator,
  SuggestedResponse,
} from "../../ports.js";

const CHAR_LIMIT = 280;

/**
 * Deterministic, offline reply generator — the default when no LLM provider
 * credentials are present. It produces grounded drafts without a network call:
 * every reply quotes a real phrase from the matched Soofi article, varies its
 * framing per prompt slot, respects the 280-character limit, and ends with a
 * thought-provoking question unless the prompt sets `requireQuestion: false`.
 *
 * It is intentionally not as fluent as a real model, but it is correct,
 * reproducible, and fully testable — and swapping in {@link LlmReplyGenerator}
 * is a one-env-var change. The run is traced identically either way.
 */
export class DeterministicReplyGenerator implements ReplyGenerator {
  readonly provider = "offline-deterministic";
  readonly model = "offline/grounded-v1";

  async generate(input: ReplyGenerationInput): Promise<ReplyGenerationOutput> {
    const startedAt = new Date().toISOString();
    const start = performance.now();

    const quote = pickQuote(input.article.contextExcerpt, input.article.supportingParagraphs);
    const theme = pickTheme(input.article.title);

    const responses: SuggestedResponse[] = input.prompts.map((p) => {
      const mode = inferMode(p.label, p.text);
      const closer = p.requireQuestion ? pickQuestion(p.index, theme) : pickCallToAction(theme);
      const text = compose(mode, quote, closer);
      return { promptIndex: p.index, promptLabel: p.label, prompt: p.text, text };
    });

    const whyRecommended = clampWords(
      `Both the post and this Soofi article center on ${theme}; the article makes the case directly and supplies quotable language to ground a reply.`,
      35,
    );

    const finishedAt = new Date().toISOString();
    const durationMs = Math.round(performance.now() - start);
    const outputChars = responses.reduce((n, r) => n + r.text.length, 0) + whyRecommended.length;
    const inputChars =
      input.systemPrompt.length +
      input.responseConstraints.join("").length +
      input.article.contextExcerpt.length +
      input.post.text.length +
      input.prompts.reduce((n, p) => n + p.text.length, 0);

    return {
      whyRecommended,
      responses,
      trace: {
        provider: this.provider,
        model: this.model,
        startedAt,
        finishedAt,
        durationMs,
        promptCount: input.prompts.length,
        inputChars,
        outputChars,
        ok: true,
      },
    };
  }
}

type Mode = "recommend" | "agree" | "counter" | "example" | "thesis";

function inferMode(label: string, text: string): Mode {
  const hay = `${label} ${text}`.toLowerCase();
  if (/counter|challenge|disagree|qualify/.test(hay)) return "counter";
  if (/agree|extend|affirm/.test(hay)) return "agree";
  if (/example|concrete|mechanism|tangible/.test(hay)) return "example";
  if (/thesis|claim|declarative|sharpest/.test(hay)) return "thesis";
  return "recommend";
}

function compose(mode: Mode, quote: string, closer: string): string {
  const opener: Record<Mode, string> = {
    recommend: `Soofi's argument fits here: “${quote}.”`,
    agree: `Agreed — and Soofi pushes it further: “${quote}.”`,
    counter: `Fair, though Soofi would qualify it: “${quote}.”`,
    example: `Concretely, as Soofi puts it: “${quote}.”`,
    thesis: `“${quote}.”`,
  };
  return fitToLimit(`${opener[mode]} ${closer}`, quote, opener[mode], closer, mode);
}

/** Ensure the composed reply fits in 280 chars, trimming the quote first if needed. */
function fitToLimit(full: string, quote: string, opener: string, closer: string, mode: Mode): string {
  if (full.length <= CHAR_LIMIT) return full;
  // Trim the quote and rebuild.
  const overflow = full.length - CHAR_LIMIT;
  const trimmedQuote = quote.length > overflow + 1 ? quote.slice(0, quote.length - overflow - 1).trimEnd() + "…" : quote;
  const rebuilt = compose(mode, trimmedQuote, closer);
  return rebuilt.length <= CHAR_LIMIT ? rebuilt : rebuilt.slice(0, CHAR_LIMIT - 1).trimEnd() + "…";
}

/** Pick a short, quotable phrase from the article content. */
export function pickQuote(excerpt: string, passages: string[]): string {
  const source = passages[0] ?? excerpt;
  const sentences = source
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 20 && s.length <= 120 && !/^#/.test(s));
  const chosen = sentences[0] ?? source.slice(0, 100);
  return chosen.replace(/[.!?]+$/, "").replace(/^["“”']+|["“”']+$/g, "").trim();
}

/** A coarse theme noun-phrase derived from the article title. */
export function pickTheme(title: string): string {
  const cleaned = title
    .replace(/^core principle:?\s*/i, "")
    .replace(/[.:].*$/, "")
    .toLowerCase()
    .trim();
  const words = cleaned.split(/\s+/).slice(0, 6).join(" ");
  return words || "verifiable property data";
}

const QUESTIONS = [
  "What breaks first if we keep pretending the old system is fine?",
  "How would your model change if this were verifiable end to end?",
  "Who should actually own this layer once it exists?",
  "What would it take to make this real at scale?",
  "Where does this leave the incumbents who depend on the silo?",
  "What's the first record you'd want provable on-chain?",
];

function pickQuestion(index: number, theme: string): string {
  const base = QUESTIONS[(index - 1) % QUESTIONS.length]!;
  return base.includes("this") ? base.replace("this", theme) : base;
}

function pickCallToAction(theme: string): string {
  return `Worth reading Soofi's piece on ${theme} before the incumbents catch up.`;
}

function clampWords(s: string, max: number): string {
  const words = s.split(/\s+/);
  if (words.length <= max) return s;
  return words.slice(0, max).join(" ").replace(/[,;:]$/, "") + ".";
}
