import type { AsanaClient, ParentTaskInput, SubtaskInput } from "../asana/client.js";
import { composeIntentLink } from "../domain/pipeline-logic.js";
import type { ArticleMatch, PostCandidate, ReplyDraft } from "../domain/types.js";

/**
 * An in-memory {@link AsanaClient} for the web runtime. The pipeline only ever
 * exposes generated reply drafts to its Asana client, so to surface them in the
 * dashboard we inject this capturing client instead of the dry-run logger. It
 * performs no writes; it records the parent tasks and subtasks (with the post,
 * matched article, draft, and X compose link) that a real run would create.
 */

export interface CapturedParentTask {
  id: string;
  statusId: string;
  handle: string;
  bestRawScore: number;
  assignee?: string;
  dueToday: boolean;
  matchCount: number;
}

export interface CapturedSubtask {
  id: string;
  parentTaskId: string;
  post: PostCandidate;
  article: ArticleMatch;
  draft: ReplyDraft;
  /** Prebuilt https://x.com/intent/post?... link for the reviewer to click. */
  composeLink: string;
}

export class CapturingAsanaClient implements AsanaClient {
  private counter = 0;
  readonly parentTasks: CapturedParentTask[] = [];
  readonly subtasks: CapturedSubtask[] = [];

  async createParentTask(input: ParentTaskInput): Promise<string> {
    const id = `parent-${++this.counter}`;
    this.parentTasks.push({
      id,
      statusId: input.post.statusId,
      handle: input.post.handle,
      bestRawScore: input.bestRawScore,
      assignee: input.assignee,
      dueToday: input.dueToday,
      matchCount: input.matches.length,
    });
    return id;
  }

  async createSubtask(input: SubtaskInput): Promise<string> {
    const id = `subtask-${++this.counter}`;
    this.subtasks.push({
      id,
      parentTaskId: input.parentTaskId,
      post: input.post,
      article: input.article,
      draft: input.draft,
      composeLink: composeIntentLink(input.draft.suggestedResponse, input.post.statusId),
    });
    return id;
  }
}
