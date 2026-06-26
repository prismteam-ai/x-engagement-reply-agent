# Infrastructure (CDK)

Deployable CDK app for the X Engagement Reply Agent. Golden path: **AWS + CDK
only**, primary region `us-east-2`, all resources tagged `project_name`.

## Stack: `XEngagementReplyAgentStack`

```
EventBridge Rule (rate = pollIntervalMinutes)
  └─ targets ─> Lambda  (src/handler.ts via NodejsFunction, ARM64, X-Ray active)
                  ├─ env: STATE_STORE=dynamo, AGENT_STATE_TABLE, AGENT_SECRETS_ARN,
                  │        X_DRIVER, LANGSMITH_*, POWERTOOLS_*
                  ├─ Secrets Manager: one JSON credentials secret           [read]
                  ├─ DynamoDB AgentState: cursors, dedupe, run summaries     [read/write]
                  └─ egress: investors-mcp (HTTPS), X API, Asana API, LLM provider
Observability: CloudWatch Logs (90-day retention) + X-Ray; LangSmith for LLM runs
```

Resources synthesized: `AWS::DynamoDB::Table`, `AWS::Lambda::Function`,
`AWS::Events::Rule`, `AWS::SecretsManager::Secret`, `AWS::Logs::LogGroup`,
plus the IAM role/policy and the EventBridge invoke permission.

## DynamoDB table `AgentState`

Single-table design backing the `StateStore` interface
(`../src/state/dynamo-store.ts`). `PAY_PER_REQUEST`, PITR on, TTL attribute `ttl`.

| pk | sk | Attributes |
|----|----|-----------|
| `CURSOR#<handle>` | `-` | `statusId` |
| `OFFSET` | `-` | `batchOffset` |
| `PROCESSED#<dedupeKey>` | `-` | `ttl` |
| `TASKED#<dedupeKey>` | `-` | `ttl` |
| `RUN#<isoTimestamp>` | `-` | `summary`, `ttl` |
| `META` | `LASTRUN` | `lastRunAt` |

## Deploy

```bash
cd infra
pnpm install
pnpm run synth                      # assemble + validate (no AWS needed)

# First time in an account/region:
npx cdk bootstrap aws://<account>/us-east-2

# Provide credentials, then deploy:
npx cdk deploy
```

`cdk deploy` outputs the table name, the credentials secret ARN, and the function
name. Populate the secret with a JSON object of the agent's env vars:

```bash
aws secretsmanager put-secret-value \
  --secret-id x-engagement-reply-agent/credentials \
  --secret-string '{
    "OPENAI_API_KEY": "...",
    "X_BEARER_TOKEN": "...",
    "ASANA_PERSONAL_ACCESS_TOKEN": "...",
    "LANGSMITH_API_KEY": "..."
  }'
```

`loadSecretsIntoEnv()` (`../src/secrets.ts`) reads this secret at cold start and
merges the keys into `process.env`, so the runtime uses the same env vars it does
locally. Secret **values are never logged** — only the set of keys loaded.

### Context / parameters

| Context key | Default | Purpose |
|-------------|---------|---------|
| `pollIntervalMinutes` | `5` | EventBridge cadence — keep aligned with `config/settings.yaml` |
| `xDriver` | `live` | `live` or `fixture` for the deployed function |
| `secretsArn` | — | Import an existing credentials secret instead of creating one |

```bash
npx cdk deploy -c pollIntervalMinutes=2 -c secretsArn=arn:aws:secretsmanager:...
```

## Notes

- The Lambda bundle ships `config/` and `prompts/` alongside the code (esbuild
  `commandHooks`), so the runtime loads the same version-controlled config it does
  locally. Bundling runs `cp` in `afterBundling`, so `cdk synth`/`deploy` needs a
  POSIX shell (Linux/macOS CI, WSL, or Git Bash on Windows).
- Metrics emitted by the handler (`PostsProcessed`, `PostsFailed`,
  `ParentTasksCreated`, `SubtasksCreated`, `ProcessingDuration`, …) must also be
  registered in the Lexicon (`cloudwatch-metrics.json`) and shown on the Main
  Dashboard per the observability standard — see `../docs/deployment.md`.
