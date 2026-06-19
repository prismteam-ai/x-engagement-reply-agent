import type { AsanaClient, ParentTaskInput, SubtaskInput } from "./client.js";
import { composeIntentLink } from "../domain/pipeline-logic.js";
import { createLogger, type Logger } from "../observability/logger.js";

/**
 * Dry-run AsanaClient: performs no writes. It logs the task/subtask payloads it
 * *would* create so dry-run output exactly mirrors a real run minus side effects.
 */
export class DryRunAsanaClient implements AsanaClient {
  private counter = 0;
  private readonly logger: Logger;

  constructor(logger?: Logger) {
    this.logger = logger ?? createLogger("asana-dry-run");
  }

  async createParentTask(input: ParentTaskInput): Promise<string> {
    const gid = `dryrun-parent-${++this.counter}`;
    this.logger.info("[dry-run] would create parent task", {
      gid,
      statusId: input.post.statusId,
      bestRawScore: input.bestRawScore,
      assignee: input.assignee,
      dueToday: input.dueToday,
      matchCount: input.matches.length,
    });
    return gid;
  }

  async createSubtask(input: SubtaskInput): Promise<string> {
    const gid = `dryrun-subtask-${++this.counter}`;
    this.logger.info("[dry-run] would create subtask", {
      gid,
      parent: input.parentTaskId,
      promptLabel: input.draft.promptLabel,
      article: input.article.title,
      composeLink: composeIntentLink(input.draft.suggestedResponse, input.post.statusId),
      draft: input.draft.suggestedResponse,
    });
    return gid;
  }
}
