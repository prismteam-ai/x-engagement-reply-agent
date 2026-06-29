import { runFromConfig } from "@/pipeline/run-from-config";
import { readLatestRun, readShowcaseRun } from "@/pipeline/run-store";
import type { RunMonitorResult } from "@/pipeline/run-monitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const card: React.CSSProperties = {
  background: "#131822",
  border: "1px solid #232b3a",
  borderRadius: 10,
  padding: 16,
  marginBottom: 16,
};

const scorePill: React.CSSProperties = {
  display: "inline-block",
  background: "#1d3a2e",
  color: "#5fe0a3",
  borderRadius: 6,
  padding: "2px 8px",
  fontVariantNumeric: "tabular-nums",
  fontSize: 13,
  marginRight: 8,
};

async function loadRun(): Promise<{ result: RunMonitorResult; source: string }> {
  const showcase = await readShowcaseRun();
  if (showcase) {
    return {
      result: {
        summary: showcase.summary,
        tasks: showcase.tasks,
        organic: showcase.organic ?? true,
      },
      source: `real run snapshot (savedAt ${showcase.savedAt})`,
    };
  }
  const stored = await readLatestRun();
  if (stored) {
    return {
      result: {
        summary: stored.summary,
        tasks: stored.tasks,
        organic: stored.organic ?? true,
      },
      source: `saved snapshot (savedAt ${stored.savedAt})`,
    };
  }
  const result = await runFromConfig({ dryRun: true });
  return { result, source: "on-demand dry-run" };
}

