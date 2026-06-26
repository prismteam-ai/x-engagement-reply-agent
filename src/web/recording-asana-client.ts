import type { AsanaClient, ParentTaskInput, SubtaskInput } from "../asana/client.js";
import { composeIntentLink } from "../domain/pipeline-logic.js";
import type { ArticleMatch, PostCandidate, ReplyDraft } from "../domain/types.js";

/**
 * An {@link AsanaClient} DECORATOR for the web runtime. The pipeline only ever
 * exposes generated reply drafts to its Asana client, so to surface them in the
 * dashboard we wrap whatever client {@link buildDeps} produced and record each
 * parent task / subtask it is asked to create (with the post, matched article,
 * draft, and X compose link) before delegating to the wrapped client.
 *
 * It performs NO writes of its own — it forwards every call to the delegate and
 * returns the delegate's real gid:
 *   - dry-run  → delegate is `DryRunAsanaClient` (no writes, fake gids)
 *   - live     → delegate is `AsanaApiClient` (real writes, real gids)
 *
 * Recording with the delegate's gid keeps `parentTaskId` linkage correct in both
 * modes, so subtasks render under the right post regardless of driver.
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

export class RecordingAsanaClient implements AsanaClient {
  readonly parentTasks: CapturedParentTask[] = [];
  readonly subtasks: CapturedSubtask[] = [];

  constructor(private readonly delegate: AsanaClient) {}

  async createParentTask(input: ParentTaskInput): Promise<string> {
    const id = await this.delegate.createParentTask(input);
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
    const id = await this.delegate.createSubtask(input);
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
