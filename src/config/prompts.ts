import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Prompt files are the sole source of reply behavior. Reply slots are discovered
 * by globbing `prompts/replies/*.md` and ordering by the numeric filename prefix,
 * so adding/removing/reordering a reply variant is a file-only change — no code,
 * no migration, no admin UI.
 */

export interface ReplyPrompt {
  /** 1-based index parsed from the filename prefix (e.g. "01-foo.md" -> 1). */
  index: number;
  /** Display label, e.g. "Prompt 1". */
  label: string;
  /** Source filename, for diagnostics. */
  file: string;
  /** Title line (first markdown heading) if present, else the label. */
  title: string;
  /** The full instruction body (heading stripped). */
  text: string;
}

export interface PromptSet {
  system: string;
  constraints: string;
  replies: ReplyPrompt[];
}

const REPLY_FILE_RE = /^(\d+)[-_].*\.md$/i;

function readTrimmed(path: string): string {
  return readFileSync(path, "utf8").trim();
}

/** Strip a leading "# heading" line and return { title, body }. */
function splitHeading(raw: string, fallbackTitle: string): { title: string; body: string } {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.startsWith("#")) {
    const title = lines[0].replace(/^#+\s*/, "").trim();
    return { title: title || fallbackTitle, body: lines.slice(1).join("\n").trim() };
  }
  return { title: fallbackTitle, body: raw };
}

export function loadPrompts(promptsDir: string): PromptSet {
  const system = readTrimmed(join(promptsDir, "system.md"));
  const constraints = readTrimmed(join(promptsDir, "constraints.md"));

  const repliesDir = join(promptsDir, "replies");
  const files = readdirSync(repliesDir)
    .filter((f) => REPLY_FILE_RE.test(f))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  if (files.length === 0) {
    throw new Error(`No reply prompt files found in ${repliesDir} (expected NN-name.md)`);
  }

  const replies: ReplyPrompt[] = files.map((file) => {
    const match = file.match(REPLY_FILE_RE);
    const index = Number(match![1]);
    const label = `Prompt ${index}`;
    const raw = readTrimmed(join(repliesDir, file));
    const { title, body } = splitHeading(raw, label);
    return { index, label, file, title, text: body };
  });

  const seen = new Set<number>();
  for (const r of replies) {
    if (seen.has(r.index)) {
      throw new Error(`Duplicate reply prompt index ${r.index} (file ${r.file})`);
    }
    seen.add(r.index);
  }

  return { system, constraints, replies };
}
