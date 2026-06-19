import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config/index.js";
import { settingsSchema } from "../src/config/schema.js";

describe("loadConfig (repo config)", () => {
  const config = loadConfig();
  it("loads watchlist authors", () => {
    expect(config.watchlist.authors.length).toBeGreaterThanOrEqual(3);
    expect(config.watchlist.authors.some((a) => a.excludeFromTasking)).toBe(true);
  });
  it("discovers reply prompts ordered by numeric prefix", () => {
    const indices = config.prompts.replies.map((r) => r.index);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    expect(config.prompts.replies.length).toBeGreaterThanOrEqual(5);
  });
  it("loads system + constraints prompts", () => {
    expect(config.prompts.system.length).toBeGreaterThan(0);
    expect(config.prompts.constraints).toContain("280");
  });
});

describe("settingsSchema", () => {
  it("applies defaults", () => {
    const s = settingsSchema.parse({});
    expect(s.defaultTopK).toBe(6);
    expect(s.modelId).toBe("openai/gpt-4.1-mini");
  });
  it("rejects topK > 20 (server cap)", () => {
    expect(() => settingsSchema.parse({ defaultTopK: 40 })).toThrow();
  });
  it("rejects out-of-range thresholds", () => {
    expect(() => settingsSchema.parse({ articleSimilarityThreshold: 2 })).toThrow();
  });
});
