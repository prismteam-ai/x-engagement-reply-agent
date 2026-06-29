import { describe, expect, it } from "vitest";
import {
  DEFAULT_WATCHLIST_PATH,
  filterActiveAuthors,
  loadActiveWatchlist,
  loadWatchlist,
  parseWatchlist,
  parseWatchlistYaml,
} from "@/config/load-watchlist";

describe("load-watchlist", () => {
  it("loads and validates the repo config/watchlist.yaml", () => {
    const authors = loadWatchlist(DEFAULT_WATCHLIST_PATH);
    expect(authors.length).toBeGreaterThanOrEqual(3);
    const handles = authors.map((a) => a.handle);
    expect(handles).toContain("ssafavi");
    const soofi = authors.find((a) => a.handle === "ssafavi");
    expect(soofi?.author).toBe("Soofi Safavi");
    expect(soofi?.company).toBe("elephant-xyz");
  });

  it("parses author shape including aliases", () => {
    const authors = parseWatchlist({
      authors: [
        {
          author: "Jane Doe",
          handle: "janedoe",
          company: "acme",
          aliases: { handles: ["jdoe"], authors: ["J. Doe"] },
          active: true,
        },
      ],
    });
    expect(authors).toHaveLength(1);
    expect(authors[0]!.aliases.handles).toEqual(["jdoe"]);
    expect(authors[0]!.aliases.authors).toEqual(["J. Doe"]);
  });

  it("defaults active to true and aliases to empty when omitted", () => {
    const authors = parseWatchlist({
      authors: [{ author: "Jane Doe", handle: "janedoe" }],
    });
    expect(authors[0]!.active).toBe(true);
    expect(authors[0]!.aliases).toEqual({ handles: [], authors: [] });
    expect(authors[0]!.company).toBeUndefined();
  });

  it("strips a leading @ from the handle", () => {
    const authors = parseWatchlist({
      authors: [{ author: "Jane Doe", handle: "@janedoe" }],
    });
    expect(authors[0]!.handle).toBe("janedoe");
  });

  it("filterActiveAuthors drops inactive entries", () => {
    const authors = parseWatchlist({
      authors: [
        { author: "Active One", handle: "active1", active: true },
        { author: "Inactive One", handle: "inactive1", active: false },
        { author: "Default Active", handle: "default1" },
      ],
    });
    const active = filterActiveAuthors(authors);
    expect(active.map((a) => a.handle)).toEqual(["active1", "default1"]);
  });

  it("loadActiveWatchlist excludes inactive authors from the repo file", () => {
    const all = loadWatchlist(DEFAULT_WATCHLIST_PATH);
    const active = loadActiveWatchlist(DEFAULT_WATCHLIST_PATH);
    expect(active.length).toBeLessThan(all.length);
    expect(active.every((a) => a.active)).toBe(true);
    // The repo file includes an inactive "exampleauthor" entry.
    expect(active.map((a) => a.handle)).not.toContain("exampleauthor");
  });

  it("requires author and handle", () => {
    expect(() => parseWatchlist({ authors: [{ author: "", handle: "x" }] })).toThrowError(
      /author is required/i,
    );
    expect(() => parseWatchlist({ authors: [{ author: "X", handle: "" }] })).toThrowError(
      /handle is required/i,
    );
  });

  it("requires a non-empty authors list", () => {
    expect(() => parseWatchlist({ authors: [] })).toThrowError(/at least one author/i);
  });

  it("rejects a missing authors key", () => {
    expect(() => parseWatchlist({})).toThrowError(/Invalid watchlist/i);
  });

  it("surfaces YAML syntax errors", () => {
    expect(() => parseWatchlistYaml("authors: [oops")).toThrowError(/parse watchlist YAML/i);
  });
});
