import * as cdk from "aws-cdk-lib";
import { XEngagementReplyAgentStack } from "../lib/x-engagement-reply-agent-stack";

const app = new cdk.App();

const pollIntervalMinutes = Number(app.node.tryGetContext("pollIntervalMinutes") ?? 5);
const xDriver = (app.node.tryGetContext("xDriver") ?? "live") as "fixture" | "live";
const secretsArn = app.node.tryGetContext("secretsArn") as string | undefined;

new XEngagementReplyAgentStack(app, "XEngagementReplyAgentStack", {
  pollIntervalMinutes,
  xDriver,
  secretsArn,
  // Golden path: AWS primary region us-east-2. Account from the deploy environment.
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-2",
  },
});
