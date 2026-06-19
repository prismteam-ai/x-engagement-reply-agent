import "dotenv/config";
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import { loadSecretsIntoEnv } from "./secrets.js";
import { buildDeps } from "./pipeline/build.js";
import { runMonitor } from "./pipeline/monitor.js";

/**
 * AWS Lambda adapter — the production seam. An EventBridge schedule invokes this
 * handler on the configured cadence (see infra/). The pipeline itself is the same
 * code path the CLI runs, so local and prod behavior stay identical.
 *
 * Observability follows the golden path: Powertools Logger + Tracer (X-Ray) +
 * Metrics. Business metrics are derived from the run summary and emitted as EMF
 * so CloudWatch alarms / the Main Dashboard can track agent health.
 *
 * NOTE: the metrics below must be registered in the Lexicon (cloudwatch-metrics.json)
 * and shown on the Main Dashboard — see docs/deployment.md.
 *
 * Set DRY_RUN=true on the function to run without side effects.
 */
const SERVICE_NAME = "x-engagement-reply-agent";
const METRICS_NAMESPACE = "XEngagementReplyAgent";

const logger = new Logger({ serviceName: SERVICE_NAME });
const tracer = new Tracer({ serviceName: SERVICE_NAME });
const metrics = new Metrics({ serviceName: SERVICE_NAME, namespace: METRICS_NAMESPACE });

export interface AgentEvent {
  dryRun?: boolean;
  /** Restrict the run to a single author handle (isolation). */
  author?: string;
}

export async function handler(event: AgentEvent = {}): Promise<unknown> {
  const dryRun = event.dryRun ?? (process.env.DRY_RUN ?? "false").toLowerCase() === "true";
  const start = Date.now();

  // Trace the whole run as a subsegment so downstream timing is visible in X-Ray.
  const segment = tracer.getSegment();
  const subsegment = segment?.addNewSubsegment("### runMonitor");
  if (subsegment) tracer.setSegment(subsegment);
  tracer.putAnnotation("dryRun", dryRun);

  try {
    await loadSecretsIntoEnv();
    const deps = buildDeps({ dryRun });
    const summary = await runMonitor(deps, { onlyHandle: event.author });

    metrics.addMetric("AuthorsPolled", MetricUnit.Count, summary.authorsPolled);
    metrics.addMetric("PostsProcessed", MetricUnit.Count, summary.newPostsProcessed);
    metrics.addMetric("PostsSkipped", MetricUnit.Count, summary.skipped);
    metrics.addMetric("PostsFailed", MetricUnit.Count, summary.failed);
    metrics.addMetric("ParentTasksCreated", MetricUnit.Count, summary.parentTasksCreated);
    metrics.addMetric("SubtasksCreated", MetricUnit.Count, summary.subtasksCreated);
    metrics.addMetric("ProcessingDuration", MetricUnit.Milliseconds, Date.now() - start);

    logger.info("run complete", {
      dryRun,
      authorsPolled: summary.authorsPolled,
      newPostsProcessed: summary.newPostsProcessed,
      parentTasksCreated: summary.parentTasksCreated,
      subtasksCreated: summary.subtasksCreated,
      skipped: summary.skipped,
      failed: summary.failed,
    });
    return { ok: true, summary: { ...summary, results: undefined } };
  } catch (err) {
    metrics.addMetric("RunFailed", MetricUnit.Count, 1);
    subsegment?.addError(err as Error);
    logger.error("run failed", { error: err instanceof Error ? err.stack : String(err) });
    throw err;
  } finally {
    subsegment?.close();
    if (segment) tracer.setSegment(segment);
    metrics.publishStoredMetrics();
  }
}
