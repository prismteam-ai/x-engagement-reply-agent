import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS_PATH,
  SETTINGS_DEFAULTS,
  loadSettings,
  parseSettings,
  parseSettingsYaml,
} from "@/config/load-settings";

describe("load-settings", () => {
  it("loads and validates the repo config/settings.yaml", () => {
    const settings = loadSettings(DEFAULT_SETTINGS_PATH);
    expect(settings.pollIntervalMinutes).toBe(2);
    expect(settings.defaultBatchSize).toBe(5);
    expect(settings.articleSimilarityThreshold).toBeCloseTo(0.68);
    expect(settings.bedrockModelId).toMatch(/anthropic/);
    expect(settings.excludeAuthors).toContain("ssafavi");
    expect(settings.paused).toBe(false);
    expect(settings.dryRun).toBe(false);
  });

  it("accepts a fully-specified valid settings object", () => {
    const settings = parseSettings({
      pollIntervalMinutes: 10,
      defaultBatchSize: 8,
      defaultMaxPostsPerAuthor: 50,
      defaultTopK: 40,
      asanaTaskSimilarityThreshold: 0.55,
      articleSimilarityThreshold: 0.8,
      bedrockModelId: "anthropic.claude-3-haiku-20240307-v1:0",
      excludeAuthors: ["ssafavi", "someoneelse"],
      paused: true,
      dryRun: true,
    });
    expect(settings.pollIntervalMinutes).toBe(10);
    expect(settings.defaultTopK).toBe(40);
    expect(settings.paused).toBe(true);
    expect(settings.excludeAuthors).toEqual(["ssafavi", "someoneelse"]);
  });

  it("applies documented defaults for an empty mapping", () => {
    const settings = parseSettings({});
    expect(settings.pollIntervalMinutes).toBe(SETTINGS_DEFAULTS.pollIntervalMinutes);
    expect(settings.defaultBatchSize).toBe(SETTINGS_DEFAULTS.defaultBatchSize);
    expect(settings.defaultMaxPostsPerAuthor).toBe(SETTINGS_DEFAULTS.defaultMaxPostsPerAuthor);
    expect(settings.defaultTopK).toBe(SETTINGS_DEFAULTS.defaultTopK);
    expect(settings.asanaTaskSimilarityThreshold).toBe(
      SETTINGS_DEFAULTS.asanaTaskSimilarityThreshold,
    );
    expect(settings.articleSimilarityThreshold).toBe(
      SETTINGS_DEFAULTS.articleSimilarityThreshold,
    );
    expect(settings.bedrockModelId).toBe(SETTINGS_DEFAULTS.bedrockModelId);
    expect(settings.excludeAuthors).toEqual([]);
    expect(settings.paused).toBe(false);
    expect(settings.dryRun).toBe(false);
  });

  it("treats an empty YAML document as all-defaults", () => {
    const settings = parseSettingsYaml("");
    expect(settings.defaultTopK).toBe(SETTINGS_DEFAULTS.defaultTopK);
  });

  it("merges partial input with defaults", () => {
    const settings = parseSettings({ articleSimilarityThreshold: 0.5 });
    expect(settings.articleSimilarityThreshold).toBe(0.5);
    expect(settings.pollIntervalMinutes).toBe(SETTINGS_DEFAULTS.pollIntervalMinutes);
  });

  it("rejects an out-of-range similarity threshold with a clear error", () => {
    expect(() => parseSettings({ articleSimilarityThreshold: 1.5 })).toThrowError(
      /articleSimilarityThreshold.*<= 1/i,
    );
  });

  it("rejects a non-integer poll interval", () => {
    expect(() => parseSettings({ pollIntervalMinutes: 2.5 })).toThrowError(
      /pollIntervalMinutes.*integer/i,
    );
  });

  it("rejects a poll interval below the minimum", () => {
    expect(() => parseSettings({ pollIntervalMinutes: 0 })).toThrowError(
      /pollIntervalMinutes.*>= 1/i,
    );
  });

  it("rejects unknown keys (strict schema)", () => {
    expect(() => parseSettings({ bogusKey: true })).toThrowError(/Invalid settings/i);
  });

  it("rejects a wrong-typed value", () => {
    expect(() => parseSettings({ defaultBatchSize: "five" })).toThrowError(
      /defaultBatchSize/i,
    );
  });

  it("rejects a non-object top-level document", () => {
    expect(() => parseSettings([1, 2, 3])).toThrowError(/mapping/i);
  });

  it("surfaces YAML syntax errors", () => {
    expect(() => parseSettingsYaml("foo: [unclosed")).toThrowError(/parse settings YAML/i);
  });
});
