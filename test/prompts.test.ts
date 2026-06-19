import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPrompts } from "../src/config/prompts.js";
import { parseMaxChars } from "../src/llm/reply-generator.js";

let dir: string;

function write(rel: string, content: string) {
  const full = join(dir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "prompts-"));
  write("system.md", "System voice.");
  write("constraints.md", "- Maximum of 240 characters.");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadPrompts", () => {
  it("orders reply files by numeric prefix and strips headings", () => {
    write("replies/02-second.md", "# Prompt 2 — Second\nDo the second thing.");
    write("replies/01-first.md", "# Prompt 1 — First\nDo the first thing.");
    write("replies/10-tenth.md", "# Prompt 10\nDo the tenth thing.");

    const set = loadPrompts(dir);
    expect(set.replies.map((r) => r.index)).toEqual([1, 2, 10]);
    expect(set.replies[0]!.label).toBe("Prompt 1");
    expect(set.replies[0]!.title).toBe("Prompt 1 — First");
    expect(set.replies[0]!.text).toBe("Do the first thing.");
    expect(set.system).toBe("System voice.");
  });

  it("ignores non-matching files in replies/", () => {
    write("replies/01-ok.md", "# Prompt 1\nok");
    write("replies/README.md", "not a slot");
    const set = loadPrompts(dir);
    expect(set.replies).toHaveLength(1);
  });

  it("throws when no reply files exist", () => {
    mkdirSync(join(dir, "replies"), { recursive: true });
    expect(() => loadPrompts(dir)).toThrow(/No reply prompt files/);
  });

  it("throws on duplicate reply indices", () => {
    write("replies/01-a.md", "# A\na");
    write("replies/01-b.md", "# B\nb");
    expect(() => loadPrompts(dir)).toThrow(/Duplicate reply prompt index/);
  });
});

describe("parseMaxChars", () => {
  it("reads the limit from constraints text", () => {
    expect(parseMaxChars("- Maximum of 240 characters.")).toBe(240);
  });
  it("defaults to 280 when absent", () => {
    expect(parseMaxChars("no limit here")).toBe(280);
  });
});
