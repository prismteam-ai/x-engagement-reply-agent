import { readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import matter from "gray-matter";
import { z } from "zod";

export const DEFAULT_PROMPTS_DIR = resolve(process.cwd(), "prompts");
export const DEFAULT_REPLIES_DIR = resolve(DEFAULT_PROMPTS_DIR, "replies");
export const DEFAULT_SYSTEM_PROMPT_PATH = resolve(DEFAULT_PROMPTS_DIR, "system.md");
export const DEFAULT_CONSTRAINTS_PROMPT_PATH = resolve(DEFAULT_PROMPTS_DIR, "constraints.md");

export const ReplyPromptFrontmatterSchema = z
  .object({
    label: z.string().trim().min(1).optional(),
    endsWithQuestion: z.boolean().optional(),
  })
  .passthrough();

export type ReplyPromptFrontmatter = z.infer<typeof ReplyPromptFrontmatterSchema>;

export type ReplyPromptSlot = {
  index: number;
  fileName: string;
  label: string;
  text: string;
  endsWithQuestion: boolean;
  frontmatter: ReplyPromptFrontmatter;
};

export type PromptBundle = {
  system: string;
  constraints: string;
  replies: ReplyPromptSlot[];
};

export function listReplyPromptFiles(dir: string = DEFAULT_REPLIES_DIR): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    throw new Error(
      `Failed to read reply prompts dir "${dir}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return entries
    .filter((name) => name.toLowerCase().endsWith(".md"))
    .sort((a, b) => a.localeCompare(b, "en"));
}

export function loadReplyPrompts(dir: string = DEFAULT_REPLIES_DIR): ReplyPromptSlot[] {
  const files = listReplyPromptFiles(dir);
  return files.map((fileName, i) => parseReplyPromptFile(resolve(dir, fileName), fileName, i + 1));
}

function parseReplyPromptFile(
  filePath: string,
  fileName: string,
  index: number,
): ReplyPromptSlot {
  const raw = readFileSync(filePath, "utf8");
  const parsed = matter(raw);

  const fmResult = ReplyPromptFrontmatterSchema.safeParse(parsed.data ?? {});
  if (!fmResult.success) {
    throw new Error(
      `Invalid frontmatter in "${fileName}": ${fmResult.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`)
        .join("; ")}`,
    );
  }
  const frontmatter = fmResult.data;

  const text = parsed.content.trim();
  if (!text) {
    throw new Error(`Reply prompt "${fileName}" has no body content`);
  }

  return {
    index,
    fileName,
    label: frontmatter.label ?? deriveLabelFromFileName(fileName),
    text,
    endsWithQuestion: frontmatter.endsWithQuestion ?? true,
    frontmatter,
  };
}

export function loadSystemPrompt(path: string = DEFAULT_SYSTEM_PROMPT_PATH): string {
  return readRequiredPrompt(path, "system prompt");
}

export function loadConstraintsPrompt(path: string = DEFAULT_CONSTRAINTS_PROMPT_PATH): string {
  return readRequiredPrompt(path, "constraints prompt");
}

export function loadPromptBundle(promptsDir: string = DEFAULT_PROMPTS_DIR): PromptBundle {
  return {
    system: loadSystemPrompt(resolve(promptsDir, "system.md")),
    constraints: loadConstraintsPrompt(resolve(promptsDir, "constraints.md")),
    replies: loadReplyPrompts(resolve(promptsDir, "replies")),
  };
}

function readRequiredPrompt(path: string, kind: string): string {
  const text = readFileSync(path, "utf8").trim();
  if (!text) {
    throw new Error(`${kind} at "${path}" is empty`);
  }
  return text;
}

function deriveLabelFromFileName(fileName: string): string {
  const stem = basename(fileName, ".md")
    .replace(/^\d+[-_]?/, "")
    .replace(/[-_]+/g, " ")
    .trim();
  if (!stem) return basename(fileName, ".md");
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}
