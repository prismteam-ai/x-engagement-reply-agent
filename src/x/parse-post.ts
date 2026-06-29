export type ReferencedStatus = {
  statusId: string;
  handle?: string;
};

export type InteractionType =
  | "original"
  | "reply"
  | "quote"
  | "repost"
  | "unknown";

export type PostInteraction = {
  type: InteractionType;
  parentStatusId?: string;
  parentAuthorHandle?: string;
  conversationId?: string;
  inReplyToUserId?: string;
  referencedStatusIds?: string[];
  detectionMethod: "x_api_metadata" | "heuristic";
};

export type ParsedPost = {
  statusId: string;
  sourceUri: string;
  text: string;
  header: string;
  date: string;
  contentCreatedAt: string;
  contentType: "post" | "article";
  canonicalSource: boolean;
  referencedStatuses?: ReferencedStatus[];
  interaction?: PostInteraction;
};

export type XApiTweetLike = {
  id?: string;
  text?: string;
  conversation_id?: string;
  in_reply_to_user_id?: string;
  referenced_tweets?: Array<{ id?: string; type?: string }>;
  [key: string]: unknown;
};

export function normalizeWhitespace(value: string): string {
  return value.replace(/\r/g, "").replace(/\s+/g, " ").trim();
}

export function handleFromText(handleText: string): string {
  return handleText.replace("@", "").replace(/\s+/g, "").trim().toLowerCase();
}

export function extractStatusId(urlOrPath: string): string | null {
  const match = String(urlOrPath || "").match(/\/status\/(\d+)/);
  return match ? match[1]! : null;
}

export function parseStatusLinksFromText(value: string): ReferencedStatus[] {
  const text = String(value || "");
  const pattern =
    /(?:https?:\/\/)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/gi;
  const out: ReferencedStatus[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(pattern)) {
    const handle = normalizeWhitespace(String(match[1] || "")).toLowerCase();
    const statusId = normalizeWhitespace(String(match[2] || ""));
    if (!statusId) continue;
    if (seen.has(statusId)) continue;
    seen.add(statusId);
    out.push({ statusId, ...(handle ? { handle } : {}) });
  }
  return out;
}

export function mergeReferencedStatuses(values: ReferencedStatus[]): ReferencedStatus[] {
  const byId = new Map<string, ReferencedStatus>();
  for (const row of values) {
    const statusId = normalizeWhitespace(row.statusId);
    if (!statusId) continue;
    const existing = byId.get(statusId);
    if (!existing) {
      byId.set(statusId, {
        statusId,
        ...(row.handle ? { handle: row.handle.toLowerCase() } : {}),
      });
      continue;
    }
    if (!existing.handle && row.handle) {
      existing.handle = row.handle.toLowerCase();
    }
  }
  return Array.from(byId.values());
}

export function buildInteractionFromTweet(
  tweet: XApiTweetLike,
  referencedStatuses: ReferencedStatus[] = [],
): PostInteraction {
  const referencedTweets = Array.isArray(tweet.referenced_tweets)
    ? tweet.referenced_tweets
    : [];
  const referencedStatusIds: string[] = [];
  let repliedToStatusId = "";
  let quotedStatusId = "";
  let repostedStatusId = "";
  let fallbackStatusId = "";

  for (const row of referencedTweets) {
    const id = normalizeWhitespace(String(row.id || ""));
    if (!id) continue;
    if (!referencedStatusIds.includes(id)) referencedStatusIds.push(id);
    const rowType = normalizeWhitespace(String(row.type || "")).toLowerCase();
    if (!repliedToStatusId && rowType === "replied_to") repliedToStatusId = id;
    else if (!quotedStatusId && rowType === "quoted") quotedStatusId = id;
    else if (!repostedStatusId && rowType === "retweeted") repostedStatusId = id;
    else if (!fallbackStatusId && rowType) fallbackStatusId = id;
  }

  const interactionType: InteractionType = repliedToStatusId
    ? "reply"
    : quotedStatusId
      ? "quote"
      : repostedStatusId
        ? "repost"
        : fallbackStatusId
          ? "unknown"
          : "original";
  const parentStatusId =
    repliedToStatusId || quotedStatusId || repostedStatusId || fallbackStatusId || "";

  for (const row of referencedStatuses) {
    const id = normalizeWhitespace(row.statusId);
    if (!id) continue;
    if (!referencedStatusIds.includes(id)) referencedStatusIds.push(id);
  }

  const byStatusHandle = new Map(
    referencedStatuses
      .map(
        (row) =>
          [
            normalizeWhitespace(row.statusId),
            normalizeWhitespace(row.handle || "").toLowerCase(),
          ] as const,
      )
      .filter(([id]) => Boolean(id)),
  );

  const parentAuthorHandle = parentStatusId ? byStatusHandle.get(parentStatusId) || "" : "";
  const inReplyToUserId = normalizeWhitespace(String(tweet.in_reply_to_user_id || ""));
  const conversationId = normalizeWhitespace(String(tweet.conversation_id || ""));

  return {
    type: interactionType,
    ...(parentStatusId ? { parentStatusId } : {}),
    ...(parentAuthorHandle ? { parentAuthorHandle } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(inReplyToUserId ? { inReplyToUserId } : {}),
    ...(referencedStatusIds.length ? { referencedStatusIds } : {}),
    detectionMethod: "x_api_metadata",
  };
}

export function buildHeuristicInteractionFromText(
  text: string,
  referencedStatuses: ReferencedStatus[],
): PostInteraction | undefined {
  const referencedStatusIds = Array.from(
    new Set(
      referencedStatuses.map((row) => normalizeWhitespace(row.statusId)).filter(Boolean),
    ),
  );
  const first = referencedStatuses[0];
  const parentStatusId = normalizeWhitespace(first?.statusId || "");
  const parentAuthorHandle = normalizeWhitespace(first?.handle || "").toLowerCase();
  if (!referencedStatusIds.length && !/@[A-Za-z0-9_]{1,15}\b/.test(String(text || ""))) {
    return undefined;
  }
  return {
    type: parentStatusId ? "unknown" : "original",
    ...(parentStatusId ? { parentStatusId } : {}),
    ...(parentAuthorHandle ? { parentAuthorHandle } : {}),
    ...(referencedStatusIds.length ? { referencedStatusIds } : {}),
    detectionMethod: "heuristic",
  };
}

export function buildPostDedupeKey(params: { sourceUri: string; statusId: string }): string {
  const sourceUri = normalizeWhitespace(params.sourceUri || "").toLowerCase();
  const statusId = normalizeWhitespace(params.statusId || "");
  return `${sourceUri}|${statusId}`;
}

export function dedupeKeyForPost(post: Pick<ParsedPost, "sourceUri" | "statusId">): string {
  return buildPostDedupeKey({ sourceUri: post.sourceUri, statusId: post.statusId });
}

export function referencedStatusDedupeKeys(post: ParsedPost): string[] {
  const refs = mergeReferencedStatuses([
    ...(post.referencedStatuses || []),
    ...(post.interaction?.referencedStatusIds || []).map((statusId) => ({ statusId })),
  ]);
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const statusId = normalizeWhitespace(ref.statusId);
    if (!statusId || statusId === post.statusId) continue;
    const key = `${post.sourceUri.toLowerCase()}|${statusId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}
