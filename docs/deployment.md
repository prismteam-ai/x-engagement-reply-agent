# Deployment & operations

## Agent summary (for Agent Network registration)

| Field | Value |
|-------|-------|
| **Purpose** | Monitor watched X authors, match new posts to Soofi articles, draft recommended replies, and create Asana approval tasks for human posting. |
| **Trigger** | Scheduled (EventBridge rule in prod; local scheduler/CLI for dev). |
| **Inputs** | `config/watchlist.yaml`, `config/settings.yaml`, `prompts/**`, X API, investors-mcp. |
| **Outputs** | Asana parent tasks + approval subtasks; structured run summaries (logs + state). |
| **Dependencies** | investors-mcp (`queryInvestorContent`), X API v2, Asana API, an LLM provider (via Vercel AI SDK), LangSmith (optional). |
| **Side effects** | Asana writes only. **Never posts to X.** No corpus writes. |
| **Dry-run** | `--dry-run` performs matching + drafting with zero Asana/state side effects. |

## Required credentials

| Secret | Used by | Required |
|--------|---------|----------|
| `OPENAI_API_KEY` *or* AWS Bedrock creds | reply generation | yes (per `modelId`) |
| `X_BEARER_TOKEN` | live X driver | only for `--live` / `X_DRIVER=live` |
| `ASANA_PERSONAL_ACCESS_TOKEN` | Asana writes | yes for non-dry runs |
| `LANGSMITH_API_KEY` (+ project) | LLM tracing | optional |
| `MCP_READ_TOKEN` | investors-mcp | not required today (read is open) |

## Local run

```bash
pnpm install
cp .env.example .env          # fill in keys
pnpm run validate-config      # validate config + prompts
pnpm run run:dry              # full pipeline, no side effects (fixture X driver)
pnpm run run                  # creates Asana tasks (needs Asana + LLM creds)
pnpm run run -- --author=balajis --dry-run   # single-author isolation
pnpm run run -- --live       # poll the real X API
```

Scheduled local polling: wrap `pnpm run run` in any scheduler (cron, `node-cron`,
Task Scheduler) at `pollIntervalMinutes`.

## Local dev environment (Docker Compose)

A `docker-compose.yml` brings up a full local stack so you can exercise the real
`DynamoStateStore` (the production state path) without touching AWS:

| Service | Purpose | Port |
|---------|---------|------|
| `dynamodb` | [DynamoDB Local](https://hub.docker.com/r/amazon/dynamodb-local) (persistent volume) | 8000 |
| `dynamodb-init` | One-shot: creates the `AgentState` table + TTL | — |
| `dynamodb-admin` | Web UI to browse/edit local state | 8001 |
| `agent` | Optional: the agent's poll loop, containerized (profile `agent`) | — |

```bash
pnpm run dev:up                       # start DynamoDB Local + admin UI + table init
open http://localhost:8001            # browse the AgentState table

# Run the agent on the host against the local DB:
STATE_STORE=dynamo AGENT_STATE_TABLE=AgentState \
DYNAMODB_ENDPOINT=http://localhost:8000 pnpm run run

# …or run everything (including the agent watch loop) in containers:
docker compose --profile agent up

pnpm run dev:down                     # stop the stack
```

The DynamoDB integration test runs against this stack when an endpoint is set
(otherwise it auto-skips, so CI without Docker stays green):

```bash
DYNAMODB_ENDPOINT=http://localhost:8000 pnpm test
```

`pnpm run dynamo:init` creates the table from the host (idempotent) if you bring
up DynamoDB Local some other way.

## Production deployment (AWS golden path)

`src/handler.ts` is the AWS Lambda handler — it runs the identical pipeline as the
CLI, with Powertools Logger/Tracer/Metrics wrapped around it. `infra/` is a real,
deployable CDK app (IaC: CDK only, region `us-east-2`):

```
EventBridge rule (rate = pollIntervalMinutes)
  → Lambda (handler.ts, ARM64, X-Ray active)
      → DynamoDB AgentState (StateStore: cursors, dedupe, run summaries)
      → Secrets Manager (X / Asana / LLM / LangSmith secrets, loaded at cold start)
      → investors-mcp (queryInvestorContent over HTTPS)
      → Asana API
  → CloudWatch Logs (90-day) + X-Ray traces; LangSmith for LLM runs
```

State is selected by env, not code: `STATE_STORE=dynamo` switches the pipeline from
the local `FileStateStore` to `DynamoStateStore` (`src/state/dynamo-store.ts`) against
the CDK-provisioned table — same `StateStore` interface, no pipeline changes.

```bash
cd infra
pnpm install
pnpm run synth                 # validate the stack
npx cdk bootstrap aws://<account>/us-east-2   # first time only
npx cdk deploy                 # outputs table name, secret ARN, function name
```

After deploy, populate the credentials secret (one JSON object of env vars) — see
[`infra/README.md`](../infra/README.md) for the exact command and table schema.

## Observability

- **Logs:** structured JSON (Powertools Logger on the Lambda; Powertools-shaped logger
  in the pipeline). `LOG_LEVEL` controls verbosity. CloudWatch retention is 90 days.
- **Traces:** X-Ray active tracing on the function; the handler opens a `runMonitor`
  subsegment and annotates `dryRun`.
- **Metrics (Powertools, EMF → CloudWatch):** emitted from each run under namespace
  `XEngagementReplyAgent`:

  | Metric | Unit | Meaning |
  |--------|------|---------|
  | `AuthorsPolled` | Count | Authors in the batch this run |
  | `PostsProcessed` | Count | New posts processed |
  | `PostsSkipped` | Count | Posts skipped (dedupe / below threshold / excluded) |
  | `PostsFailed` | Count | Posts that errored |
  | `ParentTasksCreated` | Count | Asana parent tasks created |
  | `SubtasksCreated` | Count | Asana approval subtasks created |
  | `ProcessingDuration` | Milliseconds | Wall-clock per run |
  | `RunFailed` | Count | Run-level failure |

  > Per the observability standard, every metric must also be registered in the
  > Lexicon (`cloudwatch-metrics.json`) and shown on the Main Dashboard. Those live in
  > separate repos and are a deploy-time follow-up (tracked, not yet wired here).

- **Run summary:** a `RunSummary` is emitted and persisted per run (authors polled,
  posts fetched, new processed, parent/subtask counts, skips/failures with reasons).
- **LLM runs:** every draft is a LangSmith run tagged with `modelId`, `promptLabel`,
  `promptFile`, matched article, raw score, and token usage; tracing flushes before
  the call returns.
