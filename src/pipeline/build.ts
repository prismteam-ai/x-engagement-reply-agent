import { join } from "node:path";
import type { AgentConfig } from "../config/index.js";
import { loadConfig } from "../config/index.js";
import { McpClient } from "../mcp/client.js";
import { ReplyGenerator } from "../llm/reply-generator.js";
import { LangSmithTracer } from "../llm/langsmith.js";
import { AsanaApiClient, type AsanaClient } from "../asana/client.js";
import { DryRunAsanaClient } from "../asana/dry-run-client.js";
import { createStateStore } from "../state/factory.js";
import { loadFixtureClient, type FixtureXClient } from "../x/fixture-driver.js";
import { existsSync } from "node:fs";
import { LiveXClient } from "../x/live-driver.js";
import type { XClient } from "../x/client.js";
import { createLogger } from "../observability/logger.js";
import type { MonitorDeps } from "./monitor.js";

/**
 * Wire concrete drivers from config + environment. The X driver and Asana driver
 * are selected here (fixture vs live, dry-run vs api) so the pipeline stays pure.
 */
export interface BuildOptions {
  root?: string;
  dryRun: boolean;
  /** Override the X driver; defaults to env X_DRIVER ("fixture" | "live"). */
  xDriver?: "fixture" | "live";
}

export function buildXClient(config: AgentConfig, driver: "fixture" | "live"): XClient {
  if (driver === "live") {
    return new LiveXClient();
  }
  // Merge demo fixtures (fixtures/) with the reference examples fixtures.
  const clients = [join(config.root, "fixtures"), join(config.root, "examples", "reference", "fixtures")]
    .filter((d) => existsSync(d))
    .map((d) => loadFixtureClient(d));
  return mergeFixtureClients(clients);
}

function mergeFixtureClients(clients: FixtureXClient[]): XClient {
  return {
    async fetchAuthorPosts(params) {
      const all = await Promise.all(clients.map((c) => c.fetchAuthorPosts(params)));
      const seen = new Set<string>();
      const merged = all.flat().filter((p) => {
        const k = `${p.sourceUri}::${p.statusId}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      return merged.slice(0, params.maxResults);
    },
  };
}

export function buildDeps(opts: BuildOptions): MonitorDeps {
  const config = loadConfig(opts.root);
  const logger = createLogger();
  const driver = opts.xDriver ?? ((process.env.X_DRIVER as "fixture" | "live") || "fixture");

  const x = buildXClient(config, driver);
  const mcp = new McpClient({ logger: logger.child({ component: "mcp" }) });
  const tracer = new LangSmithTracer({ logger: logger.child({ component: "langsmith" }) });
  const replies = new ReplyGenerator({
    settings: config.settings,
    prompts: config.prompts,
    tracer,
    logger: logger.child({ component: "reply-generator" }),
  });

  const asana: AsanaClient = opts.dryRun
    ? new DryRunAsanaClient(logger.child({ component: "asana-dry-run" }))
    : new AsanaApiClient({ config: config.settings.asana, logger: logger.child({ component: "asana" }) });

  const state = createStateStore(config.root, logger.child({ component: "state" }));

  return { config, x, mcp, replies, asana, state, logger, dryRun: opts.dryRun };
}
