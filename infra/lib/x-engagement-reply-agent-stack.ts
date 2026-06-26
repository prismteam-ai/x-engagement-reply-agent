import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

/** Repo root of the agent (one level above infra/). */
const AGENT_ROOT = path.join(__dirname, "..", "..");

export interface AgentStackProps extends cdk.StackProps {
  /** EventBridge poll cadence in minutes (keep aligned with config/settings.yaml). */
  pollIntervalMinutes: number;
  /** X data source for the deployed function. */
  xDriver: "fixture" | "live";
  /** Import an existing credentials secret by ARN; otherwise an empty one is created. */
  secretsArn?: string;
}

/**
 * X Engagement Reply Agent — scheduled polling agent.
 *
 *   EventBridge Rule (rate = pollIntervalMinutes)
 *     └─> Lambda (src/handler.ts via NodejsFunction, X-Ray active)
 *           ├─ DynamoDB AgentState (cursors, dedupe, run summaries)  [read/write]
 *           └─ Secrets Manager (X / Asana / LLM / LangSmith creds)   [read]
 *   Logs → CloudWatch (90-day retention); LLM runs → LangSmith.
 *
 * Golden path: AWS + CDK only, us-east-2, all resources tagged `project_name`.
 */
export class XEngagementReplyAgentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AgentStackProps) {
    super(scope, id, props);

    // --- State: single-table DynamoDB (see src/state/dynamo-store.ts) ---
    const table = new dynamodb.Table(this, "AgentState", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // --- Credentials: one JSON secret, loaded into env at cold start ---
    const secret = props.secretsArn
      ? secretsmanager.Secret.fromSecretCompleteArn(this, "Secrets", props.secretsArn)
      : new secretsmanager.Secret(this, "Secrets", {
          secretName: "x-engagement-reply-agent/credentials",
          description:
            "JSON of env vars for the agent: OPENAI_API_KEY, X_BEARER_TOKEN, ASANA_PERSONAL_ACCESS_TOKEN, LANGSMITH_API_KEY",
        });

    // --- Compute: scheduled Lambda running the identical pipeline as the CLI ---
    const logGroup = new logs.LogGroup(this, "AgentLogs", {
      retention: logs.RetentionDays.THREE_MONTHS, // 90 days per observability standard
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const fn = new NodejsFunction(this, "Agent", {
      entry: path.join(AGENT_ROOT, "src", "handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.minutes(5),
      tracing: lambda.Tracing.ACTIVE, // X-Ray
      logGroup,
      projectRoot: AGENT_ROOT,
      depsLockFilePath: path.join(AGENT_ROOT, "pnpm-lock.yaml"),
      environment: {
        STATE_STORE: "dynamo",
        AGENT_STATE_TABLE: table.tableName,
        AGENT_SECRETS_ARN: secret.secretArn,
        X_DRIVER: props.xDriver,
        LANGSMITH_TRACING: "true",
        LANGSMITH_PROJECT: "x-engagement-reply-agent",
        LANGSMITH_ENDPOINT: "https://api.smith.langchain.com",
        LOG_LEVEL: "info",
        POWERTOOLS_SERVICE_NAME: "x-engagement-reply-agent",
        POWERTOOLS_METRICS_NAMESPACE: "XEngagementReplyAgent",
      },
      bundling: {
        target: "node20",
        // The pipeline reads code-managed config + prompts from disk at runtime,
        // so ship them alongside the bundle (loaded relative to the task root).
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir: string, outputDir: string) => [
            `cp -r ${inputDir}/config ${outputDir}/config`,
            `cp -r ${inputDir}/prompts ${outputDir}/prompts`,
          ],
        },
      },
    });

    table.grantReadWriteData(fn);
    secret.grantRead(fn);

    // --- Trigger: scheduled poll ---
    new events.Rule(this, "Schedule", {
      description: "Poll watched X authors on the configured cadence",
      schedule: events.Schedule.rate(cdk.Duration.minutes(props.pollIntervalMinutes)),
      targets: [new targets.LambdaFunction(fn)],
    });

    cdk.Tags.of(this).add("project_name", "x-engagement-reply-agent");

    new cdk.CfnOutput(this, "StateTableName", { value: table.tableName });
    new cdk.CfnOutput(this, "CredentialsSecretArn", { value: secret.secretArn });
    new cdk.CfnOutput(this, "FunctionName", { value: fn.functionName });
  }
}
