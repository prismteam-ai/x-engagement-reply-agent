import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const DEFAULT_SETTINGS_PATH = resolve(process.cwd(), "config/settings.yaml");

export const SETTINGS_DEFAULTS = {
  pollIntervalMinutes: 2,
  defaultBatchSize: 5,
  defaultMaxPostsPerAuthor: 20,
  defaultTopK: 6,
  asanaTaskSimilarityThreshold: 0.7,
  articleSimilarityThreshold: 0.7,
  bedrockModelId: "anthropic.claude-3-5-sonnet-20240620-v1:0",
  excludeAuthors: [] as string[],
  paused: false,
  dryRun: false,
} as const;

const similarity = z
  .number({ message: "must be a number between 0 and 1" })
  .min(0, { message: "must be >= 0" })
  .max(1, { message: "must be <= 1" });

export const SettingsSchema = z
  .object({
    pollIntervalMinutes: z
      .number()
      .int({ message: "must be an integer" })
      .min(1, { message: "must be >= 1" })
      .max(24 * 60, { message: "must be <= 1440" })
      .default(SETTINGS_DEFAULTS.pollIntervalMinutes),
    defaultBatchSize: z
      .number()
      .int({ message: "must be an integer" })
      .min(1, { message: "must be >= 1" })
      .max(20, { message: "must be <= 20" })
      .default(SETTINGS_DEFAULTS.defaultBatchSize),
    defaultMaxPostsPerAuthor: z
      .number()
      .int({ message: "must be an integer" })
      .min(1, { message: "must be >= 1" })
      .max(100, { message: "must be <= 100" })
      .default(SETTINGS_DEFAULTS.defaultMaxPostsPerAuthor),
    defaultTopK: z
      .number()
      .int({ message: "must be an integer" })
      .min(1, { message: "must be >= 1" })
      .max(40, { message: "must be <= 40" })
      .default(SETTINGS_DEFAULTS.defaultTopK),
    asanaTaskSimilarityThreshold: similarity.default(
      SETTINGS_DEFAULTS.asanaTaskSimilarityThreshold,
    ),
    articleSimilarityThreshold: similarity.default(
      SETTINGS_DEFAULTS.articleSimilarityThreshold,
    ),
    bedrockModelId: z
      .string()
      .trim()
      .min(1, { message: "must be a non-empty string" })
      .max(200, { message: "must be <= 200 characters" })
      .default(SETTINGS_DEFAULTS.bedrockModelId),
    excludeAuthors: z
      .array(z.string().trim().min(1, { message: "entries must be non-empty" }))
      .default([...SETTINGS_DEFAULTS.excludeAuthors]),
    paused: z.boolean().default(SETTINGS_DEFAULTS.paused),
    dryRun: z.boolean().default(SETTINGS_DEFAULTS.dryRun),
  })
  .strict();

export type Settings = z.infer<typeof SettingsSchema>;

export function parseSettings(raw: unknown): Settings {
  const source = raw == null ? {} : raw;
  if (typeof source !== "object" || Array.isArray(source)) {
    throw new Error("settings.yaml must contain a YAML mapping (object) at the top level");
  }
  const result = SettingsSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid settings: ${formatZodError(result.error)}`);
  }
  return result.data;
}

export function parseSettingsYaml(yamlText: string): Settings {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    throw new Error(
      `Failed to parse settings YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseSettings(raw);
}

export function loadSettings(path: string = DEFAULT_SETTINGS_PATH): Settings {
  const text = readFileSync(path, "utf8");
  return parseSettingsYaml(text);
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path} ${issue.message}`;
    })
    .join("; ");
}
