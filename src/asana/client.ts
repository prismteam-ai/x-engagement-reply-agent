import { z } from "zod";
import type { ArticleMatch, PostCandidate, ReplyDraft } from "../domain/types.js";
import type { AsanaConfig } from "../config/schema.js";
import { composeIntentLink } from "../domain/pipeline-logic.js";
import { createLogger, type Logger } from "../observability/logger.js";

/**
 * Creates the human-in-the-loop posting workflow in Asana: one parent task per
 * qualifying post, and one approval subtask per (matched article × reply prompt)
 * carrying the draft reply and an X compose-intent link. Never posts to X.
 */
const API_BASE = "https://app.asana.com/api/1.0";

const taskResponseSchema = z.object({ data: z.object({ gid: z.string() }) });

export interface ParentTaskInput {
  post: PostCandidate;
  matches: ArticleMatch[];
  bestRawScore: number;
  assignee?: string;
  dueToday: boolean;
  thresholds: { asanaTaskSimilarityThreshold: number; articleSimilarityThreshold: number };
}

export interface SubtaskInput {
  parentTaskId: string;
  post: PostCandidate;
  article: ArticleMatch;
  draft: ReplyDraft;
}

export interface AsanaClient {
  createParentTask(input: ParentTaskInput): Promise<string>;
  createSubtask(input: SubtaskInput): Promise<string>;
}

export interface AsanaApiClientOptions {
  config: AsanaConfig;
  token?: string;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  today?: () => string;
}

export class AsanaApiClient implements AsanaClient {
  private readonly config: AsanaConfig;
  private readonly token: string;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly today: () => string;

  constructor(opts: AsanaApiClientOptions) {
    const token = opts.token ?? process.env.ASANA_PERSONAL_ACCESS_TOKEN;
    if (!token) {
      throw new Error("AsanaApiClient requires ASANA_PERSONAL_ACCESS_TOKEN (or pass token).");
    }
    this.config = opts.config;
    this.token = token;
    this.logger = opts.logger ?? createLogger("asana");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.today = opts.today ?? (() => new Date().toISOString().slice(0, 10));
  }

  async createParentTask(input: ParentTaskInput): Promise<string> {
    const notes = renderParentNotes(input);
    const data: Record<string, unknown> = {
      name: `X engagement: ${input.post.handle} — ${truncate(input.post.header, 80)}`,
      notes,
    };
    if (this.config.workspace) data.workspace = this.config.workspace;
    if (this.config.project) data.projects = [this.config.project];
    if (input.assignee) data.assignee = input.assignee;
    if (input.dueToday) data.due_on = this.today();

    const custom = customFields(this.config.parentSimilarityFieldId, input.bestRawScore);
    if (custom) data.custom_fields = custom;

    const gid = await this.createTask(data);
    if (this.config.section) await this.addToSection(gid, this.config.section);
    this.logger.info("parent task created", { gid, statusId: input.post.statusId });
    return gid;
  }

  async createSubtask(input: SubtaskInput): Promise<string> {
    const link = composeIntentLink(input.draft.suggestedResponse, input.post.statusId);
    const notes = [
      `Prompt: ${input.draft.promptLabel}`,
      "",
      "Draft reply:",
      input.draft.suggestedResponse,
      "",
      `Why: ${input.draft.whyRecommended}`,
      "",
      `Matched article: ${input.article.title} (score ${input.article.score})`,
      input.article.sourceUri,
      "",
      `Post & reply on X: ${link}`,
    ].join("\n");

    const data: Record<string, unknown> = {
      name: `${input.draft.promptLabel}: ${truncate(input.draft.suggestedResponse, 60)}`,
      notes,
    };
    const custom = customFields(this.config.subtaskSimilarityFieldId, input.article.rawScore);
    if (custom) data.custom_fields = custom;

    const gid = await this.createTask(data, `/tasks/${input.parentTaskId}/subtasks`);
    return gid;
  }

  private async createTask(data: Record<string, unknown>, path = "/tasks"): Promise<string> {
    const json = await this.post(path, { data });
    return taskResponseSchema.parse(json).data.gid;
  }

  private async addToSection(taskGid: string, section: string): Promise<void> {
    await this.post(`/sections/${section}/addTask`, { data: { task: taskGid } });
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${API_BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Asana ${res.status} for ${path}: ${await res.text()}`);
    }
    return res.json();
  }
}

function customFields(fieldId: string | undefined, rawScore: number): Record<string, number> | undefined {
  if (!fieldId) return undefined;
  return { [fieldId]: Number(rawScore.toFixed(4)) };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

export function renderParentNotes(input: ParentTaskInput): string {
  const lines = [
    `Source post: ${input.post.sourceUri}`,
    `Author: @${input.post.handle}`,
    "",
    input.post.text,
    "",
    `Best match raw similarity: ${input.bestRawScore.toFixed(4)}`,
    `Thresholds — parent: ${input.thresholds.asanaTaskSimilarityThreshold}, article: ${input.thresholds.articleSimilarityThreshold}`,
    "",
    "Top article matches:",
  ];
  for (const m of input.matches) {
    lines.push(`- ${m.title} (score ${m.score}, raw ${m.rawScore.toFixed(4)}) ${m.sourceUri}`);
  }
  if (input.post.referencedOriginal) {
    lines.push("", `Referenced ${input.post.referencedOriginal.relation}: ${input.post.referencedOriginal.sourceUri}`);
  }
  return lines.join("\n");
}
