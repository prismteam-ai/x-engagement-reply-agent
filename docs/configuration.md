# Configuration & prompt schema

All operational behavior is code-managed. There is no admin UI or database — edit
files under `config/` and `prompts/`, then redeploy. `pnpm run validate-config`
(also a CI gate) validates everything and fails fast on malformed files.

## `config/watchlist.yaml`

Replaces the investors-mcp `managed_authors` table.

```yaml
authors:
  - author: "Balaji Srinivasan"   # display name
    handle: "balajis"              # X handle, no leading @
    company: "independent"          # free-form label (optional)
    aliases:                        # optional alternate identities
      handles: []
      authors: []
    active: true                    # false = not polled
    excludeFromTasking: false       # true = polled but never tasked (e.g. corpus author)
```

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `author` | string | yes | — | Display name |
| `handle` | string | yes | — | X handle without `@` |
| `company` | string | no | `""` | Label only |
| `aliases.handles` | string[] | no | `[]` | Alternate handles |
| `aliases.authors` | string[] | no | `[]` | Alternate author names |
| `active` | boolean | no | `true` | Polled when true |
| `excludeFromTasking` | boolean | no | `false` | Skip task creation for this author |

## `config/settings.yaml`

Replaces the investors-mcp `automation_settings` table.

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `pollIntervalMinutes` | number | `2` | Scheduler cadence (enforced by EventBridge/cron) |
| `defaultBatchSize` | int | `5` | Authors per run (cursor rotation across the watchlist) |
| `defaultMaxPostsPerAuthor` | int | `20` | Max posts fetched per author per run |
| `defaultTopK` | int (1–20) | `6` | `topK` for `queryInvestorContent` — **server caps at 20** (shipped config uses `20`) |
| `asanaTaskSimilarityThreshold` | number (0–1) | `0` | Best-match raw similarity gate for the **parent task** (0 = always) |
| `articleSimilarityThreshold` | number (0–1) | `0.7` | Per-article raw similarity gate for **recommendation subtasks** |
| `modelId` | string | `openai/gpt-4.1-mini` | `<provider>/<model>`; `openai/*` or `bedrock/*` |
| `asana.*` | object | — | Asana routing (see below) |

### `asana` block

| Field | Notes |
|-------|-------|
| `workspace` | Asana workspace GID |
| `project` | Project GID the parent task is added to |
| `section` | Optional section GID |
| `defaultAssignee` | Assignee GID for normal tasks |
| `thresholdAssigneeRawScore` | When best-match raw ≥ this, route to `thresholdAssignee` + due today |
| `thresholdAssignee` | Assignee GID for high-similarity posts |
| `parentSimilarityFieldId` | Custom-field GID to write best-match raw score on the parent |
| `subtaskSimilarityFieldId` | Custom-field GID to write per-article raw score on subtasks |

## Prompt files (`prompts/`)

| File | Purpose |
|------|---------|
| `system.md` | System prompt — Soofi's voice and grounding rules |
| `constraints.md` | Global response constraints (≤280 chars, tone, quoted phrase, question) |
| `replies/NN-*.md` | One reply slot per file |

### Reply slot files — `prompts/replies/NN-name.md`

- Discovered by glob and ordered by the **numeric filename prefix** (`01-`, `02-`, …).
- The first `# heading` line is the title; the rest is the instruction body.
- **Add a reply variant** = drop a new `NN-name.md` file in. **Remove** = delete the file.
  **Reorder** = renumber the prefixes. No code change, no migration, no UI.
- The label is derived as `Prompt <N>` and flows into the Asana subtask name and the
  LangSmith run metadata.
- A reply file may explicitly override the global "end with a question" rule by saying so
  in its body (see `05-question-first.md`).

## Environment variables

See `.env.example`. Secrets stay in `.env` locally and in AWS Secrets Manager in prod.
Config files never contain secrets — only behavior.

### Runtime selectors (env, not YAML)

| Variable | Values | Default | Purpose |
|----------|--------|---------|---------|
| `X_DRIVER` | `fixture` \| `live` | `fixture` | X data source (fixture is offline/deterministic) |
| `STATE_STORE` | `file` \| `dynamo` | `file` | Where runtime state is persisted |
| `AGENT_STATE_TABLE` | string | — | DynamoDB table name; **required** when `STATE_STORE=dynamo` |
| `STATE_TTL_DAYS` | int | `90` | TTL on processed/tasked dedupe keys (DynamoDB) |
| `AGENT_SECRETS_ARN` | ARN | — | Secrets Manager secret to load into env at Lambda cold start |
| `DRY_RUN` | `true` \| `false` | `false` | Lambda dry-run (no Asana/state writes) |
| `LOG_LEVEL` | `debug`…`error` | `info` | Log verbosity |

State persistence is selected at runtime: locally the agent writes
`data/state.json` (`FileStateStore`); in production `STATE_STORE=dynamo` switches
to `DynamoStateStore` against the CDK-provisioned table — **no pipeline code
changes**, same `StateStore` interface.
