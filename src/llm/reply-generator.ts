import { generateObject } from "ai";
import { z } from "zod";
import type { ArticleMatch, PostCandidate, ReplyDraft } from "../domain/types.js";
import type { PromptSet, ReplyPrompt } from "../config/prompts.js";
import type { Settings } from "../config/schema.js";
import { trimToLimit } from "../domain/pipeline-logic.js";
import { resolveModel } from "./model.js";
import { LangSmithTracer } from "./langsmith.js";
import { createLogger, type Logger } from "../observability/logger.js";

/**
 * Generates one recommended reply per (matched article × reply prompt file).
 * Prompts, tone, and constraints all come from version-controlled Markdown.
 * Every call is traced to LangSmith and token usage is logged.
 */

/** Extract the character cap from constraints.md ("Maximum of N characters"); default 280. */
export function parseMaxChars(constraints: string): number {
  const m = constraints.match(/maximum\s+of\s+(\d+)\s+characters/i);
  return m ? Number(m[1]) : 280;
}

const draftSchema = z.object({
  suggestedResponse: z
    .string()
    .describe("The drafted X reply, <= 280 chars, grounded in the article, with a quoted phrase."),
  whyRecommended: z
    .string()
    .describe("One sentence on why this article/reply fits the target post."),
});

export interface ReplyGeneratorDeps {
  settings: Settings;
  prompts: PromptSet;
  tracer?: LangSmithTracer;
  logger?: Logger;
  /** Injected for tests to avoid real model calls. */
  generate?: typeof generateObject;
}

export class ReplyGenerator {
  private readonly settings: Settings;
  private readonly prompts: PromptSet;
  private readonly tracer: LangSmithTracer;
  private readonly logger: Logger;
  private readonly generate: typeof generateObject;

  constructor(deps: ReplyGeneratorDeps) {
    this.settings = deps.settings;
    this.prompts = deps.prompts;
    this.tracer = deps.tracer ?? new LangSmithTracer();
    this.logger = deps.logger ?? createLogger("reply-generator");
    this.generate = deps.generate ?? generateObject;
  }

  /** Generate all reply drafts for a single matched article. */
  async draftsForArticle(post: PostCandidate, article: ArticleMatch): Promise<ReplyDraft[]> {
    const drafts: ReplyDraft[] = [];
    for (const prompt of this.prompts.replies) {
      drafts.push(await this.draftOne(post, article, prompt));
    }
    return drafts;
  }

  private async draftOne(
    post: PostCandidate,
    article: ArticleMatch,
    prompt: ReplyPrompt,
  ): Promise<ReplyDraft> {
    const system = `${this.prompts.system}\n\n# Constraints\n${this.prompts.constraints}`;
    const user = [
      `# Reply instruction (${prompt.label})`,
      prompt.text,
      "",
      "# Target post",
      post.text,
      "",
      "# Matched Soofi article",
      `Title: ${article.title}`,
      `Source: ${article.sourceUri}`,
      "Content:",
      article.content,
    ].join("\n");

    const metadata = {
      modelId: this.settings.modelId,
      promptLabel: prompt.label,
      promptFile: prompt.file,
      articleTitle: article.title,
      rawScore: article.rawScore,
      statusId: post.statusId,
    };
    const maxChars = parseMaxChars(this.prompts.constraints);
    const handle = this.tracer.start({ name: `reply:${prompt.label}`, input: { system, user }, metadata });

    try {
      const first = await this.generateOnce(system, user);
      let object = first.object;
      let usage = first.usage;
      let regenerated = false;
      let trimmed = false;

      // Enforce the configured char limit: regenerate once with explicit feedback,
      // then hard-trim as a guaranteed backstop so every draft is postable.
      if (object.suggestedResponse.length > maxChars) {
        regenerated = true;
        const retryUser = [
          user,
          "",
          `# IMPORTANT`,
          `Your previous draft was ${object.suggestedResponse.length} characters, which is too long.`,
          `Rewrite it to be at most ${maxChars} characters total, keeping the quoted phrase and the closing question.`,
          "",
          "# Previous draft",
          object.suggestedResponse,
        ].join("\n");
        const retry = await this.generateOnce(system, retryUser);
        if (retry.object.suggestedResponse.length < object.suggestedResponse.length) {
          object = retry.object;
        }
        usage = retry.usage;
      }

      if (object.suggestedResponse.length > maxChars) {
        trimmed = true;
        object = { ...object, suggestedResponse: trimToLimit(object.suggestedResponse, maxChars) };
      }

      if (regenerated || trimmed) {
        this.logger.warn("reply length enforced", {
          promptLabel: prompt.label,
          statusId: post.statusId,
          finalLength: object.suggestedResponse.length,
          maxChars,
          regenerated,
          trimmed,
        });
      }
      this.logger.info("reply drafted", {
        promptLabel: prompt.label,
        statusId: post.statusId,
        length: object.suggestedResponse.length,
        promptTokens: usage?.promptTokens,
        completionTokens: usage?.completionTokens,
      });
      await handle.end(object, { usage, regenerated, trimmed });
      return {
        promptIndex: prompt.index,
        promptLabel: prompt.label,
        promptText: prompt.text,
        suggestedResponse: object.suggestedResponse,
        whyRecommended: object.whyRecommended,
      };
    } catch (err) {
      await handle.fail(err);
      throw err;
    }
  }

  private async generateOnce(system: string, user: string) {
    const result = await this.generate({
      model: resolveModel(this.settings.modelId),
      schema: draftSchema,
      system,
      prompt: user,
    });
    return { object: result.object, usage: result.usage };
  }
}