export default async function StatusPage() {
  let result: RunMonitorResult;
  let source: string;
  let error: string | null = null;
  try {
    const loaded = await loadRun();
    result = loaded.result;
    source = loaded.source;
  } catch (err) {
    result = {
      organic: false,
      summary: {
        runKey: "",
        startedAt: "",
        finishedAt: "",
        dryRun: true,
        counts: {
          authorsPolled: 0,
          postsFetched: 0,
          newPosts: 0,
          matched: 0,
          tasksWouldCreate: 0,
          tasksCreated: 0,
          skipped: 0,
          failures: 0,
          skipReasons: {},
        },
        posts: [],
      },
      tasks: [],
    };
    source = "error";
    error = err instanceof Error ? err.message : String(err);
  }

  const { summary, tasks } = result;
  const counts = summary.counts;

  return (
    <main
      style={{ maxWidth: 900, margin: "0 auto", padding: "40px 24px" }}
      data-testid="status-page"
    >
      <h1 style={{ fontSize: 26, marginBottom: 4 }}>Latest Monitor Run</h1>
      <p style={{ color: "#9aa4b2", marginTop: 0 }}>
        Source: <span data-testid="run-source">{source}</span>
        {summary.dryRun ? " · dry-run (no Asana / X / Bedrock writes)" : " · LIVE"}
      </p>

      {error ? (
        <div style={{ ...card, borderColor: "#5a2330", color: "#ff8a9b" }}>
          Failed to produce a run: {error}
        </div>
      ) : null}

      <section style={card} data-testid="run-summary">
        <h2 style={{ fontSize: 18, marginTop: 0 }}>Run summary</h2>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
            gap: 8,
          }}
        >
          <Counter label="Authors polled" value={counts.authorsPolled} testId="count-authorsPolled" />
          <Counter label="Posts fetched" value={counts.postsFetched} testId="count-postsFetched" />
          <Counter label="New posts" value={counts.newPosts} testId="count-newPosts" />
          <Counter label="Matched" value={counts.matched} testId="count-matched" />
          <Counter
            label="Tasks would create"
            value={counts.tasksWouldCreate}
            testId="count-tasksWouldCreate"
          />
          <Counter label="Tasks created" value={counts.tasksCreated} testId="count-tasksCreated" />
          <Counter label="Skipped" value={counts.skipped} testId="count-skipped" />
          <Counter label="Failures" value={counts.failures} testId="count-failures" />
        </div>
        {summary.skipReason ? (
          <p style={{ color: "#ffcf8a", marginBottom: 0 }}>
            Run short-circuited: <strong>{summary.skipReason}</strong>
          </p>
        ) : null}
        {Object.keys(counts.skipReasons).length > 0 ? (
          <p style={{ color: "#9aa4b2", marginBottom: 0 }} data-testid="skip-reasons">
            Skip reasons:{" "}
            {Object.entries(counts.skipReasons)
              .map(([reason, n]) => `${reason} (${n})`)
              .join(", ")}
          </p>
        ) : null}
      </section>

      <section data-testid="would-be-tasks">
        <h2 style={{ fontSize: 18 }}>Would-be Asana tasks ({tasks.length})</h2>
        {tasks.length === 0 ? (
          <p style={{ color: "#9aa4b2" }}>No qualifying posts produced a task.</p>
        ) : (
          tasks.map((task) => (
            <article key={`${task.sourceUri}|${task.statusId}`} style={card} data-testid="task">
              <h3 style={{ fontSize: 16, marginTop: 0 }}>{task.name}</h3>
              <p style={{ margin: "4px 0" }}>
                <a href={task.sourceUri} style={{ color: "#5e9bff" }}>
                  {task.sourceUri}
                </a>
              </p>
              <p style={{ margin: "4px 0" }}>
                <span style={scorePill} data-testid="best-raw-score">
                  best raw {task.bestRawScore?.toFixed(4) ?? "none"}
                </span>
              </p>

              {task.created?.parentGid ? (
                <p style={{ margin: "4px 0" }} data-testid="created-asana">
                  <span
                    style={{ ...scorePill, background: "#1d2a3a", color: "#7fb5ff" }}
                  >
                    Created in Asana
                  </span>
                  {task.created.parentUrl ? (
                    <a href={task.created.parentUrl} style={{ color: "#5e9bff" }}>
                      parent {task.created.parentGid}
                    </a>
                  ) : (
                    <span>parent {task.created.parentGid}</span>
                  )}
                  <span style={{ color: "#9aa4b2" }}>
                    {" "}
                    · {task.created.subtaskGids?.length ?? 0} subtasks
                  </span>
                </p>
              ) : null}

              <h4 style={{ fontSize: 14, marginBottom: 6 }}>
                Matched Soofi articles ({task.recommendations.length})
              </h4>
              {task.recommendations.map((rec) => (
                <div
                  key={rec.sourceUri}
                  style={{ borderLeft: "2px solid #2a3447", paddingLeft: 12, marginBottom: 12 }}
                  data-testid="match"
                >
                  <div style={{ fontWeight: 600 }}>{rec.title}</div>
                  <div>
                    <span style={scorePill} data-testid="match-raw-score">
                      raw {rec.rawScore.toFixed(4)}
                    </span>
                    <span style={scorePill} data-testid="match-score">
                      score {rec.score}/100
                    </span>
                  </div>
                  {rec.whyRecommended ? (
                    <p style={{ color: "#9aa4b2", margin: "6px 0" }}>{rec.whyRecommended}</p>
                  ) : null}

                  <h5 style={{ fontSize: 13, margin: "8px 0 4px" }}>Drafted replies</h5>
                  <ol style={{ margin: 0, paddingLeft: 18 }}>
                    {(rec.suggestedResponses ?? []).map((resp) => (
                      <li key={resp.promptIndex} style={{ marginBottom: 8 }} data-testid="draft">
                        <div style={{ color: "#8ab4ff", fontSize: 12 }}>{resp.promptLabel}</div>
                        <div>{resp.text}</div>
                      </li>
                    ))}
                  </ol>
                </div>
              ))}

              <details style={{ marginTop: 8 }}>
                <summary style={{ cursor: "pointer", color: "#9aa4b2" }}>
                  Task notes ({task.subtasks.length} approval subtasks)
                </summary>
                <pre
                  style={{
                    whiteSpace: "pre-wrap",
                    background: "#0b0e14",
                    padding: 12,
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                >
                  {task.notes}
                </pre>
              </details>
            </article>
          ))
        )}
      </section>

      <section style={card} data-testid="per-post-outcomes">
        <h2 style={{ fontSize: 18, marginTop: 0 }}>Per-post outcomes</h2>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#9aa4b2" }}>
              <th style={{ padding: "4px 8px" }}>Status ID</th>
              <th style={{ padding: "4px 8px" }}>Outcome</th>
              <th style={{ padding: "4px 8px" }}>Reason</th>
              <th style={{ padding: "4px 8px" }}>Best raw</th>
            </tr>
          </thead>
          <tbody>
            {summary.posts.map((p) => (
              <tr key={`${p.sourceUri}|${p.statusId}`} style={{ borderTop: "1px solid #232b3a" }}>
                <td style={{ padding: "4px 8px", fontVariantNumeric: "tabular-nums" }}>
                  {p.statusId}
                </td>
                <td style={{ padding: "4px 8px" }}>{p.outcome}</td>
                <td style={{ padding: "4px 8px", color: "#9aa4b2" }}>{p.reason ?? ""}</td>
                <td style={{ padding: "4px 8px", fontVariantNumeric: "tabular-nums" }}>
                  {p.bestRawScore != null ? p.bestRawScore.toFixed(4) : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <details>
        <summary style={{ cursor: "pointer", color: "#9aa4b2" }}>Raw run summary JSON</summary>
        <pre
          style={{
            whiteSpace: "pre-wrap",
            background: "#0b0e14",
            padding: 12,
            borderRadius: 8,
            fontSize: 12,
          }}
          data-testid="raw-json"
        >
          {JSON.stringify(summary, null, 2)}
        </pre>
      </details>
    </main>
  );
}

function Counter({ label, value, testId }: { label: string; value: number; testId: string }) {
  return (
    <div style={{ background: "#0f141d", borderRadius: 8, padding: "10px 12px" }}>
      <div style={{ color: "#9aa4b2", fontSize: 12 }}>{label}</div>
      <div
        style={{ fontSize: 22, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}
        data-testid={testId}
      >
        {value}
      </div>
    </div>
  );
}
