# Usage

> Implementation of the agent specified in [`README.md`](./README.md).

📹 **The recorded demo, the full step-by-step demo walkthrough, and a captured dry-run sample are
provided in the pull request description.**

## Quickstart

```bash
pnpm install
cp .env.example .env          # add your keys (LLM, Asana; X only for --live)
pnpm run validate-config      # validate config + prompts
pnpm run run:dry              # full pipeline, fixtures + live MCP, no side effects
```

### Full local stack (Docker Compose)

Run the real DynamoDB-backed state path locally — DynamoDB Local + a web admin UI:

```bash
pnpm run dev:up               # DynamoDB Local (:8000) + admin UI (:8001) + table init
STATE_STORE=dynamo AGENT_STATE_TABLE=AgentState \
  DYNAMODB_ENDPOINT=http://localhost:8000 pnpm run run   # agent → local DynamoDB
pnpm run dev:down
```

See [`docs/deployment.md`](./docs/deployment.md#local-dev-environment-docker-compose) for details.

## Commands

| Command | What it does |
|---------|--------------|
| `pnpm run validate-config` | Parse + validate `config/**` and `prompts/**`; print summary |
| `pnpm run run:dry` | One polling pass, no Asana/state writes |
| `pnpm run run` | One polling pass, creates Asana tasks |
| `pnpm run run -- --author=<h>` | Restrict to one author |
| `pnpm run run -- --live` | Use the real X API (needs `X_BEARER_TOKEN`) |
| `pnpm run test` | Unit + integration tests |
| `pnpm run typecheck` / `lint` | Static checks |
| `pnpm run dev:up` / `dev:down` | Start/stop the Docker Compose dev stack (DynamoDB Local + UI) |
| `pnpm run dynamo:init` | Create the `AgentState` table against a local/remote endpoint |

## Where things live

| Path | Purpose |
|------|---------|
| `config/watchlist.yaml` | Watched authors (code-managed) |
| `config/settings.yaml` | Thresholds, batch, model, Asana routing |
| `prompts/system.md`, `constraints.md` | System prompt + global constraints |
| `prompts/replies/NN-*.md` | One reply slot per file (add/remove/reorder = file-only) |
| `fixtures/*.json` | Offline demo posts for the fixture X driver |
| `src/` | Pipeline, adapters (X / MCP / Asana / LLM / state) |
| `src/handler.ts`, `infra/` | AWS Lambda + CDK seam |
| `docs/configuration.md` | Full config & prompt schema |
| `docs/deployment.md` | Deploy steps, creds, observability |

See [`docs/configuration.md`](./docs/configuration.md) for the full schema. The
step-by-step demo walkthrough and the captured dry-run sample are in the PR description.
