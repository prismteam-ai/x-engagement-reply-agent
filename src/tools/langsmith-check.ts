#!/usr/bin/env node
import "dotenv/config";

/**
 * Connectivity check for LangSmith. Posts one tiny "langsmith:check" run to the
 * configured project and reports the HTTP result, so you can confirm the key and
 * endpoint work before relying on tracing during the demo.
 *
 * Usage: pnpm run langsmith:check
 */
async function main(): Promise<void> {
  const apiKey = process.env.LANGSMITH_API_KEY;
  const endpoint = process.env.LANGSMITH_ENDPOINT ?? "https://api.smith.langchain.com";
  const project = process.env.LANGSMITH_PROJECT ?? "x-engagement-reply-agent";
  const tracing = (process.env.LANGSMITH_TRACING ?? "false").toLowerCase() === "true";

  console.log(`endpoint: ${endpoint}`);
  console.log(`project:  ${project}`);
  console.log(`LANGSMITH_TRACING: ${tracing}`);

  if (!apiKey) {
    console.error("\n✗ LANGSMITH_API_KEY is not set in .env. Add it and retry.");
    process.exitCode = 1;
    return;
  }
  if (!tracing) {
    console.warn("\n! LANGSMITH_TRACING is not 'true' — the agent will NOT emit traces during runs.");
    console.warn("  (Continuing the check anyway to validate the key.)");
  }

  const id = globalThis.crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const headers = { "Content-Type": "application/json", "x-api-key": apiKey };

  const createRes = await fetch(`${endpoint}/runs`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      id,
      name: "langsmith:check",
      run_type: "llm",
      start_time: startedAt,
      inputs: { check: "connectivity" },
      session_name: project,
      extra: { metadata: { source: "langsmith:check" } },
    }),
  });

  if (!createRes.ok) {
    console.error(`\n✗ Create run failed: HTTP ${createRes.status}`);
    console.error(`  ${await createRes.text()}`);
    console.error("  Common causes: wrong/expired API key, or wrong LANGSMITH_ENDPOINT (US vs EU).");
    process.exitCode = 1;
    return;
  }

  await fetch(`${endpoint}/runs/${id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ end_time: new Date().toISOString(), outputs: { ok: true } }),
  });

  console.log(`\n✓ LangSmith reachable and key accepted (run ${id}).`);
  console.log(`  Open LangSmith → Projects → "${project}" to see the "langsmith:check" run.`);
  if (!tracing) {
    console.log('  Reminder: set LANGSMITH_TRACING=true in .env so real runs are traced.');
  }
}

main().catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
