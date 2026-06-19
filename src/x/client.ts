import type { PostCandidate } from "../domain/types.js";

/**
 * Abstraction over the X data source. The pipeline depends only on this
 * interface, so dev/dry-run/tests use the fixture driver and the demo uses the
 * live API driver — selected by config/env, never by changing pipeline code.
 */
export interface XClient {
  /**
   * Fetch recent posts for an author, newest first, optionally only those after
   * a last-seen status id. Referenced originals (reply/quote targets) and any
   * long-form article body should already be enriched onto each PostCandidate.
   */
  fetchAuthorPosts(params: {
    handle: string;
    sinceStatusId?: string;
    maxResults: number;
  }): Promise<PostCandidate[]>;
}
