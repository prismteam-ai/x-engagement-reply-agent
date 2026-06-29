import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const DEFAULT_WATCHLIST_PATH = resolve(process.cwd(), "config/watchlist.yaml");

export const AliasesSchema = z
  .object({
    handles: z.array(z.string().trim().min(1)).default([]),
    authors: z.array(z.string().trim().min(1)).default([]),
  })
  .strict()
  .default({ handles: [], authors: [] });

export const WatchAuthorSchema = z
  .object({
    author: z.string().trim().min(1, { message: "author is required" }),
    handle: z
      .string()
      .trim()
      .min(1, { message: "handle is required" })
      .transform((h) => h.replace(/^@/, "")),
    company: z.string().trim().min(1).optional(),
    aliases: AliasesSchema,
    active: z.boolean().default(true),
  })
  .strict();

export type Aliases = z.infer<typeof AliasesSchema>;
export type WatchAuthor = z.infer<typeof WatchAuthorSchema>;

export const WatchlistSchema = z
  .object({
    authors: z
      .array(WatchAuthorSchema)
      .min(1, { message: "watchlist must contain at least one author" }),
  })
  .strict();

export type Watchlist = z.infer<typeof WatchlistSchema>;

export function parseWatchlist(raw: unknown): WatchAuthor[] {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("watchlist.yaml must contain a top-level mapping with an `authors` list");
  }
  const result = WatchlistSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid watchlist: ${formatZodError(result.error)}`);
  }
  return result.data.authors;
}

export function parseWatchlistYaml(yamlText: string): WatchAuthor[] {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    throw new Error(
      `Failed to parse watchlist YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseWatchlist(raw);
}

export function loadWatchlist(path: string = DEFAULT_WATCHLIST_PATH): WatchAuthor[] {
  const text = readFileSync(path, "utf8");
  return parseWatchlistYaml(text);
}

export function filterActiveAuthors(authors: WatchAuthor[]): WatchAuthor[] {
  return authors.filter((author) => author.active);
}

export function loadActiveWatchlist(path: string = DEFAULT_WATCHLIST_PATH): WatchAuthor[] {
  return filterActiveAuthors(loadWatchlist(path));
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path} ${issue.message}`;
    })
    .join("; ");
}
