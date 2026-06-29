import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunMonitorResult } from "@/pipeline/run-monitor";
import type { RunSummary } from "@/observability/logger";

const runFromConfig = vi.fn();
const saveLatestRun = vi.fn();
const saveShowcaseRun = vi.fn();
const readLatestRun = vi.fn();
const readShowcaseRun = vi.fn();

vi.mock("@/pipeline/run-from-config", () => ({
  runFromConfig: (...args: unknown[]) => runFromConfig(...args),
}));
vi.mock("@/pipeline/run-store", () => ({
  saveLatestRun: (...args: unknown[]) => saveLatestRun(...args),
  saveShowcaseRun: (...args: unknown[]) => saveShowcaseRun(...args),
  readLatestRun: (...args: unknown[]) => readLatestRun(...args),
  readShowcaseRun: (...args: unknown[]) => readShowcaseRun(...args),
}));

const SECRET = "test-cron-secret";

function fakeSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runKey: "run-test",
    startedAt: "2026-06-22T00:00:00.000Z",
    finishedAt: "2026-06-22T00:00:01.000Z",
    dryRun: true,
    counts: {
      authorsPolled: 1,
      postsFetched: 1,
      newPosts: 1,
      matched: 1,
      tasksWouldCreate: 1,
      tasksCreated: 0,
      skipped: 0,
      failures: 0,
      skipReasons: {},
    },
    posts: [],
    ...overrides,
  };
}

const fakeResult: RunMonitorResult = { organic: true, summary: fakeSummary(), tasks: [] };

function bearer(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

describe("GET/POST /api/monitor-x", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    runFromConfig.mockReset();
    saveLatestRun.mockReset();
    saveShowcaseRun.mockReset();
    readLatestRun.mockReset();
    readShowcaseRun.mockReset();
    runFromConfig.mockResolvedValue(fakeResult);
    saveLatestRun.mockResolvedValue({ ...fakeResult, savedAt: "now" });
    saveShowcaseRun.mockResolvedValue(null);
    readLatestRun.mockResolvedValue(null);
    readShowcaseRun.mockResolvedValue(null);
  });

  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  it("default dry-run returns the persisted snapshot when one exists", async () => {
    readShowcaseRun.mockResolvedValue({ ...fakeResult, savedAt: "2026-06-22T00:00:00.000Z" });
    const { GET } = await import("../app/api/monitor-x/route");
    const res = await GET(new Request("http://localhost/api/monitor-x"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; source: string; summary: RunSummary };
    expect(body.ok).toBe(true);
    expect(body.source).toBe("snapshot");
    expect(body.summary.dryRun).toBe(true);
    expect(runFromConfig).not.toHaveBeenCalled();
    expect(saveLatestRun).not.toHaveBeenCalled();
    expect(saveShowcaseRun).not.toHaveBeenCalled();
  });

  it("default dry-run returns source:none (200) when no snapshot exists yet", async () => {
    const { GET } = await import("../app/api/monitor-x/route");
    const res = await GET(new Request("http://localhost/api/monitor-x"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; source: string; message: string };
    expect(body.ok).toBe(true);
    expect(body.source).toBe("none");
    expect(body.message).toContain("No organic run available yet");
    expect(runFromConfig).not.toHaveBeenCalled();
  });

  it("an authorized ?dryRun=false real run passes dryRun + author through to the pipeline", async () => {
    const { POST } = await import("../app/api/monitor-x/route");
    const res = await POST(
      new Request("http://localhost/api/monitor-x?dryRun=false&author=balajis", {
        headers: bearer(SECRET),
      }),
    );
    expect(res.status).toBe(200);
    expect(runFromConfig).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: false, authorHandle: "balajis" }),
    );
    expect(saveShowcaseRun).toHaveBeenCalledWith(fakeResult);
  });

  it("an authorized real run accepts the secret via ?key=", async () => {
    const { GET } = await import("../app/api/monitor-x/route");
    const res = await GET(
      new Request(`http://localhost/api/monitor-x?dryRun=false&key=${SECRET}`),
    );
    expect(res.status).toBe(200);
    expect(runFromConfig).toHaveBeenCalledOnce();
  });

  it("an UNAUTHORIZED real run is rejected with 401 (no pipeline call)", async () => {
    const { GET } = await import("../app/api/monitor-x/route");
    const res = await GET(new Request("http://localhost/api/monitor-x?dryRun=false"));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("unauthorized");
    expect(runFromConfig).not.toHaveBeenCalled();
  });

  it("an UNAUTHORIZED ?showcase=true is rejected with 401 (no pipeline call)", async () => {
    const { GET } = await import("../app/api/monitor-x/route");
    const res = await GET(new Request("http://localhost/api/monitor-x?showcase=true"));
    expect(res.status).toBe(401);
    expect(runFromConfig).not.toHaveBeenCalled();
  });

  it("a wrong secret is rejected with 401", async () => {
    const { GET } = await import("../app/api/monitor-x/route");
    const res = await GET(
      new Request("http://localhost/api/monitor-x?dryRun=false", {
        headers: bearer("wrong-secret"),
      }),
    );
    expect(res.status).toBe(401);
    expect(runFromConfig).not.toHaveBeenCalled();
  });

  it("real runs are rejected with 401 when CRON_SECRET is unset (fail closed)", async () => {
    delete process.env.CRON_SECRET;
    const { GET } = await import("../app/api/monitor-x/route");
    const res = await GET(
      new Request("http://localhost/api/monitor-x?dryRun=false", { headers: bearer(SECRET) }),
    );
    expect(res.status).toBe(401);
    expect(runFromConfig).not.toHaveBeenCalled();
  });

  it("an authorized ?showcase=true forces a REAL, fully ORGANIC run (live poll, no injected fixture)", async () => {
    const { GET } = await import("../app/api/monitor-x/route");
    const res = await GET(
      new Request("http://localhost/api/monitor-x?showcase=true", { headers: bearer(SECRET) }),
    );
    expect(res.status).toBe(200);
    const call = runFromConfig.mock.calls.at(-1)?.[0] as {
      dryRun: boolean;
      skipState?: boolean;
      posts?: unknown[];
      deps?: { fetchPosts?: unknown };
    };
    expect(call.dryRun).toBe(false);
    expect(call.posts).toBeUndefined();
    expect(call.deps?.fetchPosts).toBeUndefined();
    expect(call.skipState).toBe(true);
    expect(saveShowcaseRun).toHaveBeenCalledOnce();
  });

  it("a showcase-save failure does not fail an authorized real run (logged + swallowed)", async () => {
    saveShowcaseRun.mockRejectedValueOnce(new Error("ddb down"));
    const { GET } = await import("../app/api/monitor-x/route");
    const res = await GET(
      new Request("http://localhost/api/monitor-x?dryRun=false", { headers: bearer(SECRET) }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("returns a 500 JSON error when the pipeline throws on an authorized real run", async () => {
    runFromConfig.mockRejectedValueOnce(new Error("mcp unreachable"));
    const { GET } = await import("../app/api/monitor-x/route");
    const res = await GET(
      new Request("http://localhost/api/monitor-x?dryRun=false", { headers: bearer(SECRET) }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; error: string; message: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("monitor-failed");
    expect(body.message).not.toContain("mcp unreachable");
    expect(body.message).toMatch(/server logs/i);
  });

  it("exports the nodejs runtime", async () => {
    const mod = await import("../app/api/monitor-x/route");
    expect(mod.runtime).toBe("nodejs");
  });
});
