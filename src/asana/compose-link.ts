function normalizeWhitespace(value: string): string {
  return value.replace(/\r/g, "").replace(/\s+/g, " ").trim();
}

export function buildXReplyIntentUrl(params: {
  statusId: string;
  text: string;
}): string {
  const statusId = normalizeWhitespace(params.statusId || "");
  const text = String(params.text || "").replace(/\r/g, "").trim();
  if (!statusId || !text) return "";

  const query = new URLSearchParams({
    in_reply_to: statusId,
    text,
  });
  return `https://twitter.com/intent/tweet?${query.toString()}`;
}
