import { describe, it, expect } from "vitest";
import { runMonitor, type MonitorDeps } from "../src/pipeline/monitor.js";
import { loadConfig } from "../src/config/index.js";
import { FixtureXClient } from "../src/x/fixture-driver.js";
import { ReplyGenerator } from "../src/llm/reply-generator.js";
import { MemoryStateStore } from "../src/state/file-store.js";
import type { InvestorContentQuerier } from "../src/mcp/client.js";
import type { ArticleMatch, PostCandidate } from "../src/domain/types.js";
import type { AsanaClient, ParentTaskInput, SubtaskInput } from "../src/asana/client.js";

/** A relevant Soofi article that clears the 0.7 article threshold. */
const relevantMatch: ArticleMatch = {
  title: "Privacy-first property tokenization",
  sourceUri: "https://x.com/ssafavi/status/1901718215799066675",
  rawScore: 0.82,
  score: 82,
  excerpt: "Truth becomes programmable when property records leave silos.",
  content:
    "Core principle: Privacy-first property tokenization MUST separate digital from physical identity. Truth becomes programmable when records leave silos.",
};

const weakMatch: ArticleMatch = { ...relevantMatch, rawScore: 0.2, score: 20 };

function fakeMcp(matchesByQuery: (q: string) => ArticleMatch[]): InvestorContentQuerier {
  return { queryInvestorContent: async ({ query }) => matchesByQuery(query) };
}

type GenerateFn = ConstructorParameters<typeof ReplyGenerator>[0]["generate"];

/** ReplyGenerator with the model call stubbed — no network, deterministic. */
function fakeReplyGenerator(config: ReturnType<typeof loadConfig>): ReplyGenerator {
  const generate = (async () => ({
    object: { suggestedResponse: "Grounded draft reply.", whyRecommended: "Matches the thesis." },
    usage: { promptTokens: 10, completionTokens: 5 },
  })) as unknown as GenerateFn;
  return new ReplyGenerator({ settings: config.settings, prompts: config.prompts, generate });
}

class RecordingAsana implements AsanaClient {
  parents: ParentTaskInput[] = [];
  subtasks: SubtaskInput[] = [];
  async createParentTask(input: ParentTaskInput) {
    this.parents.push(input);
    return `parent-${this.parents.length}`;
  }
  async createSubtask(input: SubtaskInput) {
    this.subtasks.push(input);
    return `sub-${this.subtasks.length}`;
  }
}

function singleAuthorConfig() {
  const config = loadConfig();
  config.watchlist.authors = [
    { author: "Test", handle: "balajis", company: "", aliases: { handles: [], authors: [] }, active: true, excludeFromTasking: false },
  ];
  return config;
}

const post = (statusId: string, text: string): PostCandidate => ({
  sourceUri: `https://x.com/balajis/status/${statusId}`,
  statusId,
  handle: "balajis",
  header: text.slice(0, 30),
  text,
});

function deps(over: Partial<MonitorDeps>): MonitorDeps {
  const config = singleAuthorConfig();
  return {
    config,
    x: new FixtureXClient([{ handle: "balajis", posts: [post("100", "on-chain property records")] }]),
    mcp: fakeMcp(() => [relevantMatch]),
    replies: fakeReplyGenerator(config),
    asana: new RecordingAsana(),
    state: new MemoryStateStore(),
    dryRun: false,
    ...over,
  };
}

describe("runMonitor end-to-end (fixtures + mocks)", () => {
  it("tasks a relevant post: parent + one subtask per reply prompt", async () => {
    const asana = new RecordingAsana();
    const d = deps({ asana });
    const summary = await runMonitor(d);

    expect(summary.parentTasksCreated).toBe(1);
    expect(asana.parents).toHaveLength(1);
    // 5 reply prompts × 1 qualifying article = 5 subtasks
    expect(summary.subtasksCreated).toBe(d.config.prompts.replies.length);
    expect(asana.subtasks[0]!.draft.suggestedResponse).toContain("Grounded draft");
  });

  it("caps subtasks at maxArticlesPerPost (top-1) even when many articles qualify", async () => {
    const asana = new RecordingAsana();
    const many = [0.9, 0.85, 0.82].map((s) => ({ ...relevantMatch, rawScore: s, score: Math.round(s * 100) }));
    const d = deps({ asana, mcp: fakeMcp(() => many) });
    const summary = await runMonitor(d);
    // top-1 article × 5 prompts = 5, not 3 × 5
    expect(summary.subtasksCreated).toBe(d.config.prompts.replies.length);
  });

  it("skips a post below the article threshold (no parent, no subtasks)", async () => {
    const asana = new RecordingAsana();
    const d = deps({ asana, mcp: fakeMcp(() => [weakMatch]) });
    const summary = await runMonitor(d);
    expect(summary.parentTasksCreated).toBe(0);
    expect(summary.subtasksCreated).toBe(0);
    expect(summary.skipped).toBe(1);
  });

  it("dedupes already-tasked posts across runs", async () => {
    const asana = new RecordingAsana();
    const state = new MemoryStateStore();
    const d = deps({ asana, state });
    await runMonitor(d);
    await runMonitor(deps({ asana, state }));
    expect(asana.parents).toHaveLength(1); // second run skips the already-tasked post
  });

  it("dry-run computes drafts but creates no Asana side effects in state", async () => {
    const asana = new RecordingAsana();
    const state = new MemoryStateStore();
    const summary = await runMonitor(deps({ asana, state, dryRun: true }));
    expect(summary.parentTasksCreated).toBe(1); // counted in summary
    // but nothing persisted as tasked, so a fresh non-dry run would task again
    expect(await state.isTasked("https://x.com/balajis/status/100::100")).toBe(false);
  });

  it("excludes the corpus author from tasking", async () => {
    const config = singleAuthorConfig();
    config.watchlist.authors[0]!.excludeFromTasking = true;
    const asana = new RecordingAsana();
    const summary = await runMonitor(deps({ config, asana }));
    expect(summary.parentTasksCreated).toBe(0);
    expect(summary.skipped).toBe(1);
  });
});
