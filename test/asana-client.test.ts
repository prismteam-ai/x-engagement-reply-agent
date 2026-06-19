import { describe, it, expect } from "vitest";
import { AsanaApiClient, renderParentNotes, type ParentTaskInput } from "../src/asana/client.js";
import { asanaConfigSchema } from "../src/config/schema.js";
import type { ArticleMatch, PostCandidate, ReplyDraft } from "../src/domain/types.js";

const post: PostCandidate = {
  sourceUri: "https://x.com/balajis/status/100",
  statusId: "100",
  handle: "balajis",
  header: "on-chain property records",
  text: "County deeds should be verifiable on-chain.",
};

const article: ArticleMatch = {
  title: "Privacy-first property tokenization",
  sourceUri: "https://x.com/ssafavi/status/1",
  rawScore: 0.82,
  score: 82,
  excerpt: "Truth becomes programmable.",
  content: "Truth becomes programmable when records leave silos.",
};

const draft: ReplyDraft = {
  promptIndex: 1,
  promptLabel: "Prompt 1",
  promptText: "Recommend and draft",
  suggestedResponse: "Records belong on-chain. What changes when ownership is verifiable?",
  whyRecommended: "Same thesis as the article.",
};

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

function makeClient(over: Partial<Parameters<typeof asanaConfigSchema.parse>[0]> = {}) {
  const captured: Captured[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    captured.push({ url, body: JSON.parse(init.body as string) });
    return new Response(JSON.stringify({ data: { gid: `gid-${captured.length}` } }), { status: 200 });
  }) as unknown as typeof fetch;
  const config = asanaConfigSchema.parse({
    workspace: "WS",
    project: "PROJ",
    section: "SEC",
    defaultAssignee: "default",
    thresholdAssignee: "lead",
    thresholdAssigneeRawScore: 0.8,
    parentSimilarityFieldId: "PF",
    subtaskSimilarityFieldId: "SF",
    ...over,
  });
  const client = new AsanaApiClient({ config, token: "t", fetchImpl, today: () => "2026-06-19" });
  return { client, captured };
}

const parentInput = (over: Partial<ParentTaskInput> = {}): ParentTaskInput => ({
  post,
  matches: [article],
  bestRawScore: 0.82,
  assignee: "lead",
  dueToday: true,
  thresholds: { asanaTaskSimilarityThreshold: 0, articleSimilarityThreshold: 0.7 },
  ...over,
});

describe("AsanaApiClient.createParentTask", () => {
  it("sends project, assignee, due date, custom field; then adds to section", async () => {
    const { client, captured } = makeClient();
    const gid = await client.createParentTask(parentInput());
    expect(gid).toBe("gid-1");

    const create = captured[0]!;
    expect(create.url).toContain("/tasks");
    const data = create.body.data as Record<string, unknown>;
    expect(data.workspace).toBe("WS");
    expect(data.projects).toEqual(["PROJ"]);
    expect(data.assignee).toBe("lead");
    expect(data.due_on).toBe("2026-06-19");
    expect(data.custom_fields).toEqual({ PF: 0.82 });
    expect(String(data.notes)).toContain("Best match raw similarity: 0.8200");

    // second call adds the task to the section
    expect(captured[1]!.url).toContain("/sections/SEC/addTask");
  });

  it("omits due date when dueToday is false", async () => {
    const { client, captured } = makeClient();
    await client.createParentTask(parentInput({ dueToday: false }));
    const data = captured[0]!.body.data as Record<string, unknown>;
    expect(data.due_on).toBeUndefined();
  });
});

describe("AsanaApiClient.createSubtask", () => {
  it("creates a subtask under the parent with draft + compose link + custom field", async () => {
    const { client, captured } = makeClient();
    const gid = await client.createSubtask({ parentTaskId: "P1", post, article, draft });
    expect(gid).toBe("gid-1");
    const call = captured[0]!;
    expect(call.url).toContain("/tasks/P1/subtasks");
    const data = call.body.data as Record<string, unknown>;
    expect(String(data.notes)).toContain("https://x.com/intent/post?");
    expect(String(data.notes)).toContain("in_reply_to=100");
    expect(String(data.notes)).toContain(draft.suggestedResponse);
    expect(data.custom_fields).toEqual({ SF: 0.82 });
  });
});

describe("renderParentNotes", () => {
  it("includes source, thresholds, and ranked matches", () => {
    const notes = renderParentNotes(parentInput());
    expect(notes).toContain("Source post: https://x.com/balajis/status/100");
    expect(notes).toContain("Top article matches:");
    expect(notes).toContain("Privacy-first property tokenization");
  });
});

describe("AsanaApiClient errors", () => {
  it("throws on non-OK response", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const config = asanaConfigSchema.parse({});
    const client = new AsanaApiClient({ config, token: "t", fetchImpl });
    await expect(client.createParentTask(parentInput())).rejects.toThrow("Asana 401");
  });
});
