import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { settingsSchema, watchlistSchema, type Settings, type Watchlist } from "./schema.js";
import { loadPrompts, type PromptSet } from "./prompts.js";

export * from "./schema.js";
export * from "./prompts.js";

export interface AgentConfig {
  settings: Settings;
  watchlist: Watchlist;
  prompts: PromptSet;
  /** Absolute root the config was loaded from. */
  root: string;
}

function loadYaml<T>(path: string, parse: (data: unknown) => T): T {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`Config file not found: ${path}`);
  }
  const data = parseYaml(raw);
  return parse(data);
}

/**
 * Load and validate all code-managed configuration. Throws a readable error on
 * any malformed file so the CLI / CI can fail fast.
 *
 * @param root project root containing `config/` and `prompts/` (default cwd).
 */
export function loadConfig(root: string = process.cwd()): AgentConfig {
  const abs = resolve(root);
  const settings = loadYaml(join(abs, "config", "settings.yaml"), (d) => settingsSchema.parse(d));
  const watchlist = loadYaml(join(abs, "config", "watchlist.yaml"), (d) => watchlistSchema.parse(d));
  const prompts = loadPrompts(join(abs, "prompts"));
  return { settings, watchlist, prompts, root: abs };
}
