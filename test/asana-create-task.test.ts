import { describe, expect, it, vi } from "vitest";
import { createAsanaTaskAdapter, formatDueOn } from "@/asana/create-task";
import { createAsanaRestClient, type AsanaConfig } from "@/asana/asana-client";
import type { WouldBeTask } from "@/pipeline/run-monitor";

/**
 * Unit tests for the live Asana adapter with a MOCKED fetch. No network. The
 * mock fetch is injected into the soofi-xyz REST client so the adapter exercises
 * the real client transport (URL/body/headers serialization) against canned
 * responses.
 */

const BASE = "https://app.asana.com/api/1.0";

const config: AsanaConfig = {
  accessToken: "test-pat",
  projectGid: "PROJECT_1",
  workspaceGid: "WORKSPACE_1",
  defaultAssigneeGid: "DEFAULT_ASSIGNEE",
  thresholdAssigneeGid: "THRESHOLD_ASSIGNEE",
};

type Call = { url: string; method: string; body: unknown };

/** A mock fetch that records calls and returns canned Asana envelopes. */
function makeMockFetch(opts: {
  parentGid?: string;
  parentUrl?: string;
  subtaskGids?: string[];
  failParent?: boolean;
  failSubtaskIndexes?: number[];
  failSectionAdd?: boolean;
}): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let subtaskCount = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });

    // Section add: POST /sections/{gid}/addTask
    if (method === "POST" && /\/sections\/[^/]+\/addTask/.test(url)) {
      if (opts.failSectionAdd) {
        return new Response(JSON.stringify({ errors: [{ message: "section boom" }] }), {
          status: 400,
        });
      }
      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // Parent create: POST /tasks
    if (method === "POST" && /\/tasks(\?|$)/.test(url.replace(BASE, ""))) {
      if (opts.failParent) {
        return new Response(JSON.stringify({ errors: [{ message: "boom" }] }), { status: 400 });
      }
      return new Response(
        JSON.stringify({
          data: { gid: opts.parentGid ?? "PARENT_GID", permalink_url: opts.parentUrl ?? "https://app.asana.com/0/x/PARENT_GID" },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }

    // Subtask create: POST /tasks/{gid}/subtasks
    if (method === "POST" && /\/tasks\/[^/]+\/subtasks/.test(url)) {
      const idx = subtaskCount++;
      if (opts.failSubtaskIndexes?.includes(idx)) {
        return new Response(JSON.stringify({ errors: [{ message: "subtask boom" }] }), { status: 400 });
      }
      const gid = opts.subtaskGids?.[idx] ?? `SUB_${idx}`;
      return new Response(JSON.stringify({ data: { gid } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

function makeTask(overrides: Partial<WouldBeTask> = {}): WouldBeTask {
  return {
    statusId: "111",
    sourceUri: "https://x.com/balajis/status/111",
    author: "Balaji Srinivasan",
    handle: "balajis",
    name: "Draft response: Balaji - on-chain title",
    notes: "Source post/article:\nhttps://x.com/balajis/status/111\n... raw=0.82 | score=82",
    bestRawScore: 0.82,
    recommendations: [],
    subtasks: [
      {
        promptIndex: 0,
        promptLabel: "Insightful",
        draftText: 'Records "verifiable on-chain" change everything. What next?',
        notes:
          'Approval action:\n...\nDraft response:\nRecords "verifiable on-chain" change everything.\n\nOpen in X:\nhttps://twitter.com/intent/tweet?in_reply_to=111&text=Records',
      },
      {
        promptIndex: 1,
        promptLabel: "Supportive",
        draftText: "Strong point on tokenized title.",
        notes: "Approval action:\n...\nDraft response:\nStrong point on tokenized title.",
      },
    ],
    ...overrides,
  };
}

describe("createAsanaTaskAdapter (mocked fetch)", () => {
  it("creates a parent task in the project + one subtask per reply slot", async () => {
    const { fetchImpl, calls } = makeMockFetch({});
    const client = createAsanaRestClient({ accessToken: config.accessToken, fetch: fetchImpl });
    const adapter = createAsanaTaskAdapter({ client, config, asanaTaskSimilarityThreshold: 0 });

    const result = await adapter(makeTask());

    expect(result.created).toBe(true);
    expect(result.parentGid).toBe("PARENT_GID");
    expect(result.parentUrl).toContain("PARENT_GID");
    expect(result.subtaskGids).toEqual(["SUB_0", "SUB_1"]);

    // Parent create call: correct path + workspace + projects + notes.
    const parentCall = calls.find((c) => c.method === "POST" && /\/tasks\?/.test(c.url));
    expect(parentCall).toBeTruthy();
    const parentBody = (parentCall!.body as { data: Record<string, unknown> }).data;
    expect(parentBody.workspace).toBe("WORKSPACE_1");
    expect(parentBody.projects).toEqual(["PROJECT_1"]);
    expect(parentBody.name).toContain("Draft response");
    expect(parentBody.notes).toContain("raw=0.82");

    // Two subtask create calls, each carrying the drafted reply notes.
    const subCalls = calls.filter((c) => /\/subtasks/.test(c.url));
    expect(subCalls).toHaveLength(2);
    const firstSub = (subCalls[0]!.body as { data: Record<string, unknown> }).data;
    expect(firstSub.name).toBe("Insightful");
    expect(String(firstSub.notes)).toContain("Draft response:");
  });

  it("subtask notes carry the X compose-intent link", async () => {
    const { fetchImpl, calls } = makeMockFetch({});
    const client = createAsanaRestClient({ accessToken: config.accessToken, fetch: fetchImpl });
    const adapter = createAsanaTaskAdapter({ client, config, asanaTaskSimilarityThreshold: 0 });

    await adapter(makeTask());

    const subCalls = calls.filter((c) => /\/subtasks/.test(c.url));
    const notes = String((subCalls[0]!.body as { data: { notes?: string } }).data.notes);
    expect(notes).toContain("https://twitter.com/intent/tweet?in_reply_to=111");
  });

  it("uses the DEFAULT assignee and NO due_on when below the task threshold", async () => {
    const { fetchImpl, calls } = makeMockFetch({});
    const client = createAsanaRestClient({ accessToken: config.accessToken, fetch: fetchImpl });
    // threshold 0.9 > bestRawScore 0.5 → below threshold.
    const adapter = createAsanaTaskAdapter({ client, config, asanaTaskSimilarityThreshold: 0.9 });

    await adapter(makeTask({ bestRawScore: 0.5 }));

    const parentCall = calls.find((c) => /\/tasks\?/.test(c.url))!;
    const body = (parentCall.body as { data: Record<string, unknown> }).data;
    expect(body.assignee).toBe("DEFAULT_ASSIGNEE");
    expect(body.due_on).toBeUndefined();
  });

  it("uses the THRESHOLD assignee and due_on=today when best score clears the threshold", async () => {
    const { fetchImpl, calls } = makeMockFetch({});
    const client = createAsanaRestClient({ accessToken: config.accessToken, fetch: fetchImpl });
    const fixedNow = new Date("2026-06-22T12:00:00.000Z");
    const adapter = createAsanaTaskAdapter({
      client,
      config,
      asanaTaskSimilarityThreshold: 0.8,
      now: () => fixedNow,
    });

    await adapter(makeTask({ bestRawScore: 0.82 }));

    const parentCall = calls.find((c) => /\/tasks\?/.test(c.url))!;
    const body = (parentCall.body as { data: Record<string, unknown> }).data;
    expect(body.assignee).toBe("THRESHOLD_ASSIGNEE");
    expect(body.due_on).toBe("2026-06-22");
    expect(formatDueOn(fixedNow)).toBe("2026-06-22");
  });

  it("dedupes a post already tasked (same source URI + status id)", async () => {
    const { fetchImpl, calls } = makeMockFetch({});
    const client = createAsanaRestClient({ accessToken: config.accessToken, fetch: fetchImpl });
    const adapter = createAsanaTaskAdapter({ client, config, asanaTaskSimilarityThreshold: 0 });

    const first = await adapter(makeTask());
    const second = await adapter(makeTask());

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.reason).toBe("already-tasked");
    // Only ONE parent create across both calls.
    const parentCalls = calls.filter((c) => /\/tasks\?/.test(c.url));
    expect(parentCalls).toHaveLength(1);
  });

  it("returns created:false (no throw) when the parent create fails", async () => {
    const { fetchImpl } = makeMockFetch({ failParent: true });
    const client = createAsanaRestClient({ accessToken: config.accessToken, fetch: fetchImpl });
    const adapter = createAsanaTaskAdapter({ client, config, asanaTaskSimilarityThreshold: 0 });

    const result = await adapter(makeTask());
    expect(result.created).toBe(false);
    expect(result.reason).toContain("asana-create-failed");
  });

  it("still creates the parent + remaining subtasks when one subtask fails", async () => {
    const { fetchImpl } = makeMockFetch({ failSubtaskIndexes: [0] });
    const client = createAsanaRestClient({ accessToken: config.accessToken, fetch: fetchImpl });
    const adapter = createAsanaTaskAdapter({ client, config, asanaTaskSimilarityThreshold: 0 });

    const result = await adapter(makeTask());
    expect(result.created).toBe(true);
    expect(result.parentGid).toBe("PARENT_GID");
    // Subtask 0 failed; subtask 1 still landed.
    expect(result.subtaskGids).toEqual(["SUB_1"]);
  });

  it("adds the parent task to the configured section after creation", async () => {
    const { fetchImpl, calls } = makeMockFetch({});
    const client = createAsanaRestClient({ accessToken: config.accessToken, fetch: fetchImpl });
    const adapter = createAsanaTaskAdapter({
      client,
      config: { ...config, sectionGid: "SECTION_1" },
      asanaTaskSimilarityThreshold: 0,
    });

    const result = await adapter(makeTask());
    expect(result.created).toBe(true);
    expect(result.parentGid).toBe("PARENT_GID");

    const sectionCall = calls.find((c) => /\/sections\/SECTION_1\/addTask/.test(c.url));
    expect(sectionCall).toBeTruthy();
    expect(sectionCall!.method).toBe("POST");
    const sectionBody = (sectionCall!.body as { data: Record<string, unknown> }).data;
    expect(sectionBody.task).toBe("PARENT_GID");
  });

  it("never calls addTask when no section is configured", async () => {
    const { fetchImpl, calls } = makeMockFetch({});
    const client = createAsanaRestClient({ accessToken: config.accessToken, fetch: fetchImpl });
    const adapter = createAsanaTaskAdapter({ client, config, asanaTaskSimilarityThreshold: 0 });

    const result = await adapter(makeTask());
    expect(result.created).toBe(true);

    const sectionCalls = calls.filter((c) => /\/sections\//.test(c.url));
    expect(sectionCalls).toHaveLength(0);
  });

  it("still returns the created parent (no throw) when the configured section add errors", async () => {
    const { fetchImpl } = makeMockFetch({ failSectionAdd: true });
    const client = createAsanaRestClient({ accessToken: config.accessToken, fetch: fetchImpl });
    const adapter = createAsanaTaskAdapter({
      client,
      config: { ...config, sectionGid: "SECTION_1" },
      asanaTaskSimilarityThreshold: 0,
      env: { ASANA_MAX_RETRIES: "0" },
    });

    const result = await adapter(makeTask());
    expect(result.created).toBe(true);
    expect(result.parentGid).toBe("PARENT_GID");
  });

  it("retries a transient 5xx on the parent create and then succeeds", async () => {
    let parentAttempts = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && /\/tasks(\?|$)/.test(url.replace(BASE, ""))) {
        parentAttempts += 1;
        if (parentAttempts === 1) {
          return new Response(JSON.stringify({ errors: [{ message: "upstream" }] }), {
            status: 503,
          });
        }
        return new Response(JSON.stringify({ data: { gid: "PARENT_GID" } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "POST" && /\/tasks\/[^/]+\/subtasks/.test(url)) {
        return new Response(JSON.stringify({ data: { gid: "SUB" } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = createAsanaRestClient({ accessToken: config.accessToken, fetch: fetchImpl });
    const adapter = createAsanaTaskAdapter({
      client,
      config,
      asanaTaskSimilarityThreshold: 0,
      env: { ASANA_MAX_RETRIES: "2", ASANA_REQUEST_TIMEOUT_MS: "5000" },
    });

    const result = await adapter(makeTask());
    expect(result.created).toBe(true);
    expect(result.parentGid).toBe("PARENT_GID");
    expect(parentAttempts).toBe(2);
  });
});

describe("createAsanaTaskAdapter wired through runMonitor (dry-run)", () => {
  it("creates NOTHING in dry-run (adapter never called)", async () => {
    const { runMonitor } = await import("@/pipeline/run-monitor");
    const { createStubReplyModel } = await import("@/agent/reply-generation");
    const { loadPromptBundle } = await import("@/config/load-prompts");
    const { SETTINGS_DEFAULTS } = await import("@/config/load-settings");
    const { resolve } = await import("node:path");

    const adapter = vi.fn(async () => ({ created: true, reason: "created", parentGid: "X" }));
    const prompts = loadPromptBundle(resolve(__dirname, "..", "prompts"));

    const { summary } = await runMonitor({
      posts: [
        {
          statusId: "1",
          sourceUri: "https://x.com/a/status/1",
          text: "On-chain property records and tokenized real-world assets.",
          author: "A",
          handle: "a",
          contentType: "post",
        },
      ],
      settings: {
        ...SETTINGS_DEFAULTS,
        excludeAuthors: [...SETTINGS_DEFAULTS.excludeAuthors],
      },
      watchlist: [{ author: "A", handle: "a", aliases: { handles: [], authors: [] }, active: true }],
      prompts,
      dryRun: true,
      deps: {
        model: createStubReplyModel(),
        createAsanaTask: adapter,
        // Stub MCP so no network: one above-threshold match.
        queryClient: async () => [
          {
            id: "m1",
            score: 0.82,
            title: "Title",
            sourceUri: "https://soofi.xyz/a",
            content: 'Records become "verifiable on-chain".',
          },
        ],
      },
    });

    expect(adapter).not.toHaveBeenCalled();
    expect(summary.dryRun).toBe(true);
    expect(summary.counts.tasksCreated).toBe(0);
  });
});
