import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PROMPTS_DIR,
  DEFAULT_REPLIES_DIR,
  listReplyPromptFiles,
  loadConstraintsPrompt,
  loadPromptBundle,
  loadReplyPrompts,
  loadSystemPrompt,
} from "@/config/load-prompts";

const REPO_ROOT = process.cwd();

describe("load-prompts (repo files)", () => {
  it("loads the system prompt", () => {
    const system = loadSystemPrompt(resolve(REPO_ROOT, "prompts/system.md"));
    expect(system).toMatch(/Soofi Safavi/);
  });

  it("loads the constraints prompt", () => {
    const constraints = loadConstraintsPrompt(resolve(REPO_ROOT, "prompts/constraints.md"));
    expect(constraints).toMatch(/280 characters/i);
  });

  it("loads reply prompts in filename order", () => {
    const slots = loadReplyPrompts(DEFAULT_REPLIES_DIR);
    const names = slots.map((s) => s.fileName);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "en")));
    expect(names[0]).toBe("01-recommend-and-draft.md");
    // Indexes are 1-based and contiguous.
    expect(slots.map((s) => s.index)).toEqual(slots.map((_, i) => i + 1));
  });

  it("loads exactly 6 reply slots and is NOT capped at 4", () => {
    const slots = loadReplyPrompts(DEFAULT_REPLIES_DIR);
    expect(slots).toHaveLength(6);
    // Explicitly assert the legacy DRAFT_RESPONSE_PROMPT_SLOTS = 4 cap is gone.
    expect(slots.length).toBeGreaterThan(4);
  });

  it("honors a per-file endsWithQuestion:false override", () => {
    const slots = loadReplyPrompts(DEFAULT_REPLIES_DIR);
    const thesis = slots.find((s) => s.fileName === "05-thesis-statement.md");
    expect(thesis).toBeDefined();
    expect(thesis!.endsWithQuestion).toBe(false);
    // Every other slot defaults to true.
    for (const slot of slots) {
      if (slot.fileName !== "05-thesis-statement.md") {
        expect(slot.endsWithQuestion).toBe(true);
      }
    }
  });

  it("uses frontmatter labels when present", () => {
    const slots = loadReplyPrompts(DEFAULT_REPLIES_DIR);
    expect(slots[0]!.label).toBe("Recommend and draft");
  });

  it("loadPromptBundle returns system + constraints + ordered replies", () => {
    const bundle = loadPromptBundle(DEFAULT_PROMPTS_DIR);
    expect(bundle.system).toMatch(/Soofi/);
    expect(bundle.constraints).toMatch(/character/i);
    expect(bundle.replies).toHaveLength(6);
  });
});

describe("load-prompts (temp fixtures: add / remove / reorder)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "x-agent-prompts-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, body: string): void {
    writeFileSync(join(dir, name), body, "utf8");
  }

  it("derives a label from the filename when no frontmatter label", () => {
    write("01-foo-bar.md", "Body one.");
    const slots = loadReplyPrompts(dir);
    expect(slots[0]!.label).toBe("Foo bar");
    expect(slots[0]!.text).toBe("Body one.");
  });

  it("reflects ADD: a newly written file appears as a new slot", () => {
    write("01-a.md", "A body.");
    write("02-b.md", "B body.");
    expect(loadReplyPrompts(dir)).toHaveLength(2);

    write("03-c.md", "C body.");
    const after = loadReplyPrompts(dir);
    expect(after).toHaveLength(3);
    expect(after.map((s) => s.fileName)).toEqual(["01-a.md", "02-b.md", "03-c.md"]);
  });

  it("reflects REMOVE: deleting a file drops its slot", () => {
    write("01-a.md", "A body.");
    write("02-b.md", "B body.");
    write("03-c.md", "C body.");
    expect(loadReplyPrompts(dir)).toHaveLength(3);

    rmSync(join(dir, "02-b.md"));
    const after = loadReplyPrompts(dir);
    expect(after.map((s) => s.fileName)).toEqual(["01-a.md", "03-c.md"]);
    expect(after.map((s) => s.index)).toEqual([1, 2]);
  });

  it("reflects REORDER: filename prefixes drive slot order", () => {
    write("10-zzz.md", "Z body.");
    write("20-aaa.md", "A body.");
    let slots = loadReplyPrompts(dir);
    expect(slots.map((s) => s.fileName)).toEqual(["10-zzz.md", "20-aaa.md"]);

    // Rename by rewriting under swapped prefixes.
    rmSync(join(dir, "10-zzz.md"));
    rmSync(join(dir, "20-aaa.md"));
    write("10-aaa.md", "A body.");
    write("20-zzz.md", "Z body.");
    slots = loadReplyPrompts(dir);
    expect(slots.map((s) => s.fileName)).toEqual(["10-aaa.md", "20-zzz.md"]);
    expect(slots.map((s) => s.text)).toEqual(["A body.", "Z body."]);
  });

  it("supports far more than 4 slots (no cap)", () => {
    for (let i = 1; i <= 9; i++) {
      write(`0${i}-slot.md`, `Slot ${i}.`);
    }
    const slots = loadReplyPrompts(dir);
    expect(slots).toHaveLength(9);
  });

  it("ignores non-markdown files", () => {
    write("01-a.md", "A body.");
    write("notes.txt", "not a prompt");
    mkdirSync(join(dir, "subdir"));
    expect(listReplyPromptFiles(dir)).toEqual(["01-a.md"]);
  });

  it("throws on an empty prompt body", () => {
    write("01-empty.md", "---\nlabel: Empty\n---\n");
    expect(() => loadReplyPrompts(dir)).toThrowError(/no body content/i);
  });

  it("throws on invalid frontmatter type", () => {
    write("01-bad.md", "---\nendsWithQuestion: notabool\n---\nBody.");
    expect(() => loadReplyPrompts(dir)).toThrowError(/Invalid frontmatter/i);
  });
});
